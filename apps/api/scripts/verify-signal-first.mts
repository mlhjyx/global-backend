/**
 * 收口⑤「一等 Signal + ingest-once」真实数据端到端验收（真库真 API，无 sandbox，CLAUDE.md §5）。
 * 验收三条（release-plan §1 ⑤）：
 *   ① 同一外部源同一时间窗**跨 workspace 只拉取一次**（signal_ingest 账本 + ledgerHit）；
 *   ② 信号可过期（expireStale → EXPIRED → 投影/复算剔除）/ 可撤回（revoke）；
 *   ③ 信号可复算（recomputeCompany 从 source_signal 确定性重建 attributes.intent）+ 可 backtest
 *（双时间轴 occurred/observed 落库）。外加：快照 demand_proof 端到端（scoreLead → snapshot → ajv v1）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-signal-first.mts
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { SignalIngestService } from '../src/signals/signal-ingest.service';
import { canonicalTedSpec, canonicalFdaSpec, queryFingerprint } from '../src/signals/signal-query';
import { IntentRecomputeService } from '../src/signals/intent-recompute.service';
import { TedIntentProjectionService, TENDER_PUBLISHED } from '../src/intent/ted-intent-projection.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';
import { buildLeadQualifiedSnapshot } from '../src/lead/lead-qualified-snapshot';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // 一次性验证 workspace A
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 一次性验证 workspace B（跨租户共享拉取的对照）
const WS_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccc55'; // 状态机剔除断言用
const CPV = '42120000'; // 泵与压缩机
const PRIMARY_COUNTRIES = ['DEU'];
const WIDE_COUNTRIES = ['DEU', 'FRA', 'ITA', 'ESP', 'NLD', 'BEL', 'AUT', 'POL'];
const SINCE_DAYS = 90;
const TED_DOMAIN = 'api.ted.europa.eu';

const icp: IcpForScoring = {
  rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'public_administration' }],
  triggerSignals: ['扩产', 'new production line'], // 关键词代理绝不命中买方属性（证明分数纯由信号驱动）
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

// RLS 验证有效性守卫（memory: rls-verify-app-user）：app 连接必须非 superuser，否则投影侧 RLS 证明失效。
const su = await prisma.$queryRaw<{ usesuper: boolean }[]>`SELECT usesuper FROM pg_user WHERE usename = current_user`;
if (su[0]?.usesuper) {
  console.error('❌ APP_DATABASE_URL 连接是 superuser——RLS 证明失效，请用 app_user 跑本脚本');
  process.exit(1);
}

const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const ingest = new SignalIngestService({ prisma, broker });
const tedProj = new TedIntentProjectionService({ prisma });
const recompute = new IntentRecomputeService({ prisma });

const startAt = new Date();
let countries = PRIMARY_COUNTRIES;
const fpOf = (c: string[]) => queryFingerprint(canonicalTedSpec({ cpvCodes: [CPV], buyerCountries: c, sinceDays: SINCE_DAYS }));
const mutatedSignals: { id: string; status: string; expiresAt: Date; revokedAt: Date | null; subjectName: string; payload: unknown }[] = [];

async function main() {
  // ══════════ 前置：seed 治理表 + 清本指纹账本（保证真拉）+ 清租户遗留 ══════════
  await new DiscoveryProviderRegistry().seed(ownerDb);
  await ownerDb.sourcePolicy.update({ where: { domain: TED_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {});
  await ownerDb.signalIngest.deleteMany({ where: { queryFingerprint: { in: [fpOf(PRIMARY_COUNTRIES), fpOf(WIDE_COUNTRIES)] } } });
  for (const ws of [WS_A, WS_B, WS_C]) {
    await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: ws } });
    await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: ws } });
  }

  // ══════════ A · ingest-once：同源同参同窗只拉一次 ══════════
  console.log(`\n══ A · ingest-once：TED 泵(CPV ${CPV})，同指纹同窗第二次摄取不出网 ══`);
  let r1 = await ingest.ingestTed({ cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS });
  if (!r1.error && r1.recordsFetched === 0) {
    console.log('   ⚠️ 泵+德国近 90 天无开放招标（数据稀疏），放宽到欧盟主力国');
    countries = WIDE_COUNTRIES;
    r1 = await ingest.ingestTed({ cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS });
  }
  console.log(`   首拉：records=${r1.recordsFetched} signals=${r1.signalsUpserted} ledgerHit=${r1.ledgerHit} window=${r1.windowKey} skipped=${JSON.stringify(r1.skipped)}`);
  ok(!r1.error, `首拉无错（${r1.error ?? 'ok'}）`);
  ok(!r1.ledgerHit && r1.recordsFetched > 0, `A1：真 API 拉到 ${r1.recordsFetched} 条招标`);
  ok(r1.signalsUpserted > 0, `A2：source_signal 落 ${r1.signalsUpserted} 行（一等事实）`);

  const r2 = await ingest.ingestTed({ cpvCodes: [CPV], buyerCountries: [...countries].reverse(), sinceDays: SINCE_DAYS });
  ok(r2.ledgerHit, 'A3：同参（乱序容忍）同窗第二次摄取 → 账本命中，不出网（ingest-once 核心）');
  const ledgerRows = await ownerDb.signalIngest.count({ where: { queryFingerprint: fpOf(countries), windowKey: r1.windowKey } });
  ok(ledgerRows === 1, 'A4：signal_ingest 该 (指纹,窗口) 恰 1 行（拉取键与 workspace 无关 → 跨租户天然共享）');

  // 按 observedAt 过滤（重跑时信号行已存在：幂等 upsert 只前移 observedAt，createdAt 不变——脚本须可重跑）
  const signals = await ownerDb.sourceSignal.findMany({
    where: { providerKey: 'ted', signalType: TENDER_PUBLISHED, status: 'ACTIVE', observedAt: { gte: new Date(startAt.getTime() - 1000) } },
    orderBy: { occurredAt: 'desc' },
  });
  ok(signals.length > 0, `A5：本轮观测信号 ${signals.length} 行（幂等 upsert：复现行前移 observedAt）`);
  ok(signals.every((s) => s.occurredAt.getTime() <= s.observedAt.getTime() + 1000), 'A6：双时间轴 occurredAt ≤ observedAt（backtest 基础）');
  ok(signals.every((s) => s.subjectCountry.length === 2), 'A7：主体国别 alpha-2（§8.4）');
  const payloadStr = JSON.stringify(signals.map((s) => s.payload));
  ok(!/@/.test(payloadStr) && !/email|contact/i.test(payloadStr), '🔴 A8：payload 零个人数据（平台绿库红线）');

  // ══════════ B · 两租户两层投影：共享同一批平台信号，零新增拉取 ══════════
  console.log('\n══ B · 两租户投影：WS_A 与 WS_B 各自 projectTenders（只读 source_signal）══');
  const params = { cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS };
  const pa = await tedProj.projectTenders(WS_A, params);
  const pb = await tedProj.projectTenders(WS_B, params);
  console.log(`   WS_A: matched=${pa.signalsMatched} touched=${pa.companiesTouched}；WS_B: matched=${pb.signalsMatched} touched=${pb.companiesTouched}`);
  ok(pa.companiesTouched > 0 && pb.companiesTouched > 0, 'B1：两个 workspace 各自投影出买方 canonical（两层：平台一份事实 → 租户各自投影）');
  const ledgerAfterProj = await ownerDb.signalIngest.count({ where: { queryFingerprint: fpOf(countries) } });
  ok(ledgerAfterProj === 1, 'B2：投影零出网（signal_ingest 行数不变）——收口⑤验收①达成');

  const buyersA = await prisma.withWorkspace(WS_A, (tx) =>
    tx.canonicalCompany.findMany({ where: { workspaceId: WS_A }, select: { id: true, name: true, country: true, dedupeKey: true, status: true, attributes: true } }),
  );
  const evA = await prisma.withWorkspace(WS_A, (tx) =>
    tx.fieldEvidence.findMany({ where: { workspaceId: WS_A, providerKey: 'ted' }, select: { license: true, field: true } }),
  );
  ok(buyersA.every((b) => (b.attributes as Record<string, unknown>).ted_buyer === true), 'B3：attributes.ted_buyer 标记保留');
  ok(evA.length > 0 && evA.every((e) => e.license === 'CC BY 4.0') && evA.some((e) => e.field === 'identity'), `B4：CC BY 4.0 署名义务在租户投影侧履行（${evA.length} 行，含 identity）`);
  const rerun = await tedProj.projectTenders(WS_A, params);
  ok(rerun.companiesTouched === 0, 'B5：幂等——同信号再投影零改动（不 bump version / 不堆证据）');

  // ══════════ C · 状态机：过期/撤回 → 投影剔除 ══════════
  console.log('\n══ C · 状态机：expireStale → EXPIRED；revoke → REVOKED；投影绝不吃 ══');
  // 过期**该主体的全部信号**——同买方常有多条招标，只过期一条则其余 ACTIVE 信号仍会把主体投进来（C3 前提）。
  const victim = signals[0];
  const victimRows = signals.filter((s) => s.subjectKey === victim.subjectKey);
  const second = signals.find((s) => s.subjectKey !== victim.subjectKey);
  for (const row of victimRows) {
    mutatedSignals.push({ id: row.id, status: row.status, expiresAt: row.expiresAt, revokedAt: row.revokedAt, subjectName: row.subjectName, payload: row.payload });
    await ownerDb.sourceSignal.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  }
  const expired = await ingest.expireStale();
  const victimAfter = await ownerDb.sourceSignal.findUnique({ where: { id: victim.id } });
  ok(expired >= victimRows.length && victimAfter?.status === 'EXPIRED', `C1：expireStale 翻转 ${expired} 行 → EXPIRED（状态机 ACTIVE→EXPIRED，主体全 ${victimRows.length} 行）`);

  if (second) {
    mutatedSignals.push({ id: second.id, status: second.status, expiresAt: second.expiresAt, revokedAt: second.revokedAt, subjectName: second.subjectName, payload: second.payload });
    await ingest.revoke(second.id);
    const secondAfter = await ownerDb.sourceSignal.findUnique({ where: { id: second.id } });
    ok(secondAfter?.status === 'REVOKED' && !!secondAfter?.revokedAt, 'C2：revoke → REVOKED + revokedAt（合规撤回入口）');
    ok(secondAfter?.subjectName === 'REDACTED' && JSON.stringify(secondAfter?.payload) === '{}', 'C2b：撤即脱敏（subjectName 占位 + payload 清空——Art.17 擦除路径）');
  } else {
    console.log('   ⚠️ 仅 1 个主体，跳过 C2 revoke 断言（非失败）');
  }

  await tedProj.projectTenders(WS_C, params);
  const victimInC = await prisma.withWorkspace(WS_C, (tx) =>
    tx.canonicalCompany.findUnique({ where: { workspaceId_dedupeKey: { workspaceId: WS_C, dedupeKey: victim.subjectKey } } }),
  );
  ok(!victimInC, 'C3：EXPIRED 信号的主体在新租户投影中被剔除（过期信号绝不再投）——收口⑤验收②达成');

  // ══════════ D · 可复算：清空投影 → recompute 从一等信号重建 ══════════
  console.log('\n══ D · 可复算：抹掉 WS_A 某买方 attributes.intent → recomputeCompany 重建 ══');
  const aliveKeys = new Set(
    (await ownerDb.sourceSignal.findMany({ where: { providerKey: 'ted', status: 'ACTIVE' }, select: { subjectKey: true } })).map((s) => s.subjectKey),
  );
  const target = buyersA.find((b) => aliveKeys.has(b.dedupeKey));
  if (!target) {
    ok(false, 'D0：找到仍有 ACTIVE 信号的买方（样本被 C 段全部过期/撤回属数据过稀）');
  } else {
    const attrs = (target.attributes as Record<string, unknown>) ?? {};
    const intentBefore = JSON.stringify(attrs.intent ?? null);
    const { intent: _drop, ...wiped } = attrs;
    await ownerDb.canonicalCompany.update({ where: { id: target.id }, data: { attributes: wiped as never } });
    // 复算必须重放与增量投影同一过滤面（对抗复审 HIGH）：surfaces=本 workspace ICP 的解析结果。
    const surfaces = [{ provider: 'ted' as const, cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS }];
    const outcome = await recompute.recomputeCompany(WS_A, target.id, { surfaces });
    const rebuilt = await prisma.withWorkspace(WS_A, (tx) =>
      tx.canonicalCompany.findUnique({ where: { id: target.id }, select: { attributes: true } }),
    );
    const rebuiltIntent = (rebuilt?.attributes as Record<string, unknown>)?.intent as { events?: { type: string; at: string }[] } | undefined;
    console.log(`   outcome=${outcome} events=${rebuiltIntent?.events?.length ?? 0} first=${rebuiltIntent?.events?.[0]?.type}@${rebuiltIntent?.events?.[0]?.at}`);
    ok(outcome === 'rebuilt', 'D1：recomputeCompany=rebuilt（投影可从一等事实确定性重建）——收口⑤验收③达成');
    ok((rebuiltIntent?.events ?? []).some((e) => e.type === TENDER_PUBLISHED), 'D2：重建出 TENDER_PUBLISHED 事件');
    ok(intentBefore !== 'null', 'D3：（对照）原投影存在，重建非无中生有');
    ok((await recompute.recomputeCompany(WS_A, target.id, { surfaces })) === 'unchanged', 'D4：再复算 unchanged（复算幂等，与增量投影同过滤面 → 有公共不动点）');

    // ══════════ E · demand_proof 端到端：评分 → 快照 → ajv v1 ══════════
    console.log('\n══ E · demand_proof：scoreLead → LeadQualified 快照 → ajv v1 契约 ══');
    const co: CompanyForScoring = {
      name: target.name, domain: null, country: target.country, industry: null, employeeCount: null,
      revenueUsd: null, attributes: (rebuilt?.attributes as Record<string, unknown>) ?? {}, status: target.status, contacts: [],
    };
    const score = scoreLead(co, icp);
    console.log(`   demandProof=${score.scores.demandProof} intent=${score.scores.intent} total=${score.totalScore}`);
    ok(score.scores.demandProof > 0, 'E1：demandProof 观测维 > 0（TENDER_PUBLISHED 需求证据驱动）');
    const sixDim =
      0.35 * score.scores.fit + 0.15 * score.scores.role + 0.15 * score.scores.intent +
      0.15 * score.scores.dataQuality + 0.15 * score.scores.reachability + 0.05 * score.scores.engagement;
    ok(Math.abs(score.totalScore - Number(sixDim.toFixed(4))) < 1e-9, 'E2：总分=六维加权和（demandProof 不入总分，乘法门待 backtest）');

    const snap = buildLeadQualifiedSnapshot({
      lead: {
        id: '00000000-0000-4000-8000-000000000001', workspaceId: WS_A, icpId: '00000000-0000-4000-8000-000000000002',
        fitVerdict: 'match', totalScore: score.totalScore, scores: score.scores, scoreDetail: score.detail, fitReasons: null,
      },
      icpVersion: 1,
      company: { id: target.id, name: target.name, domain: null, country: target.country, status: target.status, attributes: rebuilt?.attributes, contacts: [] },
    });
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(new URL('../../../packages/contracts/events/payloads/lead-qualified.v1.schema.json', import.meta.url), 'utf8'),
    );
    const validate = ajv.compile(schema);
    const valid = validate(snap);
    console.log(`   snapshot.scores.demand_proof=${snap.scores.demand_proof} rule=${snap.qualification_rule_version}`);
    ok(valid === true, `E3：快照过 v1 契约（demand_proof 槽位预留 → 零破坏填充；errors=${JSON.stringify(validate.errors ?? null)}）`);
    ok(snap.scores.demand_proof !== null && snap.scores.demand_proof! > 0, 'E4：快照 demand_proof 已填真值（收口⑤快照升级达成）');
    ok(snap.qualification_rule_version === 'additive-6dim-v2', 'E5：qualification_rule_version=additive-6dim-v2（消费者可区分）');
  }

  // ══════════ F · openFDA 摄取 smoke（同构管线真 API）══════════
  console.log('\n══ F · openFDA ingest smoke（LLZ 放射软件近 1 年清关）══');
  await ownerDb.signalIngest.deleteMany({ where: { queryFingerprint: queryFingerprint(canonicalFdaSpec({ productCodes: ['LLZ'] })) } });
  const rf = await ingest.ingestFda({ productCodes: ['LLZ'] });
  console.log(`   records=${rf.recordsFetched} signals=${rf.signalsUpserted} skipped=${JSON.stringify(rf.skipped)} err=${rf.error ?? '—'}`);
  ok(!rf.error, 'F1：openFDA 摄取无错（同一 ingest-once 管线）');
  if (rf.signalsUpserted > 0) {
    const fdaSignals = await ownerDb.sourceSignal.findMany({ where: { providerKey: 'openfda', createdAt: { gte: startAt } }, take: 20 });
    ok(!/@|us_agent|contact/i.test(JSON.stringify(fdaSignals.map((s) => s.payload))), '🔴 F2：FDA payload 零个人数据（contact/us_agent 摄取层拒收）');
  }
}

try {
  await main();
} finally {
  // 复位与清理：恢复被状态机试验改动的信号行 → 删验证租户产物 → 删本指纹账本行（下次真拉）。source_signal 事实保留。
  for (const m of mutatedSignals) {
    await ownerDb.sourceSignal
      .update({ where: { id: m.id }, data: { status: m.status, expiresAt: m.expiresAt, revokedAt: m.revokedAt, subjectName: m.subjectName, payload: m.payload as never } })
      .catch(() => {});
  }
  await ownerDb.sourcePolicy.update({ where: { domain: TED_DOMAIN }, data: { reviewStatus: 'APPROVED' } }).catch(() => {});
  for (const ws of [WS_A, WS_B, WS_C]) {
    await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
    await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  }
  await ownerDb.signalIngest
    .deleteMany({ where: { queryFingerprint: { in: [fpOf(PRIMARY_COUNTRIES), fpOf(WIDE_COUNTRIES), queryFingerprint(canonicalFdaSpec({ productCodes: ['LLZ'] }))] } } })
    .catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
