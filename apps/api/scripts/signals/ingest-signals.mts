/**
 * P1-18：社媒信号采集 CLI —— changedetection watches + RSSHub 路由 → company_signal。
 *
 * 运营脚本（出网只在这里）：RSS2/Atom 与 changedetection 列表的拉取复用仓库治理出口
 * `requestPublicHttp`（net-guard：只许 global-unicast、每跳重定向重新解析并固定连接 IP
 * 防 DNS rebinding、流式字节上限、墙钟超时、跨域剥离凭据）；本机 RSSHUB_URL /
 * CHANGE_DETECTION_URL 两个回环服务经自定义 resolver 按配置 origin 放行。
 * changedetection 请求**禁跟随重定向**（maxRedirects=0），避免 x-api-key 被带往他处。
 *
 * 解析与指纹/归因/落库复用 src/signals/company-signals.ts。网络在事务外完成后，逐源用
 * PrismaService.withWorkspace 开短事务（app_user + set_config，RLS 真实生效；单源失败
 * 只回滚该源）。写入前先校验 workspace 存在（打错 UUID 不产生孤儿行）。
 *
 * 环境：RSSHUB_URL（默认 http://127.0.0.1:1200）、CHANGE_DETECTION_URL（默认
 * http://127.0.0.1:5055）、CHANGE_DETECTION_API_KEY（--include-watch-changes 时必填，
 * 请求头 x-api-key，绝不打印）、SIGNAL_RSS_ROUTES（--rss 未给时的默认路由，逗号分隔）、
 * APP_DATABASE_URL（app_user 连接；缺失时 fail-closed）。
 *
 * 运行：
 *   cd /global/backend/apps/api && node --import tsx scripts/signals/ingest-signals.mts \
 *     --workspace <workspace-uuid> --rss github/issue/DIYgod/RSSHub --include-watch-changes
 *   ... --rss https://example.com/feed.xml --json
 *
 * 退出码：0 全部成功；1 有源拉取/写入失败；2 参数错误或致命异常。
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  EgressBlockedError,
  requestPublicHttp,
  type PublicHttpRequestOptions,
  type PublicHttpResponse,
} from '../../src/adapters/guarded-http';
import {
  resolvePublicHttpUrl,
  type PinnedPublicUrl,
  type PublicUrlResolver,
} from '../../src/adapters/url-guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  parseChangedetectionWatches,
  parseRssFeed,
  persistCollectedSource,
  summarizeSignalReports,
  type CollectedSignalSource,
  type CompanySignalIngestSummary,
  type CompanySignalStore,
  type SignalSourceReport,
} from '../../src/signals/company-signals';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface IngestSignalsArgs {
  workspace: string;
  rssRoutes: string[];
  includeWatchChanges: boolean;
  json: boolean;
}

export function parseIngestSignalsArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): IngestSignalsArgs {
  const workspaceIndex = argv.indexOf('--workspace');
  const workspace = workspaceIndex >= 0 ? argv[workspaceIndex + 1] : undefined;
  if (!workspace || !UUID.test(workspace)) {
    throw new Error('--workspace <uuid> 必填（合法的 workspace uuid）');
  }

  const rssRoutes: string[] = [];
  argv.forEach((arg, index) => {
    if (arg !== '--rss') return;
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) rssRoutes.push(value);
  });
  if (rssRoutes.length === 0) {
    for (const route of (env.SIGNAL_RSS_ROUTES ?? '').split(',')) {
      const trimmed = route.trim();
      if (trimmed) rssRoutes.push(trimmed);
    }
  }

  const includeWatchChanges = argv.includes('--include-watch-changes');
  if (rssRoutes.length === 0 && !includeWatchChanges) {
    throw new Error(
      '没有可拉取的信号源：给 --rss <route|url>、设置 SIGNAL_RSS_ROUTES，或加 --include-watch-changes',
    );
  }
  return { workspace, rssRoutes, includeWatchChanges, json: argv.includes('--json') };
}

export function resolveRssUrl(routeOrUrl: string, rsshubUrl: string): string {
  const trimmed = routeOrUrl.trim();
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  return `${rsshubUrl.replace(/\/+$/u, '')}/${trimmed.replace(/^\/+/u, '')}`;
}

// ── 采集（网络；事务外） ────────────────────────────────────────────────────

export type SignalHttpRequest = (
  raw: string,
  options?: PublicHttpRequestOptions,
) => Promise<PublicHttpResponse>;

export interface CollectDeps {
  /** 测试注入：替换整个治理出口（默认 requestPublicHttp + 本机服务 resolver）。 */
  request?: SignalHttpRequest;
  /** 测试注入：非本机目标的解析器（默认 url-guard 的 resolvePublicHttpUrl）。 */
  publicResolver?: PublicUrlResolver;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CollectOptions {
  rssRoutes: readonly string[];
  includeWatchChanges: boolean;
  rsshubUrl: string;
  changeDetectionUrl?: string;
  changeDetectionApiKey?: string;
  deps?: CollectDeps;
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof EgressBlockedError) {
    return `net-guard 拒绝出网（${error.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 本机服务 resolver：配置的 source origin 只许回环地址，固定 127.0.0.1/::1 直连。 */
export function serviceResolver(allowedOrigins: ReadonlySet<string>): PublicUrlResolver {
  return async (raw, options) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressBlockedError('invalid_url');
    }
    if (!allowedOrigins.has(url.origin)) return resolvePublicHttpUrl(raw, options);
    if (url.username || url.password) throw new EgressBlockedError('url_credentials_forbidden');
    const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new EgressBlockedError('service_origin_not_loopback');
    }
    const ip = host === 'localhost' ? '127.0.0.1' : host;
    const family = ip.includes(':') ? 6 : 4;
    const pinned: PinnedPublicUrl = { url, ip, family, addresses: [{ address: ip, family }] };
    return pinned;
  };
}

export async function collectCompanySignals(
  options: CollectOptions,
): Promise<CollectedSignalSource[]> {
  const deps = options.deps ?? {};
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowedOrigins = new Set<string>();
  for (const origin of [originOf(options.rsshubUrl), originOf(options.changeDetectionUrl)]) {
    if (origin) allowedOrigins.add(origin);
  }
  const request: SignalHttpRequest =
    deps.request ??
    ((raw, requestOptions) =>
      requestPublicHttp(raw, requestOptions, {
        resolver: serviceResolver(allowedOrigins),
      }));
  const sources: CollectedSignalSource[] = [];

  for (const route of options.rssRoutes) {
    const source: CollectedSignalSource = { source: `rss:${route}`, items: [], dropped: 0, error: null };
    try {
      const response = await request(resolveRssUrl(route, options.rsshubUrl), {
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml' },
        timeoutMs,
        maxBytes,
        maxRedirects: 3,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.finalUrl}`);
      const feed = parseRssFeed(response.text);
      source.items = feed.items;
      source.dropped = feed.dropped;
      if (!feed.recognized) source.error = '响应不是 RSS/Atom 文档';
    } catch (error) {
      source.error = errorMessage(error);
    }
    sources.push(source);
  }

  if (options.includeWatchChanges) {
    const source: CollectedSignalSource = { source: 'changedetection', items: [], dropped: 0, error: null };
    try {
      if (!options.changeDetectionApiKey) {
        throw new Error('CHANGE_DETECTION_API_KEY 未设置（changedetection 需要 x-api-key）');
      }
      if (!options.changeDetectionUrl) {
        throw new Error('CHANGE_DETECTION_URL 未设置');
      }
      const response = await request(
        `${options.changeDetectionUrl.replace(/\/+$/u, '')}/api/v1/watch`,
        {
          headers: { 'x-api-key': options.changeDetectionApiKey },
          timeoutMs,
          maxBytes,
          // 禁跟随重定向：x-api-key 绝不跨跳（requestPublicHttp 只剥离 authorization/cookie）。
          maxRedirects: 0,
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.finalUrl}`);
      let payload: unknown;
      try {
        payload = JSON.parse(response.text);
      } catch {
        throw new Error('changedetection 返回的不是 JSON');
      }
      const feed = parseChangedetectionWatches(payload);
      source.items = feed.items;
      source.dropped = feed.dropped;
    } catch (error) {
      source.error = errorMessage(error);
    }
    sources.push(source);
  }

  return sources;
}

// ── 落库（事务由调用方提供；逐源隔离） ──────────────────────────────────────

export type ScopedStoreRunner = <T>(fn: (store: CompanySignalStore) => Promise<T>) => Promise<T>;

/**
 * 逐源串行落库：每个源在调用方给的 scoped 事务里独立执行，单源失败只记该源错误，
 * 不拖垮其它源；attributionCache 跨源共享（同一 host 只查一次公司）。
 */
export async function persistSources(
  runScoped: ScopedStoreRunner,
  workspaceId: string,
  collected: readonly CollectedSignalSource[],
): Promise<CompanySignalIngestSummary> {
  const attributionCache = new Map<string, string | null>();
  const reports: SignalSourceReport[] = [];
  for (const source of collected) {
    try {
      reports.push(
        await runScoped((store) =>
          persistCollectedSource(store, workspaceId, source, attributionCache),
        ),
      );
    } catch (error) {
      reports.push({
        source: source.source,
        parsed: source.items.length,
        dropped: source.dropped,
        inserted: 0,
        skipped: 0,
        matched: 0,
        error: `事务失败：${errorMessage(error)}`,
      });
    }
  }
  return summarizeSignalReports(reports);
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function printSummary(summary: CompanySignalIngestSummary): void {
  for (const source of summary.sources) {
    const error = source.error ? ` 错误：${source.error}` : '';
    console.log(
      `[${source.source}] 解析 ${source.parsed}（丢弃 ${source.dropped}）→ 插入 ${source.inserted}、跳过 ${source.skipped}、归因 ${source.matched}（含已存在行）${error}`,
    );
  }
  console.log(`合计：插入 ${summary.inserted}、跳过 ${summary.skipped}、归因 ${summary.matched}（含已存在行）`);
}

async function main(): Promise<void> {
  const args = parseIngestSignalsArgs(process.argv.slice(2));
  const prisma = new PrismaService(); // app_user（APP_DATABASE_URL）；缺省 fail-closed
  try {
    // 打错 workspace UUID 时不产生孤儿行（company_signal.workspace_id 无 FK）。
    await prisma.withWorkspace(args.workspace, async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id: args.workspace } });
      if (!workspace) throw new Error(`workspace ${args.workspace} 不存在`);
    });

    // 网络拉取在事务外完成（tenant.ts：事务回调里只放 DB 操作）。
    const collected = await collectCompanySignals({
      rssRoutes: args.rssRoutes,
      includeWatchChanges: args.includeWatchChanges,
      rsshubUrl: process.env.RSSHUB_URL ?? 'http://127.0.0.1:1200',
      changeDetectionUrl: process.env.CHANGE_DETECTION_URL ?? 'http://127.0.0.1:5055',
      changeDetectionApiKey: process.env.CHANGE_DETECTION_API_KEY,
    });

    const summary = await persistSources(
      (fn) =>
        prisma.withWorkspace(
          args.workspace,
          (tx) => fn(tx as unknown as CompanySignalStore),
          { timeout: 120_000, maxWait: 10_000 },
        ),
      args.workspace,
      collected,
    );

    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary);
    if (summary.sources.some((source) => source.error)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// 直接执行才跑（被 vitest import 时不自动触发）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 2;
  });
}
