/**
 * SAM.gov Sources Sought P4 → Intent 投影 —— 真实数据端到端（真库真 CSV，无 sandbox，CLAUDE.md §5）。
 * 镜像 TED P3 五段证明，但落 SAM 特性：
 *   - 摄取「下载一次」：指纹 NAICS 无关（仅 sinceDays+maxRecords）→ 全 ICP 收敛到一次 CSV 下载；投影层按 NAICS 子树过滤。
 *   - 美国联邦市场：投影无 alpha-2 国别过滤；买方国别恒 US。
 *   - 公共领域（17 U.S.C. §105）：署名非义务（同 openFDA CC0，异于 TED CC BY）。
 *   - 🔴 联系官（PrimaryContact/SecondaryContact 系列）adapter+mapper 双层结构性剔除——绝不入绿库。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-sam-sources-sought.mts
 *
 * 六段（有界样本，绝不 grind 全量）：
 *   Tier 0 · 词表确定性 + RLS guard：resolveIcpToNaics(allowLlm:false) 泵 ICP → 广锚 ['333']（镜像 Schedule）；
 *            resolveNaicsForProduct('pumps',['333'],allowLlm:false) → '333914'（seed 别名确定性精修，零 LLM）；
 *            US 市场门：EU-only ICP → []（不给 EU-only 塞美国数据）；RLS 连接非 superuser（withWorkspace 真生效）。
 *   Tier 1 · 真 CSV：fetchSourcesSought 直打 keyless CSV → 真 Sources Sought（机构/NAICS/发布日）+
 *            §8.6 发布日 ISO 合法 + 🔴 序列化无邮箱/无 PrimaryContact/SecondaryContact（结构性隔离）+ NAICS 分布。
 *   Tier 2 · 真摄取+投影：seed source_policy(APPROVED) → ingestSam（Broker 过 §8.8 门 → source_signal）→
 *            projectSourcesSought（**只读平台表**，按 ICP NAICS 子树过滤）→ 买方 canonical(US) +
 *            US_FED_SOURCES_SOUGHT + government_buyer/sam_market_signal/disclaimer + field_evidence(公共领域/无 PII)。
 *   Tier 2b· 幂等：同参再投影 → companiesTouched=0/eventsProjected=0，field_evidence 行数不变。
 *   Tier 3 · 真评分：scoreLead → Intent 维 0→>0 + demandProof>0（P4 需求证据，同 TED 招标类），signals 含 US_FED_SOURCES_SOUGHT。
 *   Tier 4 · §8.8 负向门（摄取层）：source_policy SUSPENDED → ingestSam（新窗避账本）fail-closed（error/0 落库/不发请求）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { fetchSourcesSought, SamSourcesSought } from '../src/adapters/sam-api';
import { SignalIngestService } from '../src/signals/signal-ingest.service';
import { canonicalSamSpec, queryFingerprint, ingestWindowMs } from '../src/signals/signal-query';
import { SamIntentProjectionService, US_FED_SOURCES_SOUGHT, SAM_LICENSE } from '../src/intent/sam-intent-projection.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';
import { TaxonomyResolver } from '../src/discovery/taxonomy-resolver';
import { resolveIcpToNaics } from '../src/discovery/icp-to-naics';
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

const WS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // 一次性验证 workspace（区别于 TED 的 cccc…）
const SAM_DOMAIN = 'sam.gov';
const SINCE_DAYS = 120;
const MAX_RECORDS = 300; // 有界样本（整包 CSV 过滤后取最新 N 条）
// 制造类多行业 US ICP（最大化匹配概率）：机械/电子/医疗/金属 → NAICS 广锚 333/334/3391/332
const MFG_INDUSTRIES = ['machinery', 'electronics', 'medical devices', 'metal fabrication'];

// intent 事件的关键词代理绝不命中（证明 Intent/demandProof 纯由 US_FED_SOURCES_SOUGHT 驱动，非关键词兜底）
const icp: IcpForScoring = {
  rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'public_administration' }],
  triggerSignals: ['扩产', 'new production line'],
  committeeRoles: [{ role: 'procurement', title: 'Head of Procurement' }],
};

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
// §8.8（收口⑤）：出网收敛在**摄取层**——SignalIngestService 经 ToolBroker 过 source_policy 门；投影 service 只读 source_signal 平台表。
const ingest = new SignalIngestService({ prisma, broker: buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) }) });
const svc = new SamIntentProjectionService({ prisma });

const evidenceCount = () =>
  prisma.withWorkspace(WS, (tx) => tx.fieldEvidence.count({ where: { workspaceId: WS, providerKey: 'samgov' } }));

/** 从抓到的 Sources Sought 统计最常见 NAICS N 位前缀（数据稀疏时的 TED 式放宽锚）。 */
function topNaicsPrefixes(notices: SamSourcesSought[], digits: number, top: number): string[] {
  const tally = new Map<string, number>();
  for (const n of notices) {
    const code = (n.naicsCode ?? '').trim();
    if (code.length >= digits) {
      const p = code.slice(0, digits);
      tally.set(p, (tally.get(p) ?? 0) + 1);
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([p]) => p);
}

async function main() {
  // ══════════ Tier 0 · 词表确定性 + RLS guard（镜像 Schedule 的 allowLlm:false 路径）══════════
  console.log('\n══ Tier 0 · 词表确定性（allowLlm:false，零 LLM）+ RLS 连接 guard ══');
  const superRow = await prisma.$queryRaw<{ current_user: string; is_super: boolean }[]>`
    SELECT current_user AS current_user, usesuper AS is_super FROM pg_user WHERE usename = current_user`;
  const isSuper = superRow[0]?.is_super ?? true;
  ok(isSuper === false, `RLS 连接非 superuser（current_user=${superRow[0]?.current_user ?? '?'}）——withWorkspace RLS 真生效（否则证明失效）`);

  const pumpResolved = await resolveIcpToNaics(taxonomy, { industryTerms: ['pumps'], product: 'pumps', targetCountries: ['US'] }, { allowLlm: false });
  console.log(`   泵 ICP(US, allowLlm:false) → NAICS = [${pumpResolved.naicsCodes.join(',')}]（Codex #1：sweep 确定性路径亦享 seed 别名精修 → 窄码，不再停在广码 333）`);
  ok(pumpResolved.naicsCodes.includes('333914'), 'resolveIcpToNaics 泵 ICP(allowLlm:false) → 确定性精修到窄码 333914（Codex #1，非广码 333）');

  const pumpNarrow = await taxonomy.resolveNaicsForProduct('pumps', ['333'], { allowLlm: false });
  console.log(`   resolveNaicsForProduct('pumps',['333']) = ${pumpNarrow}（seed 别名确定性精修，零 LLM 零成本）`);
  ok(pumpNarrow === '333914', 'seed 别名把 pumps 确定性精修到窄码 333914（Schedule 亦可享，无需 LLM）');

  const euOnly = await resolveIcpToNaics(taxonomy, { industryTerms: ['pumps'], targetCountries: ['DE'] }, { allowLlm: false });
  ok(euOnly.naicsCodes.length === 0 && euOnly.warnings.some((w) => w.includes('icp_fit_warning')), 'US 市场门：EU-only ICP → 零 NAICS（绝不给 EU-only 塞美国联邦数据）');

  const mfg = await resolveIcpToNaics(taxonomy, { industryTerms: MFG_INDUSTRIES, targetCountries: ['US'] }, { allowLlm: false });
  console.log(`   制造多行业 ICP(US) → NAICS 广锚 = [${mfg.naicsCodes.join(',')}]`);
  ok(mfg.naicsCodes.length > 0, '制造多行业 ICP → ≥1 NAICS 广锚（投影用）');

  // ══════════ Tier 1 · 真 CSV（keyless 直打 → 流式过滤 Sources Sought）══════════
  console.log(`\n══ Tier 1 · 真 CSV：keyless 下载 → Sources Sought 近 ${SINCE_DAYS} 天（取最新 ${MAX_RECORDS} 条）══`);
  const notices = await fetchSourcesSought({ sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS });
  console.log(`   拉到 ${notices.length} 条 Sources Sought`);
  for (const n of notices.slice(0, 6)) {
    console.log(`   · [${n.subTier || n.department || '?'}]  NAICS=${n.naicsCode || '—'}  发布=${n.postedDateIso ?? '—'}  «${(n.title || '').slice(0, 48)}»`);
  }
  ok(notices.length > 0, 'Tier 1：真 CSV 返回 ≥1 条 Sources Sought');
  ok(notices.some((n) => !!(n.subTier || n.department)), '至少 1 条有机构买方（intent 承载主体）');
  const withDate = notices.filter((n) => !!n.postedDateIso);
  ok(
    withDate.length > 0 && withDate.every((n) => !Number.isNaN(Date.parse(n.postedDateIso!))),
    `§8.6 每条发布日 ISO 归一后 Date.parse 合法（${withDate.length} 条带发布日）`,
  );
  // 🔴 结构性 PII 隔离：raw adapter 输出序列化后既无邮箱、也无任何具名联系人字段键。
  const serialized = JSON.stringify(notices);
  ok(!/@/.test(serialized), '🔴 Sources Sought 记录里无邮箱（@ 零命中——联系官结构性隔离）');
  ok(!/(primary|secondary)contact|contactname|contactemail|contactphone/i.test(serialized), '🔴 无 PrimaryContact/SecondaryContact 等具名联系人字段（adapter 只读绿列）');

  const naicsDist = topNaicsPrefixes(notices, 2, 8);
  console.log(`   NAICS 2 位前缀分布 top8：${naicsDist.join(' / ') || '—'}`);

  if (!notices.length) {
    console.log('   ⚠️ 本窗无 Sources Sought，跳过 Tier 2-4（非失败，属数据稀疏）');
    return;
  }

  // ══════════ Tier 2 · 真摄取 + 真投影（两层拆开：ingestSam → source_signal → projectSourcesSought 只读）══════════
  console.log('\n══ Tier 2 · 真摄取+投影：seed source_policy(APPROVED) → ingestSam → source_signal → projectSourcesSought ══');
  await new DiscoveryProviderRegistry().seed(ownerDb); // 幂等 upsert：data_provider samgov(DISABLED) + source_policy sam.gov(APPROVED)
  await ownerDb.sourcePolicy.update({ where: { domain: SAM_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {}); // 复位以防上次 Tier 4 遗留
  // ~100MB 整包 CSV 瞬时网络超时约半数 → 重试（新时间窗避账本命中，绝不因单次网络抖动误判管线）。生产 sweep 6h 一次无此压力。
  let ingested = await ingest.ingestSam({ sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS });
  for (let attempt = 1; ingested.error?.includes('timeout') && attempt <= 3; attempt++) {
    console.log(`   ⚠️ 摄取下载超时（大 CSV 瞬时网络），第 ${attempt} 次重试（新窗避账本）…`);
    ingested = await ingest.ingestSam({ sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS }, { nowMs: Date.now() + attempt * ingestWindowMs() });
  }
  console.log(`   ingest: recordsFetched=${ingested.recordsFetched} signalsUpserted=${ingested.signalsUpserted} ledgerHit=${ingested.ledgerHit} window=${ingested.windowKey} skipped=${JSON.stringify(ingested.skipped)}`);
  ok(!ingested.error, `摄取无错（error=${ingested.error ?? '—'}）`);
  ok(ingested.recordsFetched > 0, `摄取层真拉 ${ingested.recordsFetched} 条 Sources Sought → source_signal（ledgerHit=${ingested.ledgerHit}）`);

  // 投影层：只读 source_signal（零出网）→ 本租户 canonical。制造 NAICS 稀疏 → TED 式放宽到实际最常见前缀（仍证管线）。
  let naicsForProjection = mfg.naicsCodes;
  let result = await svc.projectSourcesSought(WS, { naicsCodes: naicsForProjection, sinceDays: SINCE_DAYS });
  if (result.signalsMatched === 0) {
    const fallback = topNaicsPrefixes(notices, 2, 3);
    console.log(`   ⚠️ 制造 NAICS [${naicsForProjection.join(',')}] 本窗无 Sources Sought → 放宽到实际最常见 2 位前缀 [${fallback.join(',')}]（TED 式稀疏放宽，仍证管线）`);
    naicsForProjection = fallback;
    result = await svc.projectSourcesSought(WS, { naicsCodes: naicsForProjection, sinceDays: SINCE_DAYS });
  }
  console.log(`   projection(NAICS=[${naicsForProjection.join(',')}]): signalsMatched=${result.signalsMatched} companiesTouched=${result.companiesTouched} eventsProjected=${result.eventsProjected} subjectsTruncated=${result.subjectsTruncated}`);
  ok(result.signalsMatched > 0, `投影匹配平台表信号 ${result.signalsMatched} 条（NAICS 子树双向前缀过滤，无国别过滤）`);
  ok(result.companiesTouched > 0, `Tier 2：投影 ≥1 家机构买方 canonical（去重后 ${result.companiesTouched} 家）`);
  ok(result.eventsProjected > 0, `US_FED_SOURCES_SOUGHT 事件投影 ${result.eventsProjected} 条`);

  const buyers = await prisma.withWorkspace(WS, (tx) =>
    tx.canonicalCompany.findMany({ where: { workspaceId: WS }, select: { id: true, name: true, country: true, status: true, attributes: true } }),
  );
  console.log(`   落库买方 canonical ${buyers.length} 家；样本：`);
  for (const b of buyers.slice(0, 5)) {
    const intent = (b.attributes as Record<string, unknown> | null)?.intent as { events?: { type: string; at: string }[] } | undefined;
    const ev = intent?.events?.[0];
    console.log(`   · ${b.name} [${b.country ?? '?'}] status=${b.status}  intent[0]=${ev?.type}@${ev?.at}`);
  }
  ok(buyers.length > 0, 'buyer canonical 已落库');
  ok(buyers.every((b) => b.country === 'US'), '每家买方国别恒 US（联邦机构，无 alpha-2 跨境并风险）');
  ok(buyers.every((b) => (b.attributes as Record<string, unknown> | null)?.government_buyer === true), '每家标记 attributes.government_buyer=true（联邦机构买方来源可区分）');
  ok(buyers.every((b) => (b.attributes as Record<string, unknown> | null)?.sam_market_signal === true), '每家标记 sam_market_signal=true（定位=品类需求情报，非可直接成单线索）');
  ok(buyers.every((b) => typeof (b.attributes as Record<string, unknown> | null)?.sam_disclaimer === 'string'), '每家恒置 sam_disclaimer（Sources Sought≠招标/合同 市场信号红线）');

  const eventsFlat = buyers.flatMap((b) => {
    const intent = (b.attributes as Record<string, unknown> | null)?.intent as { events?: { type: string; at: string; strength?: number }[] } | undefined;
    return intent?.events ?? [];
  });
  ok(eventsFlat.length > 0 && eventsFlat.every((e) => e.type === US_FED_SOURCES_SOUGHT), `每条 intent 事件 type=US_FED_SOURCES_SOUGHT（${eventsFlat.length} 条）`);
  ok(eventsFlat.every((e) => !Number.isNaN(Date.parse(e.at))), '§8.6 每条 event.at 经 Date.parse 合法（落库端，喂 recencyDecay 不得 NaN）');
  ok(eventsFlat.every((e) => e.strength === 0.7), '每条 event.strength=0.7（低于 TED 招标 0.9——Sources Sought 早但软）');

  const ev = await prisma.withWorkspace(WS, (tx) =>
    tx.fieldEvidence.findMany({ where: { workspaceId: WS, providerKey: 'samgov' }, select: { license: true, field: true, value: true } }),
  );
  ok(ev.length > 0 && ev.every((e) => e.license === SAM_LICENSE), `field_evidence.license='${SAM_LICENSE}'（${ev.length} 条，公共领域·署名非义务）`);
  ok(ev.some((e) => e.field === 'identity'), '新建买方写了 identity 事实（机构身份 provenance 锚点）');
  ok(ev.some((e) => e.field === 'intent.sources_sought'), 'intent.sources_sought 事实已写（需求证据）');
  ok(!/@/.test(JSON.stringify(ev.map((e) => e.value))), '🔴 field_evidence 里无邮箱（个人数据隔离）');

  // ══════════ Tier 2b · 幂等（同参再投影 → 零改动、不堆行）══════════
  console.log('\n══ Tier 2b · 幂等：同参再跑 projectSourcesSought ══');
  const evBefore = await evidenceCount();
  const rerun = await svc.projectSourcesSought(WS, { naicsCodes: naicsForProjection, sinceDays: SINCE_DAYS });
  const evAfter = await evidenceCount();
  console.log(`   再跑 signalsMatched=${rerun.signalsMatched} companiesTouched=${rerun.companiesTouched} eventsProjected=${rerun.eventsProjected}；field_evidence ${evBefore}→${evAfter}`);
  ok(rerun.companiesTouched === 0 && rerun.eventsProjected === 0, '幂等：同一 Sources Sought 再投影零改动（不 bump version / 不虚报指标）');
  ok(evAfter === evBefore, '幂等：field_evidence 行数不变（不堆重复证据行）');

  // ══════════ Tier 3 · 真评分（Intent 维 0→>0 + demandProof>0，US_FED_SOURCES_SOUGHT 驱动）══════════
  console.log('\n══ Tier 3 · 真评分：scoreLead 买方 canonical，投影前(无 intent) → 后(US_FED_SOURCES_SOUGHT) ══');
  const sample = buyers.find((b) => {
    const intent = (b.attributes as Record<string, unknown> | null)?.intent as { events?: unknown[] } | undefined;
    return (intent?.events?.length ?? 0) > 0;
  });
  if (!sample) {
    ok(false, 'Tier 3：找到带 intent 事件的买方 canonical 用于评分');
  } else {
    const attrsAfter = (sample.attributes as Record<string, unknown> | null) ?? {};
    const { intent: _stripped, ...attrsBefore } = attrsAfter; // 投影前 = 抹掉 intent 命名空间
    const toCompany = (attributes: Record<string, unknown>): CompanyForScoring => ({
      name: sample.name, domain: null, country: sample.country, industry: null,
      employeeCount: null, revenueUsd: null, attributes, status: sample.status, contacts: [],
    });
    const before = scoreLead(toCompany(attrsBefore), icp);
    const after = scoreLead(toCompany(attrsAfter), icp);
    console.log(`   样本买方：${sample.name}`);
    console.log(`   Intent 维    : ${before.scores.intent}  →  ${after.scores.intent}`);
    console.log(`   demandProof  : ${before.scores.demandProof}  →  ${after.scores.demandProof}`);
    console.log(`   命中信号     : ${before.detail.intentSignals.join('/') || '—'}  →  ${after.detail.intentSignals.join('/') || '—'}`);
    console.log(`   总分         : ${before.totalScore}  →  ${after.totalScore}`);
    ok(before.scores.intent === 0, '投影前 Intent 维 = 0（关键词代理不命中买方属性）');
    ok(after.scores.intent > 0, 'Tier 3：投影后 Intent 维 > 0（US_FED_SOURCES_SOUGHT 真驱动，§8.6 日期未失效）');
    ok(after.scores.demandProof > 0, 'demandProof > 0（Sources Sought=买方侧需求证据，同 TED 招标类，P4 拍板）');
    ok(after.detail.intentSignals.includes(US_FED_SOURCES_SOUGHT), 'intentSignals 含 US_FED_SOURCES_SOUGHT（早数月意图真接进六维）');
    ok(after.totalScore > before.totalScore, '总分随 Intent 维上升（Sources Sought 有正贡献）');
  }

  // ══════════ Tier 4 · §8.8 负向门（摄取层：SUSPENDED → fail-closed，不发请求）══════════
  console.log('\n══ Tier 4 · §8.8 负向门（摄取层）：source_policy 置 SUSPENDED → ingestSam 不直连 ══');
  await ownerDb.sourcePolicy.update({ where: { domain: SAM_DOMAIN }, data: { reviewStatus: 'SUSPENDED' } });
  // 新时间窗（+1 窗宽）避开 Tier 2 的 OK 账本行——账本命中会不出网、根本测不到门。
  const gated = await ingest.ingestSam({ sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS }, { nowMs: Date.now() + ingestWindowMs() });
  ok(!!gated.error && gated.signalsUpserted === 0, `§8.8 SUSPENDED → 摄取层 fail-closed（error=${gated.error ?? '—'}，零落库、不发请求；投影层零出网——门在摄取层）`);
  await ownerDb.sourcePolicy.update({ where: { domain: SAM_DOMAIN }, data: { reviewStatus: 'APPROVED' } });
}

try {
  await main();
} finally {
  // 复位 source_policy（防 Tier 4 遗留 SUSPENDED）+ 清理本 WS（owner 绕 RLS，field_evidence 无 FK 手动删）
  await ownerDb.sourcePolicy.update({ where: { domain: SAM_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {});
  await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  // 删本脚本产生的 signal_ingest 账本行（SAM 指纹 NAICS 无关=单指纹，含 Tier 4 未来窗 ERROR 行）——
  // 防旧 OK 账本行让下次真跑账本命中不出网。source_signal 行保留（平台事实，非本脚本私有，同 TED verify）。
  const samFingerprint = queryFingerprint(canonicalSamSpec({ sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS }));
  await ownerDb.signalIngest.deleteMany({ where: { providerKey: 'samgov', queryFingerprint: samFingerprint } }).catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
