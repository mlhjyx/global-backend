/**
 * source_yield_ledger 回填 CLI（获客 vNext W3）。
 *
 * 账本的生产写入在 finalizeRun（temporal/discovery.activities.ts）里；本脚本用
 * 同一段 SQL（src/evaluation/source-yield-ledger.ts）为历史 run 补账。幂等：
 * 已有行的 (run, provider, query) 不会重复写，重复执行安全。
 *
 * 口径提醒：账本行按当前库内事实重算——若某 run 的 judgment_record 在 run 终结
 * 之后才写入（如 FAILED run 的补判），回填结果的 new_qualified 可能与线上时点
 * 不同，但已写入的行不会被覆盖（ON CONFLICT DO NOTHING）。
 *
 * 运行（apps/api 下 owner 连接）：
 *   node --import tsx scripts/backfill-source-yield-ledger.mts --run=<uuid>
 *   node --import tsx scripts/backfill-source-yield-ledger.mts --workspace=<uuid> [--limit=200]
 *   node --import tsx scripts/backfill-source-yield-ledger.mts --all [--limit=500]
 */
import "dotenv/config";
process.umask(0o077);
import { PrismaClient } from "@prisma/client";
import { writeSourceYieldLedger } from "../src/evaluation/source-yield-ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function one(argv: string[], name: string): string | null {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runId = one(argv, "run");
  const workspace = one(argv, "workspace");
  const all = argv.includes("--all");
  const limitRaw = one(argv, "limit");
  const limit = limitRaw === null ? 500 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) fail("--limit 必须是 1..5000");
  if (runId !== null && !UUID.test(runId)) fail("--run 必须是 uuid");
  if (workspace !== null && !UUID.test(workspace)) fail("--workspace 必须是 uuid");
  if (!runId && !workspace && !all) {
    fail("需要 --run=<uuid>、--workspace=<uuid> 或 --all 三者之一");
  }

  const prisma = new PrismaClient();
  try {
    const runs = runId
      ? await prisma.discoveryRun.findMany({
          where: { id: runId },
          select: { id: true, workspaceId: true, status: true, createdAt: true },
        })
      : await prisma.discoveryRun.findMany({
          where: {
            ...(workspace ? { workspaceId: workspace } : {}),
            completedAt: { not: null },
          },
          select: { id: true, workspaceId: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: limit,
        });
    if (runs.length === 0) {
      console.log("没有找到需要回填的 run（completedAt 非空的 run 才可回填）。");
      return;
    }
    let totalInserted = 0;
    let touched = 0;
    for (const run of runs) {
      const inserted = await writeSourceYieldLedger(prisma, {
        workspaceId: run.workspaceId,
        runId: run.id,
      });
      if (inserted > 0) touched += 1;
      totalInserted += inserted;
      console.log(
        `run ${run.id}（${run.status}）→ 写入 ${inserted} 行` +
          `${inserted === 0 ? "（行已存在，或该 run 早于受治理查询血缘、没有 attempt 事实行）" : ""}`,
      );
    }
    console.log(
      `✓ 共扫描 ${runs.length} 个 run：${touched} 个新写入，合计 ${totalInserted} 行账本。`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error("✗ 回填失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
