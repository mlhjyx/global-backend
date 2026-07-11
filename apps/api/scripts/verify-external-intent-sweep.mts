/**
 * P5 · 外部源 intent sweep（externalIntentSweepWorkflow 的活动）—— 真实数据端到端（真库真 API，无 sandbox）。
 * **活动级**验证（不需 Temporal server）：直接构造 createExternalIntentActivities，喂真 ACTIVE ICP，证明
 * 收口⑤新四段活动流「枚举 ICP → 确定性解析 CPV/FDA 码 → **平台摄取 ingest-once**（source_signal +
 * signal_ingest 账本）→ **只读投影**」整条 sweep 逻辑在真数据上跑通。
 * workflow 本身是薄编排（mirror intentSweep），靠 build 保正确。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-external-intent-sweep.mts
 *
 * 五段（有界样本）：
 *   Tier 1 · 枚举：listExternalIntentTargets → 两条 ACTIVE ICP 都在，tedEnabled & openfdaEnabled=true。
 *   Tier 2 · 解析：resolveExternalIntentTarget（确定性 allowLlm:false，零出网）→ pumps→CPV+国别、
 *            radiology→FDA 产品码。
 *   Tier 3 · 摄取：ingestExternalSignals（指纹全局去重 → ingest-once → source_signal 平台表 +
 *            signal_ingest 账本）→ 无非预期错误、每个唯一指纹要么真拉要么账本命中。
 *   Tier 4 · 投影：expireStaleSignals（投影前状态机 sweep）→ projectExternalIntentForIcp（只读平台表，
 *            零出网）→ pumps 有 TENDER_PUBLISHED 投影、radiology clearances 跑通。
 *   Tier 5 · kill-switch：data_provider ted 置 DISABLED → tedEnabled=false，摄取零 TED spec、投影跳过 TED。
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
import { canonicalFdaSpec, canonicalTedSpec, queryFingerprint } from '../src/signals/signal-query';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; // 一次性验证 workspace
const EU = ['Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria', 'Poland'];
const cleanupFingerprints: string[] = []; // 清理段按**本脚本自己的查询指纹**删账本行（复审：fetchedAt>=启动时间会误删并发 Schedule/他方 verify 的行）

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

  // ══════════ Tier 2 · 解析（确定性，零出网零 LLM）══════════
  console.log('\n══ Tier 2 · resolveExternalIntentTarget（allowLlm:false 确定性解析 CPV/FDA 码，零出网）══');
  const resolvedPump = await acts.resolveExternalIntentTarget({ workspaceId: WS, icpId: pumpIcpId });
  const resolvedRadio = await acts.resolveExternalIntentTarget({ workspaceId: WS, icpId: radioIcpId });
  console.log(`   pumps: cpvCodes=[${resolvedPump.cpvCodes.join(',')}] buyerCountries=${resolvedPump.buyerCountries.length}  err=${resolvedPump.error ?? '—'}`);
  console.log(`   radiology: fdaProductCodes=[${resolvedRadio.fdaProductCodes.join(',')}]  err=${resolvedRadio.error ?? '—'}`);
  ok(resolvedPump.cpvCodes.length > 0 && resolvedPump.buyerCountries.length > 0, 'Tier 2：pumps → CPV 码 + 买方国别确定性解析成功（不靠 LLM）');
  ok(resolvedRadio.fdaProductCodes.length > 0, 'radiology + US → FDA 产品码确定性解析成功（panel 子树宽网）');
  // 记录本脚本产生的查询指纹（与 ingestExternalSignals 的构造参数一致：maxNotices/maxRecords=100）供清理段作用域化删除。
  if (resolvedPump.cpvCodes.length && resolvedPump.buyerCountries.length) {
    cleanupFingerprints.push(queryFingerprint(canonicalTedSpec({ cpvCodes: resolvedPump.cpvCodes, buyerCountries: resolvedPump.buyerCountries, maxRecords: 100 })));
  }
  if (resolvedRadio.fdaProductCodes.length) {
    cleanupFingerprints.push(queryFingerprint(canonicalFdaSpec({ productCodes: resolvedRadio.fdaProductCodes, maxRecords: 100 })));
  }

  // ══════════ Tier 3 · 平台摄取（ingest-once → source_signal）══════════
  console.log('\n══ Tier 3 · ingestExternalSignals（指纹全局去重 → ingest-once → source_signal + signal_ingest 账本）══');
  const ingested = await acts.ingestExternalSignals({
    targets: [resolvedPump, resolvedRadio],
    tedEnabled: listed.tedEnabled,
    openfdaEnabled: listed.openfdaEnabled,
    maxNotices: 100,
    maxRecords: 100,
  });
  console.log(`   tedSpecs=${ingested.tedSpecs} fdaSpecs=${ingested.fdaSpecs} fetches=${ingested.fetches} ledgerHits=${ingested.ledgerHits} signalsUpserted=${ingested.signalsUpserted} budgetExceeded=${ingested.budgetExceeded} errors=[${ingested.errors.join('; ')}]`);
  ok(ingested.tedSpecs > 0 && ingested.fdaSpecs > 0, 'Tier 3：两 provider 各 ≥1 个唯一查询指纹（TED + openFDA 查询面都成立）');
  ok(ingested.errors.length === 0 && !ingested.budgetExceeded, '摄取无非预期错误（errors 空、预算未打穿）');
  ok(ingested.fetches + ingested.ledgerHits === ingested.tedSpecs + ingested.fdaSpecs, `每个唯一指纹要么真拉要么账本命中（ingest-once：${ingested.fetches} 拉 + ${ingested.ledgerHits} 命中 = ${ingested.tedSpecs + ingested.fdaSpecs} 指纹）`);

  // ══════════ Tier 4 · 只读投影（expire → project，零出网）══════════
  console.log('\n══ Tier 4 · expireStaleSignals → projectExternalIntentForIcp（只读 source_signal，零出网）══');
  const expired = await acts.expireStaleSignals();
  console.log(`   expireStaleSignals: expired=${expired.expired}（ACTIVE 且过期 → EXPIRED，投影前状态机 sweep）`);

  const ted = await acts.projectExternalIntentForIcp({ ...resolvedPump, tedEnabled: listed.tedEnabled, openfdaEnabled: listed.openfdaEnabled });
  console.log(`   pumps: cpvCodes=${ted.cpvCodes}  tenders=${JSON.stringify(ted.tenders)}  err=${ted.error ?? '—'}`);
  ok((ted.tenders?.signalsMatched ?? 0) > 0, `平台表信号匹配 ${ted.tenders?.signalsMatched ?? 0} 条（投影只读 source_signal）`);
  ok(!!ted.tenders && ted.tenders.companiesTouched > 0, `TED 真投影买方 canonical（companiesTouched=${ted.tenders?.companiesTouched ?? 0}）`);
  ok((ted.tenders?.eventsProjected ?? 0) > 0, `TENDER_PUBLISHED 事件投影 ${ted.tenders?.eventsProjected ?? 0} 条`);

  const fda = await acts.projectExternalIntentForIcp({ ...resolvedRadio, tedEnabled: listed.tedEnabled, openfdaEnabled: listed.openfdaEnabled });
  console.log(`   radiology: fdaProductCodes=${fda.fdaProductCodes}  clearances=${JSON.stringify(fda.clearances)}  err=${fda.error ?? '—'}`);
  ok(!!fda.clearances && (!fda.error || !fda.error.includes('openfda')), 'openFDA 投影跑通无错（清关事件数据相关，实质证明见 P3 verify）');
  console.log(`   （clearanceEvents=${fda.clearances?.eventsProjected ?? 0}——取决于所选 FDA 码近期是否有清关；sweep 逻辑已跑通）`);

  // ══════════ Tier 5 · kill-switch（data_provider ted 停）══════════
  console.log('\n══ Tier 5 · kill-switch：data_provider ted 置 DISABLED → tedEnabled=false，摄取零 spec、投影跳过 TED ══');
  await ownerDb.dataProvider.update({ where: { key: 'ted' }, data: { status: 'DISABLED' } });
  const gated = await acts.listExternalIntentTargets({ limit: 200 });
  ok(gated.tedEnabled === false, 'ted DISABLED → listExternalIntentTargets.tedEnabled=false');
  const gatedIngest = await acts.ingestExternalSignals({ targets: [resolvedPump], tedEnabled: false, openfdaEnabled: false, maxNotices: 100, maxRecords: 100 });
  ok(gatedIngest.tedSpecs === 0 && gatedIngest.fetches === 0, 'tedEnabled=false → 摄取零 TED spec、零出网');
  const skip = await acts.projectExternalIntentForIcp({ ...resolvedPump, tedEnabled: false, openfdaEnabled: gated.openfdaEnabled });
  ok(skip.tenders === undefined, 'tedEnabled=false → TED 投影跳过（解析已拆层零出网；投影不读不写）');

  // TOCTOU 收口（Codex #56 P1）：喂**过时的**捕获标志 tedEnabled=true（模拟 sweep 头部捕获后 ops 才 DISABLE），
  // ted data_provider 仍 DISABLED——投影必须 live 重读 kill-switch 并跳过 TED，绝不拿缓存 source_signal 造新线索。
  const stale = await acts.projectExternalIntentForIcp({ ...resolvedPump, tedEnabled: true, openfdaEnabled: gated.openfdaEnabled });
  ok(stale.tenders === undefined, '捕获 tedEnabled=true 但 data_provider DISABLED → 投影 live 重读 kill-switch，TED 仍跳过（TOCTOU 收口）');
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
  // 删本次跑产生的 signal_ingest 账本行（按**本脚本的查询指纹**作用域化，绝不误删并发 Schedule/他方 verify 的行）
  // ——防旧 OK 账本行让下次真跑账本命中不出网。source_signal 行保留（平台事实，非本脚本私有）。
  if (cleanupFingerprints.length) {
    await ownerDb.signalIngest.deleteMany({ where: { queryFingerprint: { in: cleanupFingerprints } } }).catch(() => {});
  }
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
