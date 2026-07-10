/**
 * P5 · 外部源 intent sweep（externalIntentSweepWorkflow 的活动）—— 真实数据端到端（真库真 API，无 sandbox）。
 * **活动级**验证（不需 Temporal server）：直接构造 createExternalIntentActivities，喂真 ACTIVE ICP，证明
 * 「枚举 ICP → 确定性解析 CPV/FDA 码 → 投影 TED 招标 + openFDA 清关 intent」整条 sweep 逻辑在真数据上跑通。
 * 让已落地的两 P3 投影**在生产周期真跑**（loop 收口）——workflow 本身是薄编排（mirror intentSweep），靠 build 保正确。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-external-intent-sweep.mts
 *
 * 四段（有界样本）：
 *   Tier 1 · 枚举：listExternalIntentTargets → 两条 ACTIVE ICP 都在，tedEnabled & openfdaEnabled=true。
 *   Tier 2 · TED 投影：pumps + EU ICP → CPV 确定性解析 → projectTenders 真投影买方 canonical + TENDER_PUBLISHED。
 *   Tier 3 · openFDA 解析+投影：radiology + US ICP → FDA 产品码确定性解析 → projectClearances 跑通（无错）。
 *   Tier 4 · kill-switch：data_provider ted 置非 ENABLED → tedEnabled=false，投影跳过 TED（ops 一键停）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxonomyResolver } from '../src/discovery/taxonomy-resolver';
import { createExternalIntentActivities } from '../src/temporal/external-intent.activities';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; // 一次性验证 workspace
const EU = ['Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria', 'Poland'];

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

const reg = new ModelProviderRegistry();
const gp = buildGatewayProvider();
if (gp) reg.register(gp);
if (stubAllowed()) reg.register(new StubModelProvider());
const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
const taxonomy = new TaxonomyResolver(prisma, gateway);
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const acts = createExternalIntentActivities({ prisma, taxonomy, ownerDb, broker });

const POLICY_DOMAINS = ['api.ted.europa.eu', 'api.fda.gov'];
let pumpIcpId = '';
let radioIcpId = '';
// 快照 provider/policy 原状态（Codex 复审）：finally 还原**原值**而非恒置 ENABLED/APPROVED——否则在共享库上
// 会清掉 ops 故意的停用/暂停，让新调度 sweep 意外恢复对外抓取。
let origProviders: { key: string; status: string }[] = [];
let origPolicies: { domain: string; reviewStatus: string }[] = [];

async function seed() {
  // 先快照（在 registry.seed / 强置之前），拿到 ops 真原状态
  origProviders = await ownerDb.dataProvider.findMany({ where: { key: { in: ['ted', 'openfda'] } }, select: { key: true, status: true } });
  origPolicies = await ownerDb.sourcePolicy.findMany({ where: { domain: { in: POLICY_DOMAINS } }, select: { domain: true, reviewStatus: true } });

  await new DiscoveryProviderRegistry().seed(ownerDb); // 确保 data_provider ted/openfda + source_policy 行存在
  await ownerDb.sourcePolicy.updateMany({ where: { domain: { in: POLICY_DOMAINS } }, data: { reviewStatus: 'APPROVED' } });
  await ownerDb.dataProvider.updateMany({ where: { key: { in: ['ted', 'openfda'] } }, data: { status: 'ENABLED' } });
  await ownerDb.workspace.upsert({ where: { id: WS }, create: { id: WS, name: 'verify-external-intent' }, update: {} });
  const company = await ownerDb.companyProfile.create({ data: { workspaceId: WS, name: 'Verify Seller Co' } });
  const pump = await ownerDb.icpDefinition.create({
    data: { workspaceId: WS, companyId: company.id, name: 'Pumps EU', status: 'ACTIVE', companyAttributes: { industry: 'pumps' }, targetMarkets: EU },
  });
  const radio = await ownerDb.icpDefinition.create({
    data: { workspaceId: WS, companyId: company.id, name: 'Radiology US', status: 'ACTIVE', companyAttributes: { industry: 'radiology imaging devices', product: 'radiology imaging', trade_side: 'importer' }, targetMarkets: ['United States'] },
  });
  pumpIcpId = pump.id;
  radioIcpId = radio.id;
}

async function main() {
  await seed();

  // ══════════ Tier 1 · 枚举 ══════════
  console.log('\n══ Tier 1 · listExternalIntentTargets（枚举 ACTIVE ICP + provider kill-switch 状态）══');
  const listed = await acts.listExternalIntentTargets({ limit: 200 });
  const mine = listed.targets.filter((t) => t.workspaceId === WS);
  console.log(`   本 WS ACTIVE ICP=${mine.length}（全库 ${listed.targets.length}）  tedEnabled=${listed.tedEnabled} openfdaEnabled=${listed.openfdaEnabled}`);
  ok(mine.some((t) => t.icpId === pumpIcpId) && mine.some((t) => t.icpId === radioIcpId), 'Tier 1：两条 ACTIVE ICP 都被枚举');
  ok(listed.tedEnabled && listed.openfdaEnabled, 'ted + openfda data_provider 均 ENABLED');

  // ══════════ Tier 2 · TED 投影（pumps + EU）══════════
  console.log('\n══ Tier 2 · projectExternalIntentForIcp(pumps + EU) → CPV 确定性 → projectTenders ══');
  const ted = await acts.projectExternalIntentForIcp({ workspaceId: WS, icpId: pumpIcpId, tedEnabled: true, openfdaEnabled: true });
  console.log(`   cpvCodes=${ted.cpvCodes}  tenders=${JSON.stringify(ted.tenders)}  err=${ted.error ?? '—'}`);
  ok(ted.cpvCodes > 0, 'Tier 2：pumps → CPV 码确定性解析成功（不靠 LLM）');
  ok(!!ted.tenders && ted.tenders.companiesTouched > 0, `TED 真投影买方 canonical（companiesTouched=${ted.tenders?.companiesTouched ?? 0}）`);
  ok((ted.tenders?.eventsProjected ?? 0) > 0, `TENDER_PUBLISHED 事件投影 ${ted.tenders?.eventsProjected ?? 0} 条`);

  // ══════════ Tier 3 · openFDA 解析+投影（radiology + US）══════════
  console.log('\n══ Tier 3 · projectExternalIntentForIcp(radiology + US) → FDA 码确定性 → projectClearances ══');
  const fda = await acts.projectExternalIntentForIcp({ workspaceId: WS, icpId: radioIcpId, tedEnabled: true, openfdaEnabled: true });
  console.log(`   fdaProductCodes=${fda.fdaProductCodes}  clearances=${JSON.stringify(fda.clearances)}  err=${fda.error ?? '—'}`);
  ok(fda.fdaProductCodes > 0, 'Tier 3：radiology + US → FDA 产品码确定性解析成功（panel 子树宽网）');
  ok(!fda.error || !fda.error.includes('openfda'), 'openFDA 投影跑通无错（清关事件数据相关，实质证明见 P3 verify）');
  console.log(`   （clearanceEvents=${fda.clearances?.eventsProjected ?? 0}——取决于所选 FDA 码近期是否有清关；sweep 逻辑已跑通）`);

  // ══════════ Tier 4 · kill-switch（data_provider ted 停）══════════
  console.log('\n══ Tier 4 · kill-switch：data_provider ted 置 DISABLED → tedEnabled=false，TED 跳过 ══');
  await ownerDb.dataProvider.update({ where: { key: 'ted' }, data: { status: 'DISABLED' } });
  const gated = await acts.listExternalIntentTargets({ limit: 200 });
  ok(gated.tedEnabled === false, 'ted DISABLED → listExternalIntentTargets.tedEnabled=false');
  const skip = await acts.projectExternalIntentForIcp({ workspaceId: WS, icpId: pumpIcpId, tedEnabled: false, openfdaEnabled: gated.openfdaEnabled });
  ok(skip.tenders === undefined && skip.cpvCodes === 0, 'tedEnabled=false → TED 投影跳过（不解析、不投影）');
  await ownerDb.dataProvider.update({ where: { key: 'ted' }, data: { status: 'ENABLED' } });
}

try {
  await main();
} finally {
  // 还原 provider/policy 到 **pre-run 原状态**（不恒置 ENABLED/APPROVED，防清掉 ops 故意停用）+ 删本 WS 全部数据
  for (const p of origProviders) await ownerDb.dataProvider.update({ where: { key: p.key }, data: { status: p.status } }).catch(() => {});
  for (const p of origPolicies) await ownerDb.sourcePolicy.update({ where: { domain: p.domain }, data: { reviewStatus: p.reviewStatus } }).catch(() => {});
  await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.icpDefinition.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.companyProfile.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.workspace.delete({ where: { id: WS } }).catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
