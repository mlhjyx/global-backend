/**
 * 存量重判批次规划 CLI（P3 J21；设计 §4.3.9 J21）。
 *
 * 只读规划：从 ACTIVE ICP 与 canonical_company 里找出「尚未用当前 prompt/rubric 判过」
 * 的候选，按有域名优先排序，切批并估算成本；**本脚本不调用模型、不写库**。
 * 真正的执行在发车后的 worker（--execute 当前显式拒绝，防止误跑）。
 *
 * 用法：
 *   pnpm exec tsx scripts/judgment/rejudge-batch.mts --workspace <uuid> \
 *     [--max-companies 100] [--batch-size 25] [--cost-cap-usd 5] [--json out.json] [--execute]
 *
 * 成本口径：每家公司一次 L2 判定 ≈ $0.0099（9900 micros，k=1，设计 §4.3.3.7 实测均值）。
 */

import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { PROMPT_HASH } from '../../src/discovery/judgment/judge-prompt';
import { RUBRIC_VERSION } from '../../src/discovery/judgment/fit-rubric';
import {
  planRejudgeBatches,
  type RejudgeCandidate,
} from '../../src/discovery/judgment/rejudge-plan';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    'max-companies': { type: 'string' },
    'batch-size': { type: 'string' },
    'cost-cap-usd': { type: 'string' },
    json: { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});

const workspaceId = values.workspace;
if (!workspaceId) {
  console.error('--workspace <uuid> is required');
  process.exit(2);
}
if (values.execute) {
  console.error(
    'REFUSED: 本脚本只做规划。真实重判要在发车后的 worker 上跑（JUDGE_CONTRACT_MODE 与预算帽就绪后），' +
      '见 docs/backend/judgment-rejudge-batch.md。',
  );
  process.exit(3);
}

const maxCompanies =
  values['max-companies'] === undefined ? 500 : Number(values['max-companies']);
if (!Number.isInteger(maxCompanies) || maxCompanies < 1) {
  console.error('--max-companies must be a positive integer');
  process.exit(2);
}
const batchSize =
  values['batch-size'] === undefined ? undefined : Number(values['batch-size']);
const costCapUsd = values['cost-cap-usd'] === undefined ? 5 : Number(values['cost-cap-usd']);
if (!Number.isFinite(costCapUsd) || costCapUsd <= 0) {
  console.error('--cost-cap-usd must be positive');
  process.exit(2);
}
const costCapMicros = BigInt(Math.round(costCapUsd * 1_000_000));

const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('APP_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main(): Promise<void> {
  // RLS：即使 owner 连接也按 current_workspace_id() 过滤，读查询必须包在 set_config 事务里。
  const scoped = <T>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId!}, true)`;
      return fn(tx);
    });

  const icps = await scoped((tx) =>
    tx.icpDefinition.findMany({
      where: { workspaceId: workspaceId!, status: 'ACTIVE' },
      select: { id: true },
    }),
  );
  const candidates: RejudgeCandidate[] = [];
  for (const icp of icps) {
    const judged = await scoped((tx) =>
      tx.judgmentRecord.findMany({
        where: {
          workspaceId: workspaceId!,
          icpId: icp.id,
          promptHash: PROMPT_HASH,
          rubricVersion: RUBRIC_VERSION,
        },
        select: { canonicalCompanyId: true },
        distinct: ['canonicalCompanyId'],
      }),
    );
    const judgedIds = judged.map((row) => row.canonicalCompanyId);
    const companies = await scoped((tx) =>
      tx.canonicalCompany.findMany({
        where: {
          workspaceId: workspaceId!,
          ...(judgedIds.length > 0 ? { id: { notIn: judgedIds } } : {}),
        },
        select: { id: true, name: true, domain: true },
        take: maxCompanies * 4,
      }),
    );
    for (const company of companies) {
      candidates.push({
        canonicalCompanyId: company.id,
        companyName: company.name,
        domain: company.domain,
        icpId: icp.id,
      });
    }
  }

  const plan = planRejudgeBatches(candidates, {
    batchSize,
    costCapMicros,
    maxCompanies,
  });
  const summary = {
    workspace: workspaceId,
    activeIcps: icps.length,
    promptHash: PROMPT_HASH.slice(0, 16),
    rubricVersion: RUBRIC_VERSION,
    plannedCompanies: plan.totalCandidates,
    skippedByLimit: plan.skipped,
    batches: plan.batches.map((batch) => ({
      index: batch.index,
      companies: batch.candidates.length,
      estimatedCostMicros: batch.estimatedCostMicros.toString(),
    })),
    estimatedCostMicros: plan.estimatedCostMicros.toString(),
    estimatedCostUsd: Number(plan.estimatedCostMicros) / 1_000_000,
    costCapUsd,
    note: '规划 only —— 执行见 docs/backend/judgment-rejudge-batch.md',
  };
  const text = JSON.stringify(summary, null, 2);
  if (values.json) {
    writeFileSync(values.json, `${text}\n`);
    console.log(`plan written to ${values.json}`);
  } else {
    console.log(text);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
