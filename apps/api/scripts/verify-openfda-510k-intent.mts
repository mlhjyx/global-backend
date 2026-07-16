/**
 * openFDA P3 · 510(k) 清关 → FDA_CLEARANCE Intent 投影 —— 真实数据端到端（真库真 API，无 sandbox，AGENTS.md §5）。
 * 收口⑤两层架构：**平台摄取**（SignalIngestService → source_signal 一等事实 + signal_ingest 账本，
 * ingest-once）+ **投影只读平台表**（OpenFdaIntentProjectionService 不再出网）。
 * 需 postgres 在跑（gateway 不需要——本链路不过 fit 门，Intent 维为确定性计算）。
 * 真 ICP：AI 放射影像诊断软件（product code QAS，近 1 年 US/IN/TW 多国具名申请人清关）。
 * 方向 = **具名申请人清关 = 新品/上市时机信号**（镜像 TED 招标 = 买方需求）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-openfda-510k-intent.mts
 *
 * 五段证明（有界样本，绝不 grind 17 万全量）：
 *   Tier 1 · 真 API：search510kClearances 直打 device/510k → 真清关（申请人 + 产品码 + 决定日）+ §8.6 每条
 *            decisionDateIso 经 Date.parse 合法 + 每条 decision_code 为正向清关（NSE 已过滤）+ 合规自检（无邮箱/contact）。
 *   Tier 2 · 真摄取+投影：seed source_policy(APPROVED) → ingestFda（经 Broker 过 §8.8 门 → source_signal
 *            平台表 + signal_ingest 账本）→ projectClearances（**只读平台表**）→ 申请人 canonical +
 *            attributes.intent.FDA_CLEARANCE + attributes.fda.disclaimer（注册≠核准）+ field_evidence（CC0-1.0/无邮箱）。
 *   Tier 2b· 幂等：同参再投影 → companiesTouched=0 / eventsProjected=0，field_evidence 行数不变（不堆行/不虚报）。
 *   Tier 3 · 真评分：scoreLead → Intent 维 0（投影前）→ >0（后，FDA_CLEARANCE 驱动），signals 含 FDA_CLEARANCE。
 *   Tier 4 · §8.8 负向门（**摄取层**）：source_policy 置 SUSPENDED → ingestFda（新时间窗避开账本命中）
 *            fail-closed（error 非空、signalsUpserted=0，不发请求）。投影层零出网——门在摄取层。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { search510kClearances, isClearedDecision } from '../src/adapters/openfda-api';
import { SignalIngestService } from '../src/signals/signal-ingest.service';
import { canonicalFdaSpec, queryFingerprint, ingestWindowMs } from '../src/signals/signal-query';
import { OpenFdaIntentProjectionService, FDA_CLEARANCE } from '../src/intent/openfda-intent-projection.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // 一次性验证 workspace
const PRODUCT_CODES = ['QAS']; // AI 放射影像诊断/分诊软件（近 1 年多国具名申请人清关）
const SINCE_DAYS_CANDIDATES = [365, 730]; // 主窗 365；数据稀疏放宽 730（清理段两个指纹都删）
let SINCE_DAYS = 365;
const MAX_RECORDS = 100;
const FDA_DOMAIN = 'api.fda.gov';

// intent 事件的关键词代理绝不命中（证明 Intent 分纯由 FDA_CLEARANCE 驱动，非关键词兜底）
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
// §8.8（收口⑤）：出网收敛在**摄取层**——SignalIngestService 经 ToolBroker 过 source_policy 门（无 broker =
// fail-closed 不出网）；投影 service 只收 prisma（只读 source_signal 平台表，零出网）。
const ingest = new SignalIngestService({ prisma, broker: buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) }) });
const svc = new OpenFdaIntentProjectionService({ prisma });

const evidenceCount = () =>
  prisma.withWorkspace(WS, (tx) => tx.fieldEvidence.count({ where: { workspaceId: WS, providerKey: 'openfda' } }));

async function main() {
  // ══════════ Tier 1 · 真 API（直打 device/510k 清关）══════════
  console.log(`\n══ Tier 1 · 真 API：AI 放射软件(product code ${PRODUCT_CODES.join(',')}) 近 ${SINCE_DAYS} 天清关 ══`);
  let clearances = await search510kClearances({ productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS, clearedOnly: true });
  if (!clearances.length) {
    SINCE_DAYS = 730;
    console.log(`   ⚠️ 近 365 天无清关（数据稀疏），放宽到 ${SINCE_DAYS} 天再拉一次`);
    clearances = await search510kClearances({ productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS, clearedOnly: true });
  }
  console.log(`   拉到 ${clearances.length} 条正向清关`);
  for (const c of clearances.slice(0, 8)) {
    console.log(`   · ${c.applicant}  [${c.country ?? '?'}]  决定日=${c.decisionDateIso ?? '—'}  码=${c.productCode ?? '—'}/${c.decisionCode ?? '—'}`);
  }
  ok(clearances.length > 0, 'Tier 1：真 API 返回 ≥1 条清关');
  ok(clearances.some((c) => !!c.applicant), '至少 1 条有申请人（intent 承载主体）');
  ok(clearances.every((c) => !!c.decisionDateIso && !Number.isNaN(Date.parse(c.decisionDateIso!))), '§8.6 每条决定日 ISO 归一后 Date.parse 合法');
  ok(clearances.every((c) => isClearedDecision(c.decisionCode)), `§8.6 每条 decision_code 为正向清关（NSE/被拒已过滤；${clearances.length} 条）`);
  const serialized = JSON.stringify(clearances);
  ok(!/@/.test(serialized) && !/"?contact"?\s*:/i.test(serialized) && !/us_agent/i.test(serialized), '🔴 清关记录里无邮箱/contact/us_agent（个人数据隔离）');

  if (!clearances.length) {
    console.log('   ⚠️ 无近期清关，跳过 Tier 2-4（非失败，属数据稀疏）');
    return;
  }

  // ══════════ Tier 2 · 真摄取 + 真投影（两层拆开：ingestFda → source_signal → projectClearances 只读）══════════
  console.log('\n══ Tier 2 · 真摄取+投影：seed source_policy(APPROVED) → ingestFda → source_signal → projectClearances ══');
  await new DiscoveryProviderRegistry().seed(ownerDb); // 幂等 upsert：data_provider openfda + source_policy(APPROVED)
  await ownerDb.sourcePolicy.update({ where: { domain: FDA_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {}); // 复位以防上次 Tier 4 遗留
  // 摄取层：经 Broker 过 §8.8 门 → source_signal 平台表（Tier 1 已选定 SINCE_DAYS——数据稀疏放宽逻辑在 Tier 1）。
  const ingested = await ingest.ingestFda({ productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS });
  console.log(`   ingest: recordsFetched=${ingested.recordsFetched} signalsUpserted=${ingested.signalsUpserted} ledgerHit=${ingested.ledgerHit} window=${ingested.windowKey} skipped=${JSON.stringify(ingested.skipped)}`);
  ok(!ingested.error, `摄取无错（error=${ingested.error ?? '—'}）`);
  ok(ingested.recordsFetched > 0, `摄取层真拉 ${ingested.recordsFetched} 条清关 → source_signal（ledgerHit=${ingested.ledgerHit}）`);
  // 投影层：只读 source_signal（零出网）→ 本租户 canonical。
  const result = await svc.projectClearances(WS, { productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS });
  console.log(`   projection: signalsMatched=${result.signalsMatched} companiesTouched=${result.companiesTouched} eventsProjected=${result.eventsProjected} skippedIndividual=${result.skippedIndividual}`);
  ok(result.signalsMatched > 0, `投影匹配平台表信号 ${result.signalsMatched} 条（'fda:码' 精确过滤）`);
  ok(result.companiesTouched > 0, `Tier 2：投影 ≥1 家申请人 canonical（去重后 ${result.companiesTouched} 家）`);
  ok(result.eventsProjected > 0, `FDA_CLEARANCE 事件投影 ${result.eventsProjected} 条`);

  const applicants = await prisma.withWorkspace(WS, (tx) =>
    tx.canonicalCompany.findMany({ where: { workspaceId: WS }, select: { id: true, name: true, country: true, status: true, attributes: true } }),
  );
  console.log(`   落库申请人 canonical ${applicants.length} 家；样本：`);
  for (const a of applicants.slice(0, 5)) {
    const attrs = (a.attributes as Record<string, unknown> | null) ?? {};
    const intent = attrs.intent as { events?: { type: string; at: string }[] } | undefined;
    const ev = intent?.events?.[0];
    console.log(`   · ${a.name} [${a.country ?? '?'}] status=${a.status}  intent[0]=${ev?.type}@${ev?.at}`);
  }
  ok(applicants.length > 0, 'applicant canonical 已落库');
  ok(applicants.every((a) => (a.attributes as Record<string, unknown> | null)?.fda_applicant === true), '每家标记 attributes.fda_applicant=true（510k 申请人来源可区分）');
  ok(applicants.every((a) => !!a.country && a.country.length === 2), '每家申请人国别为 alpha-2（§8.4；无国别已跳过，绝不 name-only 跨国并）');
  ok(applicants.every((a) => {
    const fda = (a.attributes as Record<string, unknown> | null)?.fda as Record<string, unknown> | undefined;
    return typeof fda?.disclaimer === 'string' && (fda.disclaimer as string).length > 0;
  }), '每家带 attributes.fda.disclaimer（注册/清关≠核准 文案红线）');

  const eventsFlat = applicants.flatMap((a) => {
    const intent = (a.attributes as Record<string, unknown> | null)?.intent as { events?: { type: string; at: string }[] } | undefined;
    return intent?.events ?? [];
  });
  ok(eventsFlat.length > 0 && eventsFlat.every((e) => e.type === FDA_CLEARANCE), `每条 intent 事件 type=FDA_CLEARANCE（${eventsFlat.length} 条）`);
  ok(eventsFlat.every((e) => !Number.isNaN(Date.parse(e.at))), '§8.6 每条 event.at 经 Date.parse 合法（落库端，喂 recencyDecay 不得 NaN）');

  const ev = await prisma.withWorkspace(WS, (tx) =>
    tx.fieldEvidence.findMany({ where: { workspaceId: WS, providerKey: 'openfda' }, select: { license: true, field: true, value: true } }),
  );
  ok(ev.length > 0 && ev.every((e) => e.license === 'CC0-1.0'), `field_evidence.license='CC0-1.0'（${ev.length} 条，CC0 署名非义务但存 provenance）`);
  ok(ev.some((e) => e.field === 'identity'), '新建申请人写了 identity provenance 证据（CC0）');
  ok(!/@/.test(JSON.stringify(ev.map((e) => e.value))), '🔴 field_evidence 里无邮箱（个人数据隔离）');

  // ══════════ Tier 2b · 幂等（同参再投影 → 零改动、不堆行）══════════
  console.log('\n══ Tier 2b · 幂等：同参再跑 projectClearances ══');
  const evBefore = await evidenceCount();
  const rerun = await svc.projectClearances(WS, { productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS });
  const evAfter = await evidenceCount();
  console.log(`   再跑 signalsMatched=${rerun.signalsMatched} companiesTouched=${rerun.companiesTouched} eventsProjected=${rerun.eventsProjected}；field_evidence ${evBefore}→${evAfter}`);
  ok(rerun.companiesTouched === 0 && rerun.eventsProjected === 0, '幂等：同一清关再投影零改动（不 bump version / 不虚报指标）');
  ok(evAfter === evBefore, '幂等：field_evidence 行数不变（不堆重复证据行）');

  // ══════════ Tier 3 · 真评分（Intent 维 0 → >0，FDA_CLEARANCE 驱动）══════════
  console.log('\n══ Tier 3 · 真评分：scoreLead 申请人 canonical，投影前(无 intent) → 后(FDA_CLEARANCE) ══');
  const sample = applicants.find((a) => {
    const intent = (a.attributes as Record<string, unknown> | null)?.intent as { events?: unknown[] } | undefined;
    return (intent?.events?.length ?? 0) > 0;
  });
  if (!sample) {
    ok(false, 'Tier 3：找到带 intent 事件的申请人 canonical 用于评分');
  } else {
    const attrsAfter = (sample.attributes as Record<string, unknown> | null) ?? {};
    const { intent: _stripped, ...attrsBefore } = attrsAfter; // 投影前 = 抹掉 intent 命名空间
    const toCompany = (attributes: Record<string, unknown>): CompanyForScoring => ({
      name: sample.name, domain: null, country: sample.country, industry: null,
      employeeCount: null, revenueUsd: null, attributes, status: sample.status, contacts: [],
    });
    const before = scoreLead(toCompany(attrsBefore), icp);
    const after = scoreLead(toCompany(attrsAfter), icp);
    console.log(`   样本申请人：${sample.name}`);
    console.log(`   Intent 维 : ${before.scores.intent}  →  ${after.scores.intent}`);
    console.log(`   命中信号  : ${before.detail.intentSignals.join('/') || '—'}  →  ${after.detail.intentSignals.join('/') || '—'}`);
    console.log(`   总分      : ${before.totalScore}  →  ${after.totalScore}`);
    console.log(`   来源标注  : ${after.detail.notes.find((n) => n.includes('Intent')) ?? ''}`);
    ok(before.scores.intent === 0, '投影前 Intent 维 = 0（关键词代理不命中申请人属性）');
    ok(after.scores.intent > 0, 'Tier 3：投影后 Intent 维 > 0（FDA_CLEARANCE 真驱动，§8.6 日期未失效）');
    ok(after.detail.intentSignals.includes(FDA_CLEARANCE), 'intentSignals 含 FDA_CLEARANCE（清关→时机信号真接进六维）');
    ok(after.totalScore > before.totalScore, '总分随 Intent 维上升（清关信号有正贡献）');
  }

  // ══════════ Tier 4 · §8.8 负向门（摄取层：SUSPENDED → fail-closed，不发请求）══════════
  console.log('\n══ Tier 4 · §8.8 负向门（摄取层）：source_policy 置 SUSPENDED → ingestFda 不直连 ══');
  await ownerDb.sourcePolicy.update({ where: { domain: FDA_DOMAIN }, data: { reviewStatus: 'SUSPENDED' } });
  // 新时间窗（+1 窗宽）避开 Tier 2 的 OK 账本行——账本命中会不出网、根本测不到门。
  const gated = await ingest.ingestFda(
    { productCodes: PRODUCT_CODES, sinceDays: SINCE_DAYS, maxRecords: MAX_RECORDS },
    { nowMs: Date.now() + ingestWindowMs() },
  );
  ok(!!gated.error && gated.signalsUpserted === 0, `§8.8 SUSPENDED → 摄取层 fail-closed（error=${gated.error ?? '—'}，零落库、不发请求；投影层零出网——门在摄取层）`);
  await ownerDb.sourcePolicy.update({ where: { domain: FDA_DOMAIN }, data: { reviewStatus: 'APPROVED' } });
}

try {
  await main();
} finally {
  // 复位 source_policy（防 Tier 4 遗留 SUSPENDED 影响后续）+ 清理本 WS（owner 绕 RLS，field_evidence 无 FK 手动删）
  await ownerDb.sourcePolicy.update({ where: { domain: FDA_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {});
  await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  // 删本脚本产生的 signal_ingest 账本行（365/730 两个候选窗宽 × 全部时间窗，含 Tier 4 未来窗 ERROR 行）——
  // 防旧 OK 账本行让下次真跑账本命中不出网。source_signal 行保留（平台事实，非本脚本私有）。
  const fdaFingerprints = SINCE_DAYS_CANDIDATES.map((d) =>
    queryFingerprint(canonicalFdaSpec({ productCodes: PRODUCT_CODES, sinceDays: d, maxRecords: MAX_RECORDS })),
  );
  await ownerDb.signalIngest.deleteMany({ where: { providerKey: 'openfda', queryFingerprint: { in: fdaFingerprints } } }).catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
