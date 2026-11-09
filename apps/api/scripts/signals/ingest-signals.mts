/**
 * P1-18：社媒信号采集 CLI —— changedetection watches + RSSHub 路由 → company_signal。
 *
 * 与 src/signals/company-signals.ts 共用解析/指纹/归因/落库层（不要在此复制第二套口径）。
 * 一次执行：拉取（只读）→ 解析 RSS2/Atom/watches → 指纹去重 → 域名归因 → createMany 入库。
 * 整个流程在 set_config('app.current_workspace_id') 事务里（company_signal 与
 * canonical_company 都是 FORCE RLS；写入侧还显式带 workspaceId 兜底超管连接）。
 *
 * 环境：RSSHUB_URL（默认 http://127.0.0.1:1200）、CHANGE_DETECTION_URL
 * （默认 http://127.0.0.1:5055）、CHANGE_DETECTION_API_KEY（--include-watch-changes 时必填，
 * 请求头 x-api-key，绝不打印）、SIGNAL_RSS_ROUTES（--rss 未给时的默认路由，逗号分隔）。
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
import { PrismaClient } from '@prisma/client';
import {
  ingestCompanySignals,
  type CompanySignalIngestSummary,
  type CompanySignalStore,
} from '../../src/signals/company-signals';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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

function printSummary(summary: CompanySignalIngestSummary): void {
  for (const source of summary.sources) {
    const error = source.error ? ` 错误：${source.error}` : '';
    console.log(
      `[${source.source}] 解析 ${source.parsed}（丢弃 ${source.dropped}）→ 插入 ${source.inserted}、跳过 ${source.skipped}、归因 ${source.matched}${error}`,
    );
  }
  console.log(`合计：插入 ${summary.inserted}、跳过 ${summary.skipped}、归因 ${summary.matched}`);
}

async function main(): Promise<void> {
  const args = parseIngestSignalsArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const summary = await prisma.$transaction(
      async (tx) => {
        // RLS：事务内按租户过滤（company_signal 与 canonical_company 都是 FORCE RLS）。
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${args.workspace}, true)`;
        return ingestCompanySignals({
          store: tx as unknown as CompanySignalStore,
          workspaceId: args.workspace,
          rssRoutes: args.rssRoutes,
          includeWatchChanges: args.includeWatchChanges,
          rsshubUrl: process.env.RSSHUB_URL,
          changeDetectionUrl: process.env.CHANGE_DETECTION_URL,
          changeDetectionApiKey: process.env.CHANGE_DETECTION_API_KEY,
        });
      },
      { timeout: 180_000, maxWait: 10_000 },
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
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
