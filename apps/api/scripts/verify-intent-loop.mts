/**
 * #4 网站变更 → intent 事件 → 六维评分 · **整条链路真实端到端**（开发环境，真服务真库，无 sandbox）。
 * 需 postgres + crawl4ai 在跑。演示：
 *   ① 造一家 fit=match+域名 的 canonical 公司（TRUMPF）
 *   ② registerWatch（ICP 短名单 → 平台级 web_watch）
 *   ③ 真 crawl 建基线快照
 *   ④ 模拟「上周该页还没开放供应商招募」（抹掉基线 sourcing）→ 再 crawl → **真实 diff → SOURCING_OPENED**
 *   ⑤ 投影进 attributes.intent.*
 *   ⑥ 打分：对比投影前/后 Intent 维与总分
 *   node --import tsx scripts/verify-intent-loop.mts
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntentProjectionService } from '../src/intent/intent-projection.service';
import { WebsiteWatchService } from '../src/intent/website-watch.service';
import { Crawl4aiPageFetcher } from '../src/intent/page-fetcher';
import { scoreLead, CompanyForScoring, IcpForScoring } from '../src/lead/scoring';
import { companyIdentity } from '../src/discovery/identity';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const WS = '11111111-1111-4111-8111-111111111111'; // dev 测试 workspace
const SUPPLIER_URL = 'https://www.trumpf.com/en_US/company/principles/suppliers/';
const icp: IcpForScoring = {
  rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
  triggerSignals: ['扩产', 'new production line'],
  committeeRoles: [{ role: 'procurement', title: 'Head of Procurement' }],
};

const prisma = new PrismaService();
await prisma.$connect();
const intentSvc = new IntentProjectionService({ prisma });
const watchSvc = new WebsiteWatchService({ prisma, fetcher: new Crawl4aiPageFetcher() });

// ① fit=match + 域名 的 canonical 公司
const identity = companyIdentity({ name: 'TRUMPF', domain: 'trumpf.com', country: 'DE' });
const companyId = await prisma.withWorkspace(WS, async (tx) => {
  const c = await tx.canonicalCompany.upsert({
    where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: identity.dedupeKey } },
    update: { fitVerdict: 'match', status: 'ENRICHED', domain: 'trumpf.com', industry: 'manufacturing' },
    create: { workspaceId: WS, name: 'TRUMPF', domain: 'trumpf.com', country: 'DE', industry: 'manufacturing', fitVerdict: 'match', status: 'ENRICHED', dedupeKey: identity.dedupeKey },
  });
  return c.id;
});
console.log(`① canonical 公司 TRUMPF (fit=match) = ${companyId}`);

// ② registerWatch —— ICP 短名单 → 平台级 web_watch（显式给 supplier 页）
const reg = await intentSvc.registerWatch(WS, companyId, { pages: [{ url: SUPPLIER_URL, kind: 'sourcing' }] });
console.log(`② registerWatch → source=${reg.sourceKey} (${reg.created ? '新建' : '已存在'}), ${reg.pages} 页`);
// 幂等清场：清掉本源历史快照/变更，保证每次跑都是干净基线
await prisma.sourceEntityChange.deleteMany({ where: { sourceId: reg.sourceId } });
await prisma.sourceEntity.deleteMany({ where: { sourceId: reg.sourceId } });

// ③ 真 crawl 建基线
const w1 = await watchSvc.watch(reg.sourceId);
console.log(`③ watch#1 基线：抓 ${w1.pagesFetched} 页，added=${w1.added}，intentEvents=${w1.intentEvents}`);
const baseline = await prisma.sourceEntity.findFirst({ where: { sourceId: reg.sourceId } });
console.log(`   基线 sourcing = ${JSON.stringify((baseline?.cleaned as { sourcing?: unknown })?.sourcing ?? null)}`);

// ④ 模拟「上周还没开放供应商招募」：抹掉基线 sourcing + 改 hash → 制造真实 diff
if (baseline) {
  const cleaned = { ...(baseline.cleaned as Record<string, unknown>) };
  delete cleaned.sourcing;
  await prisma.sourceEntity.update({ where: { id: baseline.id }, data: { cleaned: cleaned as never, contentHash: 'seed-prior-no-sourcing' } });
}
const w2 = await watchSvc.watch(reg.sourceId);
console.log(`④ watch#2（真 crawl vs 无招募基线）：changed=${w2.changed}，intentEvents=${w2.intentEvents}`);
const changes = await prisma.sourceEntityChange.findMany({ where: { sourceId: reg.sourceId, changeType: { notIn: ['ADDED', 'REMOVED'] } }, orderBy: { createdAt: 'desc' } });
for (const ch of changes) console.log(`   ▶ ${ch.changeType}  ${JSON.stringify((ch.detail as { evidence?: unknown })?.evidence ?? {})}`);

// ⑤ 投影前打分（intent 尚未接入）
const before = await scoreOne();
// 投影 → attributes.intent.*
const proj = await intentSvc.projectIntent(WS);
console.log(`⑤ projectIntent → 命中公司 ${proj.companiesTouched}，投影事件 ${proj.eventsProjected} 条`);
// ⑥ 投影后打分
const after = await scoreOne();

console.log('\n══ 六维评分对比（投影前 → 后）══');
console.log(`   Intent 维 : ${before.scores.intent}  →  ${after.scores.intent}`);
console.log(`   命中信号  : ${before.detail.intentSignals.join('/') || '—'}  →  ${after.detail.intentSignals.join('/') || '—'}`);
console.log(`   总分      : ${before.totalScore}  →  ${after.totalScore}`);
console.log(`   队列      : ${before.queue}  →  ${after.queue}`);
console.log(`   来源标注  : ${after.detail.notes.find((n) => n.includes('Intent')) ?? ''}`);

await prisma.$disconnect();

async function scoreOne() {
  return prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalCompany.findUnique({ where: { id: companyId }, include: { contacts: { include: { contactPoints: true } } } });
    const company: CompanyForScoring = {
      name: c!.name, domain: c!.domain, country: c!.country, industry: c!.industry,
      employeeCount: c!.employeeCount, revenueUsd: c!.revenueUsd,
      attributes: c!.attributes as Record<string, unknown> | null, status: c!.status,
      contacts: c!.contacts.map((ct) => ({ title: ct.title, seniority: ct.seniority, contactPoints: ct.contactPoints.map((p) => ({ type: p.type, status: p.status })) })),
    };
    return scoreLead(company, icp);
  });
}
