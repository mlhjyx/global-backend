/**
 * TED P3 招标公告 → Intent 投影 —— 真实数据端到端（真库真 API，无 sandbox，CLAUDE.md §5）。
 * 需 postgres 在跑（gateway 不需要——本链路不过 fit 门，Intent 维为确定性计算）。
 * 一个真 ICP：泵采购买方 + 欧盟 → CPV 42120000（泵与压缩机）。方向 = **招标公告 = 买方需求**。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-ted-intent.mts
 *
 * 三段证明（有界样本，绝不 grind 全量）：
 *   Tier 1 · 真 API：searchContractNotices 直打 TED cn-standard → 真开放招标（买方 + CPV + 发布日）+
 *            §8.6 每条 publicationDateIso 经 Date.parse 合法（否则 recencyDecay=0 → Intent 不得分）+
 *            合规自检（招标事实记录**绝不含具名邮箱/联系点**）。
 *   Tier 2 · 真投影：projectTenders → 买方 canonical（有则更新、无则建线索）+
 *            attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength}] +
 *            field_evidence（CC BY 4.0 署名、providerKey=ted、无邮箱）。
 *   Tier 3 · 真评分：scoreLead 对买方 canonical → Intent 维 0（投影前）→ >0（投影后，TENDER_PUBLISHED 驱动），
 *            intentSignals 含 TENDER_PUBLISHED。证明「招标→时机信号」真接进六维。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { searchContractNotices } from '../src/adapters/ted-api';
import { TedIntentProjectionService, TENDER_PUBLISHED } from '../src/intent/ted-intent-projection.service';
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // 一次性验证 workspace
const CPV = '42120000'; // 泵与压缩机
const PRIMARY_COUNTRIES = ['DEU']; // 真 ICP：泵 + 德国
const WIDE_COUNTRIES = ['DEU', 'FRA', 'ITA', 'ESP', 'NLD', 'BEL', 'AUT', 'POL']; // 数据稀疏时放宽到欧盟主力
const SINCE_DAYS = 90;

// intent 事件的关键词代理绝不命中（证明 Intent 分纯由 TENDER_PUBLISHED 驱动，非关键词兜底）
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
const svc = new TedIntentProjectionService({ prisma });

async function main() {
  // ══════════ Tier 1 · 真 API（直打 TED 招标公告 cn-standard）══════════
  console.log(`\n══ Tier 1 · 真 API：泵(CPV ${CPV}) 采购招标 近 ${SINCE_DAYS} 天（scope=ACTIVE 开放机会）══`);
  let countries = PRIMARY_COUNTRIES;
  let notices = await searchContractNotices({ cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS, scope: 'ACTIVE', maxRecords: 100 });
  if (!notices.length) {
    console.log(`   ⚠️ 泵+德国近 ${SINCE_DAYS} 天无开放招标（数据稀疏），放宽到欧盟主力国再拉一次`);
    countries = WIDE_COUNTRIES;
    notices = await searchContractNotices({ cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS, scope: 'ACTIVE', maxRecords: 100 });
  }
  console.log(`   拉到 ${notices.length} 条开放招标（买方国别集 ${countries.join(',')}）`);
  for (const n of notices.slice(0, 8)) {
    console.log(`   · ${n.buyerNames[0] ?? '?'}  [${n.buyerCountries[0] ?? '?'}]  发布=${n.publicationDate ?? '—'} → ISO=${n.publicationDateIso ?? '—'}  CPV=${n.cpvCodes.join(',') || '—'}`);
  }
  ok(notices.length > 0, 'Tier 1：真 API 返回 ≥1 条开放招标');
  ok(notices.some((n) => !!n.buyerNames[0]), '至少 1 条有买方名（intent 承载主体）');
  // §8.6 硬核验：有发布日的每条，ISO 归一后 Date.parse 必合法（否则 Intent 衰减=0）
  const withDate = notices.filter((n) => !!n.publicationDate);
  ok(
    withDate.length > 0 && withDate.every((n) => !!n.publicationDateIso && !Number.isNaN(Date.parse(n.publicationDateIso!))),
    `§8.6 每条发布日 ISO 归一后 Date.parse 合法（${withDate.length} 条带发布日）`,
  );
  // 🔴 合规硬自检：招标绿事实里绝不出现邮箱/具名联系点
  const serialized = JSON.stringify(notices);
  ok(!/@/.test(serialized) && !/"?(winner|buyer)[_-]?email"?/i.test(serialized), '🔴 招标记录里无邮箱/具名联系点（个人数据隔离）');

  if (!notices.length) {
    console.log('   ⚠️ 该 CPV 无开放招标，跳过 Tier 2/3（非失败，属数据稀疏）');
    return;
  }

  // ══════════ Tier 2 · 真投影（projectTenders → 买方 canonical + TENDER_PUBLISHED）══════════
  console.log('\n══ Tier 2 · 真投影：projectTenders → 买方 canonical + attributes.intent.TENDER_PUBLISHED ══');
  const result = await svc.projectTenders(WS, { cpvCodes: [CPV], buyerCountries: countries, sinceDays: SINCE_DAYS, maxNotices: 100 });
  console.log(`   noticesFetched=${result.noticesFetched} companiesTouched=${result.companiesTouched} eventsProjected=${result.eventsProjected} skippedNoBuyer=${result.skippedNoBuyer}`);
  ok(result.companiesTouched > 0, `Tier 2：投影 ≥1 家买方 canonical（去重后 ${result.companiesTouched} 家）`);
  ok(result.eventsProjected > 0, `TENDER_PUBLISHED 事件投影 ${result.eventsProjected} 条`);

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
  ok(buyers.every((b) => (b.attributes as Record<string, unknown> | null)?.ted_buyer === true), '每家标记 attributes.ted_buyer=true（招标买方来源可区分）');

  // 每家至少一条 TENDER_PUBLISHED，且 at 经 Date.parse 合法（§8.6 落库端复核）
  const eventsFlat = buyers.flatMap((b) => {
    const intent = (b.attributes as Record<string, unknown> | null)?.intent as { events?: { type: string; at: string; strength?: number }[] } | undefined;
    return intent?.events ?? [];
  });
  ok(eventsFlat.length > 0 && eventsFlat.every((e) => e.type === TENDER_PUBLISHED), `每条 intent 事件 type=TENDER_PUBLISHED（${eventsFlat.length} 条）`);
  ok(eventsFlat.every((e) => !Number.isNaN(Date.parse(e.at))), '§8.6 每条 event.at 经 Date.parse 合法（落库端，喂 recencyDecay 不得 NaN）');

  // field_evidence：CC BY 4.0 署名 + providerKey=ted + 无邮箱
  const ev = await prisma.withWorkspace(WS, (tx) =>
    tx.fieldEvidence.findMany({ where: { workspaceId: WS, providerKey: 'ted' }, select: { license: true, field: true, value: true } }),
  );
  ok(ev.length > 0 && ev.every((e) => e.license === 'CC BY 4.0'), `field_evidence.license='CC BY 4.0'（${ev.length} 条，署名义务）`);
  ok(!/@/.test(JSON.stringify(ev.map((e) => e.value))), '🔴 field_evidence 里无邮箱（个人数据隔离）');

  // ══════════ Tier 3 · 真评分（Intent 维 0 → >0，TENDER_PUBLISHED 驱动）══════════
  console.log('\n══ Tier 3 · 真评分：scoreLead 买方 canonical，投影前(无 intent) → 后(TENDER_PUBLISHED) ══');
  const sample = buyers.find((b) => {
    const intent = (b.attributes as Record<string, unknown> | null)?.intent as { events?: unknown[] } | undefined;
    return (intent?.events?.length ?? 0) > 0;
  });
  if (!sample) {
    ok(false, 'Tier 3：找到带 intent 事件的买方 canonical 用于评分');
    return;
  }
  const attrsAfter = (sample.attributes as Record<string, unknown> | null) ?? {};
  const { intent: _stripped, ...attrsBefore } = attrsAfter; // 投影前 = 抹掉 intent 命名空间
  const toCompany = (attributes: Record<string, unknown>): CompanyForScoring => ({
    name: sample.name, domain: null, country: sample.country, industry: null,
    employeeCount: null, revenueUsd: null, attributes, status: sample.status, contacts: [],
  });
  const before = scoreLead(toCompany(attrsBefore), icp);
  const after = scoreLead(toCompany(attrsAfter), icp);

  console.log(`   样本买方：${sample.name}`);
  console.log(`   Intent 维 : ${before.scores.intent}  →  ${after.scores.intent}`);
  console.log(`   命中信号  : ${before.detail.intentSignals.join('/') || '—'}  →  ${after.detail.intentSignals.join('/') || '—'}`);
  console.log(`   总分      : ${before.totalScore}  →  ${after.totalScore}`);
  console.log(`   来源标注  : ${after.detail.notes.find((n) => n.includes('Intent')) ?? ''}`);
  ok(before.scores.intent === 0, '投影前 Intent 维 = 0（关键词代理不命中买方属性）');
  ok(after.scores.intent > 0, 'Tier 3：投影后 Intent 维 > 0（TENDER_PUBLISHED 真驱动，§8.6 日期未失效）');
  ok(after.detail.intentSignals.includes(TENDER_PUBLISHED), 'intentSignals 含 TENDER_PUBLISHED（招标→时机信号真接进六维）');
  ok(after.totalScore > before.totalScore, '总分随 Intent 维上升（招标信号有正贡献）');
}

try {
  await main();
} finally {
  // 清理（owner 连接绕 RLS）：删 field_evidence（无 FK 不级联）+ canonical
  await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
