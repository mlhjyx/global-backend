/**
 * P1-17：联系人工程周报 CLI —— 与 CONTACT_WEEKLY_REPORT Schedule 共用计算层
 * （src/enrichment/metrics/contact-metrics.ts；不要在此复制第二套取数口径）。
 *
 * 只读聚合（owner 连接，跨租户汇总）+ 可选写一行周报快照（contact_metrics_snapshot）；
 * 无供应商调用、无出网。告警三条（VALID 覆盖率连续下降 / 验证错误率 / 成本超限）随正文输出；
 * 有 FIRING 时退出码 10（运维脚本口径，与 measurement-alerts 一致）。
 *
 * 运行：
 *   cd /global/backend/apps/api && node --import tsx scripts/contact-weekly-report.mts
 *   ... --since 2026-11-02T00:00:00Z --until 2026-11-09T00:00:00Z --out ../../docs/evidence/weekly/2026-11-09-contact-weekly.md
 *   ... --workspace <uuid> | --json | --no-persist
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  computeContactMetrics,
  evaluateContactWeeklyAlerts,
  loadCoverageHistory,
  persistContactMetricsSnapshot,
  prismaQueryRunner,
  renderContactWeeklyReportMarkdown,
  type ContactAlertEvaluation,
  type ContactMetricsQueryRunner,
  type ContactMetricsSnapshot,
  type ContactMetricsSnapshotClient,
} from '../src/enrichment/metrics/contact-metrics';

export interface ContactWeeklyReportArgs {
  since?: string;
  until?: string;
  workspace?: string;
  out?: string;
  json: boolean;
  persist: boolean;
}

export function parseContactWeeklyReportArgs(argv: string[]): ContactWeeklyReportArgs {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const args: ContactWeeklyReportArgs = {
    json: argv.includes('--json'),
    persist: !argv.includes('--no-persist'),
  };
  const since = valueOf('--since');
  const until = valueOf('--until');
  const workspace = valueOf('--workspace');
  const out = valueOf('--out');
  if (since !== undefined) args.since = since;
  if (until !== undefined) args.until = until;
  if (workspace !== undefined) args.workspace = workspace;
  if (out !== undefined) args.out = out;
  return args;
}

export interface ContactWeeklyReportRun {
  metrics: ContactMetricsSnapshot;
  alerts: ContactAlertEvaluation[];
  report: string;
  persisted: boolean;
}

/** 计算 + 告警 +（可选）快照写入；runner/client 注入便于单测。 */
export async function runContactWeeklyReport(
  deps: {
    runner: ContactMetricsQueryRunner;
    snapshots: ContactMetricsSnapshotClient;
  },
  args: ContactWeeklyReportArgs,
  now: Date = new Date(),
): Promise<ContactWeeklyReportRun> {
  const until = args.until ? new Date(args.until) : now;
  const since = args.since ? new Date(args.since) : new Date(until.getTime() - 7 * 24 * 3_600_000);
  if (Number.isNaN(until.getTime()) || Number.isNaN(since.getTime()) || since >= until) {
    throw new Error('--since/--until 必须是合法 ISO 时间且 since < until');
  }
  const workspaceId = args.workspace ?? null;
  const metrics = await computeContactMetrics(deps.runner, {
    since,
    until,
    ...(workspaceId ? { workspaceId } : {}),
  });
  const history = await loadCoverageHistory(deps.snapshots, {
    workspaceId,
    before: new Date(metrics.window.since),
    limit: 2,
  });
  const alerts = evaluateContactWeeklyAlerts({
    validCoverageSeries: [
      metrics.validEmailCompanyCoverage.rate,
      history[0] ?? null,
      history[1] ?? null,
    ],
    verificationErrors: metrics.verificationErrorRate.errors,
    verificationVotes: metrics.verificationErrorRate.votes,
    costMicrousdPerValid: metrics.costPerValidEmail.microusdPerValid,
  });
  const persist = args.persist ?? true;
  if (persist) {
    await persistContactMetricsSnapshot(deps.snapshots, metrics, alerts, workspaceId);
  }
  return {
    metrics,
    alerts,
    report: renderContactWeeklyReportMarkdown(metrics, alerts),
    persisted: persist,
  };
}

async function main(): Promise<void> {
  const args = parseContactWeeklyReportArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const run = await runContactWeeklyReport(
      {
        runner: prismaQueryRunner(prisma),
        snapshots: prisma as unknown as ContactMetricsSnapshotClient,
      },
      args,
    );
    if (args.json) {
      console.log(
        JSON.stringify({ metrics: run.metrics, alerts: run.alerts, persisted: run.persisted }, null, 2),
      );
    } else if (args.out) {
      const outPath = resolve(process.cwd(), args.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, run.report, 'utf8');
      console.log(
        `周报已写入 ${outPath}（快照${run.persisted ? '已' : '未'}落库；告警 FIRING ${run.alerts.filter((alert) => alert.status === 'FIRING').length} 条）`,
      );
    } else {
      console.log(run.report);
    }
    if (run.alerts.some((alert) => alert.status === 'FIRING')) {
      process.exitCode = 10;
    }
  } finally {
    await prisma.$disconnect();
  }
}

// 直接执行才跑（被 vitest import 时不自动触发）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
