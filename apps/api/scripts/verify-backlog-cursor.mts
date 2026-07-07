/**
 * 存量对账下游阶段饿死的**根因复现 + 修复证明**（PR #20 复审 HIGH #1/#2 + 对抗复审揭出的 C×T 残留）。
 * 真库真 RLS，无 sandbox。
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-backlog-cursor.mts
 *
 * ⚠️ 必须以 app_user（非 superuser）连接跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 *
 * 两代 bug、一并证明：
 *   · 原 bug（PR #20）：无水位 → 扫描集不收缩 → 每 sweep 重扫最前 N 家。水位收缩已修（stamp 后离开过滤集）。
 *   · 残留（对抗复审）：只加水位 + 旧 `id ASC` 排序 → C×T 跑步机：最先处理的低-id 行最先过冷却期、
 *     又因 id 最小被重新抢到最前，永远压过从未处理的高-id 尾巴 → 存量 > C×T 仍永久饿死。
 *   本 PR 用 `水位 ASC NULLS FIRST, id ASC`（最久未处理优先）根除：从未处理（NULL）的行永远先于已处理行。
 *
 * 证明三段：
 *   A. 跑步机复现 + 根治（确定性）：造「2 家低-id 已过冷却期(re-stale) + 4 家高-id 从未处理(NULL)」，
 *      旧 `id ASC` 取到 [c0,c1]（复处理 re-stale、饿死 NULL 尾巴 = 跑步机）；新 LRU 排序取到 [c2,c3]
 *      （先吞从未处理）。全排空时 NULL 尾巴 c2..c5 全部先于 re-stale 的 c0,c1 被处理。
 *   B. 真活动端到端：真 enrichSignalsBacklog 单批（batch=2），在同样 re-stale/NULL 布局下，实际处理的是
 *      从未处理的 c2,c3（不是低-id 的 c0,c1）——真活动确用 LRU 排序。
 *   C. 租户隔离：workspace A 的 stamp updateMany 绝不触及 workspace B 的行（RLS 读写双向）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBacklogActivities } from '../src/temporal/backlog.activities';
import { backlogEligibleWhere, backlogEligibleOrderBy } from '../src/temporal/backlog.eligibility';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { companyIdentity } from '../src/discovery/identity';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WS_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WS_ACT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const P = '__BLVERIFY__';
const RESTALE = new Date(Date.now() - 10 * 24 * 3600 * 1000); // 10d ago > signal TTL 7d → 已过冷却期
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → RLS 被绕，证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

async function seed(ws: string, n: number) {
  await prisma.withWorkspace(ws, async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.canonicalCompany.create({
        data: { workspaceId: ws, name: `${P}${i}`, domain: `c${i}.blverify.invalid`, country: 'DE', industry: 'manufacturing', fitVerdict: 'match', status: 'ENRICHED', dedupeKey: companyIdentity({ name: `${P}${i}`, domain: `c${i}.blverify.invalid`, country: 'DE' }).dedupeKey },
      });
    }
  });
  const ord = await prisma.withWorkspace(ws, (tx) =>
    tx.canonicalCompany.findMany({ where: { name: { startsWith: P } }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { ord, labelOf: new Map(ord.map((c, i) => [c.id, `c${i}`])) };
}
async function cleanup(ws: string) {
  await prisma.withWorkspace(ws, async (tx) => {
    const s = await tx.canonicalCompany.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
    if (s.length) {
      await tx.fieldEvidence.deleteMany({ where: { entityId: { in: s.map((x) => x.id) } } });
      await tx.canonicalCompany.deleteMany({ where: { id: { in: s.map((x) => x.id) } } });
    }
  });
}
await Promise.all([cleanup(WS_A), cleanup(WS_B), cleanup(WS_ACT)]);

// ══════════ Part C：租户隔离 ══════════
console.log('\n══ Part C · 租户隔离（RLS 读写双向）══');
const { ord: ordB } = await seed(WS_B, 1);
const bId = ordB[0].id;
const seenFromA = await prisma.withWorkspace(WS_A, (tx) => tx.canonicalCompany.findMany({ where: { id: bId }, select: { id: true } }));
ok(seenFromA.length === 0, 'workspace A 读不到 workspace B 的公司（RLS 读隔离）');
await prisma.withWorkspace(WS_A, (tx) => tx.canonicalCompany.updateMany({ where: { id: { in: [bId] } }, data: { lastSignalAt: new Date() } }));
const bAfter = await ownerDb.canonicalCompany.findUnique({ where: { id: bId }, select: { lastSignalAt: true } });
ok(bAfter?.lastSignalAt == null, 'workspace A 的 stamp updateMany 未触及 workspace B 的行（RLS 写隔离）');

// ══════════ Part A：C×T 跑步机复现 + LRU 根治（确定性）══════════
console.log('\n══ Part A · C×T 跑步机复现 + NULLS-FIRST 根治 ══');
const { ord: ordA, labelOf } = await seed(WS_A, 6);
const lab = (rows: { id: string }[]) => rows.map((r) => labelOf.get(r.id) ?? '?').join(',');
// 布局：c0,c1 = 低-id 已过冷却期(re-stale)；c2..c5 = 高-id 从未处理(NULL)
await prisma.withWorkspace(WS_A, (tx) => tx.canonicalCompany.updateMany({ where: { id: { in: [ordA[0].id, ordA[1].id] } }, data: { lastSignalAt: RESTALE } }));
console.log('布局：c0,c1 = 低-id 已过冷却期(re-stale)  |  c2,c3,c4,c5 = 高-id 从未处理(NULL)');

const eligWhere = () => backlogEligibleWhere({ watermarkField: 'lastSignalAt', now: new Date(), requireDomain: true });
const oldOrderFront = await prisma.withWorkspace(WS_A, (tx) =>
  tx.canonicalCompany.findMany({ where: eligWhere(), orderBy: { id: 'asc' }, take: 2, select: { id: true } }),
);
const newOrderFront = await prisma.withWorkspace(WS_A, (tx) =>
  tx.canonicalCompany.findMany({ where: eligWhere(), orderBy: backlogEligibleOrderBy('lastSignalAt'), take: 2, select: { id: true } }),
);
console.log(`旧排序 id ASC     取: [${lab(oldOrderFront)}]  ← 复处理 re-stale、饿死 NULL 尾巴 = 跑步机`);
console.log(`新排序 LRU(本 PR) 取: [${lab(newOrderFront)}]  ← 先吞从未处理`);
ok(lab(oldOrderFront) === 'c0,c1', '旧 id ASC 排序抢到低-id re-stale [c0,c1]（复现 C×T 跑步机饿死）');
ok(lab(newOrderFront) === 'c2,c3', '新 LRU 排序先取从未处理 [c2,c3]（NULLS FIRST 压过 re-stale）');

// 全排空（LRU + stamp，batch=2）：记录处理顺序，验证 NULL 尾巴全部先于 re-stale 被处理
const processOrder: string[] = [];
for (let round = 0; round < 4; round++) {
  const batch = await prisma.withWorkspace(WS_A, (tx) =>
    tx.canonicalCompany.findMany({ where: eligWhere(), orderBy: backlogEligibleOrderBy('lastSignalAt'), take: 2, select: { id: true } }),
  );
  if (!batch.length) break;
  await prisma.withWorkspace(WS_A, (tx) => tx.canonicalCompany.updateMany({ where: { id: { in: batch.map((b) => b.id) } }, data: { lastSignalAt: new Date() } }));
  processOrder.push(...batch.map((b) => labelOf.get(b.id)!));
}
console.log(`LRU 全排空处理顺序: ${processOrder.join(' → ')}`);
const idxRestale = Math.min(processOrder.indexOf('c0'), processOrder.indexOf('c1'));
const idxNullLast = Math.max(processOrder.indexOf('c2'), processOrder.indexOf('c3'), processOrder.indexOf('c4'), processOrder.indexOf('c5'));
ok(new Set(processOrder).size === 6, '6 家全部够到（无饿死）');
ok(idxNullLast < idxRestale, '从未处理的 c2..c5 全部先于 re-stale 的 c0,c1 被处理（NULL 尾巴不被低-id re-stale 抢占=根除跑步机）');

// ══════════ Part B：真活动端到端 ══════════
console.log('\n══ Part B · 真活动 enrichSignalsBacklog 单批（真 providers·真 RLS·LRU 排序）══');
const reg = new ModelProviderRegistry();
const gp = buildGatewayProvider();
if (gp) reg.register(gp);
if (stubAllowed()) reg.register(new StubModelProvider());
const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
const providers = new DiscoveryProviderRegistry({ gateway, broker: buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) }) });
const acts = createBacklogActivities({ prisma, providers, gateway, ownerDb });
const { ord: ordAct, labelOf: labAct } = await seed(WS_ACT, 6);
await prisma.withWorkspace(WS_ACT, (tx) => tx.canonicalCompany.updateMany({ where: { id: { in: [ordAct[0].id, ordAct[1].id] } }, data: { lastSignalAt: RESTALE } }));
const r = await acts.enrichSignalsBacklog({ workspaceId: WS_ACT, limit: 2, cursor: null });
// 处理过 = lastSignalAt 被刷新到「近 now」（re-stale 的 c0,c1 若未处理则保持 10d 前的旧值）
const rows = await ownerDb.canonicalCompany.findMany({ where: { workspaceId: WS_ACT, name: { startsWith: P } }, select: { id: true, lastSignalAt: true } });
const recent = new Set(rows.filter((x) => x.lastSignalAt && Date.now() - x.lastSignalAt.getTime() < 5 * 60 * 1000).map((x) => x.id));
const processedLbl = ordAct.filter((c) => recent.has(c.id)).map((c) => labAct.get(c.id)).join(',');
console.log(`真活动 scanned=${r.scanned}；本批处理（近 now 刷新水位）= [${processedLbl}]`);
ok(r.scanned === 2, '真活动单批 scanned=2');
ok(processedLbl === 'c2,c3', '真活动处理的是从未处理的 c2,c3（不是低-id re-stale 的 c0,c1）→ 真活动确用 LRU 排序');

await Promise.all([cleanup(WS_A), cleanup(WS_B), cleanup(WS_ACT)]);
console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
await prisma.$disconnect();
await ownerDb.$disconnect();
process.exit(failed === 0 ? 0 : 1);
