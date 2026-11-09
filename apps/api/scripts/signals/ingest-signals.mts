/**
 * P1-18：社媒信号采集 CLI —— changedetection watches + RSSHub 路由 → company_signal。
 *
 * 运营脚本（出网只在这里发生）：拉取 RSS2/Atom 与 changedetection 列表（经仓库共享
 * net-guard：只许 global unicast、每跳重验重定向、5 MB 响应上限、20s 超时；本机
 * RSSHUB_URL/CHANGE_DETECTION_URL 两个回环服务按原样放行），解析与指纹/归因/落库
 * 复用 src/signals/company-signals.ts。
 *
 * 数据面：网络在事务外完成后，逐源用 PrismaService.withWorkspace 开短事务
 * （app_user + set_config('app.current_workspace_id')，RLS 真实生效；单源失败只回滚该源）。
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
import { resolvePublicIp, type HostResolver } from '../../src/adapters/net-guard';
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
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** 与 Node 全局 fetch 兼容的最小签名（测试注入 fake，不触网）。 */
export interface SignalResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type SignalFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' },
) => Promise<SignalResponse>;

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

// ── 出网护栏（net-guard + 重定向逐跳重验 + 字节上限） ───────────────────────

export interface CollectDeps {
  fetchImpl?: SignalFetch;
  /** 测试注入：系统 DNS（默认 net-guard 的 lookup）。 */
  resolveHost?: HostResolver;
  /** 测试注入：fake-IP 场景的 DoH 复查（默认 net-guard 的 DoH）。 */
  dohLookup?: HostResolver;
  timeoutMs?: number;
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

function displayUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 每个请求（含每一跳重定向）都过一遍：http(s)、无内嵌凭据；本机服务白名单里的
 * origin 只许回环地址；其余目标经 net-guard 解析，答案必须全部 global unicast。
 */
async function assertAllowedTarget(
  target: URL,
  allowedLoopbackOrigins: ReadonlySet<string>,
  deps: CollectDeps,
): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`不支持的协议：${target.protocol}`);
  }
  if (target.username || target.password) {
    throw new Error('目标 URL 不允许携带凭据');
  }
  const host = target.hostname.replace(/\.$/u, '').toLowerCase();
  if (allowedLoopbackOrigins.has(target.origin)) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error('本机服务白名单只允许回环地址');
    }
    return;
  }
  if (LOOPBACK_HOSTS.has(host)) {
    throw new Error('目标指向回环/本机地址，已拒绝');
  }
  const resolution = await resolvePublicIp(host, {
    systemLookup: deps.resolveHost,
    dohLookup: deps.dohLookup,
  });
  if (!resolution.safe) {
    throw new Error(`net-guard 拒绝出网目标（${resolution.reason ?? 'unsafe'}）：${displayUrl(target)}`);
  }
}

async function guardedFetchText(
  target: string,
  headers: Record<string, string>,
  options: { allowedLoopbackOrigins: ReadonlySet<string>; deps: CollectDeps },
): Promise<string> {
  const fetchImpl = options.deps.fetchImpl ?? (globalThis.fetch as unknown as SignalFetch);
  const timeoutMs = options.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertAllowedTarget(current, options.allowedLoopbackOrigins, options.deps);
    const response = await fetchImpl(current.toString(), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get('location');
      if (!location) throw new Error(`重定向缺少 Location（HTTP ${response.status}）`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${displayUrl(current)}`);
    }
    const declared = Number(response.headers?.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`响应过大（>${MAX_RESPONSE_BYTES} 字节）：${displayUrl(current)}`);
    }
    const text = await response.text();
    return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次：${displayUrl(new URL(target))}`);
}

// ── 采集（网络；事务外） ────────────────────────────────────────────────────

export async function collectCompanySignals(
  options: CollectOptions,
): Promise<CollectedSignalSource[]> {
  const deps = options.deps ?? {};
  const rsshubUrl = options.rsshubUrl.replace(/\/+$/u, '');
  const allowedLoopbackOrigins = new Set<string>();
  for (const origin of [originOf(options.rsshubUrl), originOf(options.changeDetectionUrl)]) {
    if (origin) allowedLoopbackOrigins.add(origin);
  }
  const sources: CollectedSignalSource[] = [];

  for (const route of options.rssRoutes) {
    const source: CollectedSignalSource = { source: `rss:${route}`, items: [], dropped: 0, error: null };
    try {
      const text = await guardedFetchText(
        resolveRssUrl(route, rsshubUrl),
        { accept: 'application/rss+xml, application/atom+xml, application/xml' },
        { allowedLoopbackOrigins, deps },
      );
      const feed = parseRssFeed(text);
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
      const text = await guardedFetchText(
        `${options.changeDetectionUrl.replace(/\/+$/u, '')}/api/v1/watch`,
        { 'x-api-key': options.changeDetectionApiKey },
        { allowedLoopbackOrigins, deps },
      );
      let payload: unknown;
      try {
        payload = JSON.parse(text);
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
    // 网络拉取在事务外完成（tenant.ts：事务回调里只放 DB 操作）。
    const collected = await collectCompanySignals({
      rssRoutes: args.rssRoutes,
      includeWatchChanges: args.includeWatchChanges,
      rsshubUrl: process.env.RSSHUB_URL ?? 'http://127.0.0.1:1200',
      changeDetectionUrl: process.env.CHANGE_DETECTION_URL ?? 'http://127.0.0.1:5055',
      changeDetectionApiKey: process.env.CHANGE_DETECTION_API_KEY,
    });

    // 逐源短事务：单源失败只回滚该源。
    const attributionCache = new Map<string, string | null>();
    const reports: SignalSourceReport[] = [];
    for (const source of collected) {
      try {
        reports.push(
          await prisma.withWorkspace(
            args.workspace,
            (tx) =>
              persistCollectedSource(
                tx as unknown as CompanySignalStore,
                args.workspace,
                source,
                attributionCache,
              ),
            { timeout: 120_000, maxWait: 10_000 },
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

    const summary = summarizeSignalReports(reports);
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
