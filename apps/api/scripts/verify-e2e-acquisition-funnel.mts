/**
 * 🎯 AI 获客「全漏斗闭环」端到端实测（封版⑦ 机测半）—— 真库 · 真 RLS · 真 SMTP · 真评分活动，无 sandbox。
 *
 * 证明的命题（本仓此前从未端到端跑通）：**「对的公司 + 对的人 + 联系得上」= 进推荐队列**。
 * 单一变量法——同一条 Lead，除「决策人是否有可达邮箱」外一切不变，观察队列 needs_review → recommended 的翻转，
 * 从而证明 Reachability 硬底既在挡「联系不上的伪推荐」，也在放行「补全联系方式后的真线索」。
 *
 * 漏斗（全部真实活动，不需 Temporal server）：
 *   ① seed 一家真公司（fit=match 挂 Lead + 域名 + 行业 + 近期真实 SOURCING_OPENED intent 事件）+ 一名缺邮箱决策人
 *   ② 评分 BEFORE（scoreCandidates 真活动）→ 断言 queue=needs_review、reachability=0、total 已 ≥0.55（纯被可达门挡）
 *   ③ 开 email_guess 双闸（ENABLED + config.lawfulBasis 测试 LIA）→ guessEmailsBacklog 真活动 → 真 SMTP 猜测落库
 *   ④ 评分 AFTER（同一 scoreCandidates）→ 断言 queue=recommended、reachability>0、total 上升 —— **获客闭环达成**
 *   ⑤ 构建 LeadQualified 快照 → 断言携带决策人 ref（personal_data）+ reachability>0；并显性打印 storage_rights/valid_until 缺口
 *   ⑥ 收尾：email_guess 回 DISABLED（默认）+ 清理本 WS 全部 seed
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-e2e-acquisition-funnel.mts
 *
 * ⚠️ 必须以 app_user（非 superuser）连接跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 * ⚠️ Mac 端口25 常封 → SMTP 不可达 → 猜测多为 unverified(RISKY)：落库为 RISKY（无 outreach，reachability=0.5），
 *    诚实不谎报 VALID。RISKY 已足以越过「reachability>0」推荐门——本测正是要证明这一步。
 * ⚠️ 迁移 add_email_guess_watermark 必须先 apply（canonical_company.email_guess_attempted_at 列）。
 * ⚠️ 用**专属空 workspace**（scoreCandidates 全表扫描该 WS）——只评本测那家公司，绝不 grind 存量。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBacklogActivities } from '../src/temporal/backlog.activities';
import { createQualifyActivities } from '../src/temporal/qualify.activities';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { companyIdentity, contactIdentity } from '../src/discovery/identity';
import { blindContactKey } from '../src/compliance/pii-crypto';
import { buildLeadQualifiedSnapshot, LeadQualifiedSnapshotInput } from '../src/lead/lead-qualified-snapshot';
import { DataRightsService } from '../src/compliance/data-rights.service';
import { storageRightsContextForLead } from '../src/compliance/data-rights.context';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

// 专属空 workspace（scoreCandidates 扫全 WS → 只我这一家；绝不碰存量）
const WS = 'e2e00000-0000-4000-8000-00000000ac01';
// 真德国泵企（有 MX，本机端口25 封时 SMTP 不可达 → 猜测落 RISKY，reachability=0.5，足以过推荐门）
const CO = { name: 'OSNA-Pumpen GmbH', domain: 'osna-pumpen.de', country: 'DE', industry: 'pump manufacturing' };
// 决策人用德语占位名（Max Mustermann=德版「张三」）：可解析成候选、但不指向任何真实个人（伦理）
const PERSON = { fullName: 'Max Mustermann', title: 'Geschäftsführer' };
const LIA = { basis: 'legitimate_interest', ref: 'DEMO-LIA-global-interim-e2e', note: 'e2e funnel demo' };
const DAY = 86_400_000;

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

// ── app_user 硬 guard：superuser 会静默绕 RLS，令证明失效 ──
const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → RLS 被绕，证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

const identity = companyIdentity({ name: CO.name, domain: CO.domain, country: CO.country });
const recentIso = new Date(Date.now() - 5 * DAY).toISOString(); // 5 天前的真实需求信号（衰减≈1）

async function setEmailGuess(status: 'ENABLED' | 'DISABLED', config: unknown): Promise<void> {
  await ownerDb.dataProvider.upsert({
    where: { key: 'email_guess' },
    update: { status, config: config as never },
    create: { key: 'email_guess', class: 'email_verification', status, costPerCallCents: 0, config: config as never },
  });
}

async function cleanup(): Promise<void> {
  await prisma.withWorkspace(WS, async (tx) => {
    const cos = await tx.canonicalCompany.findMany({ where: { dedupeKey: identity.dedupeKey }, select: { id: true } });
    const ids = cos.map((c) => c.id);
    const cts = ids.length
      ? await tx.canonicalContact.findMany({ where: { companyId: { in: ids } }, select: { id: true } })
      : [];
    const ctIds = cts.map((c) => c.id);
    if (ctIds.length) {
      await tx.contactPoint.deleteMany({ where: { contactId: { in: ctIds } } });
      await tx.fieldEvidence.deleteMany({ where: { entityId: { in: ctIds } } });
      await tx.canonicalContact.deleteMany({ where: { id: { in: ctIds } } });
    }
    if (ids.length) {
      await tx.lead.deleteMany({ where: { canonicalCompanyId: { in: ids } } });
      await tx.canonicalCompany.deleteMany({ where: { id: { in: ids } } });
    }
    await tx.outboxEvent.deleteMany({ where: { workspaceId: WS } });
  });
  // ICP/卖方公司走 ownerDb（平台级，rules/roles onDelete Cascade）
  await ownerDb.qualificationRule.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.buyingCommitteeRole.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.icpDefinition.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.companyProfile.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
}

async function seed(): Promise<{ icpId: string; companyId: string; contactId: string }> {
  // workspace 行（company_profile.workspace_id 有 FK）+ 卖方公司 + ACTIVE ICP
  await ownerDb.workspace.upsert({ where: { id: WS }, create: { id: WS, name: 'e2e-acquisition-funnel' }, update: {} });
  const seller = await ownerDb.companyProfile.create({ data: { workspaceId: WS, name: 'E2E Seller Co' } });
  const icp = await ownerDb.icpDefinition.create({
    data: {
      workspaceId: WS,
      companyId: seller.id,
      name: 'Pumpen DE',
      status: 'ACTIVE',
      companyAttributes: { industry: 'pumps' },
      triggerSignals: ['sourcing', 'supplier', '扩产', 'new production line'],
      targetMarkets: ['Germany'],
      // 委员会角色 title 命中决策人 title → Role 维=1.0（保持 Role 恒定，隔离 Reachability 单一变量）
      roles: { create: [{ workspaceId: WS, role: 'decision_maker', title: 'Geschäftsführer' }] },
      // MUST_HAVE industry contains pump（authoritativeFit 覆盖 Fit 维；此规则只为真实性，不影响队列）
      rules: { create: [{ workspaceId: WS, kind: 'MUST_HAVE', field: 'industry', operator: 'contains', value: 'pump' as never }] },
    },
  });

  return prisma.withWorkspace(WS, async (tx) => {
    const attributes = {
      intent: {
        intent_score: 0.9,
        last_change_at: recentIso,
        events: [{ type: 'SOURCING_OPENED', at: recentIso, strength: 0.9, evidence: { page: 'suppliers', delta: 'supplier program opened' } }],
      },
    } as never;
    const company = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: identity.dedupeKey } },
      update: {
        domain: CO.domain, country: CO.country, industry: CO.industry, employeeCount: 120,
        status: 'ENRICHED', emailGuessAttemptedAt: null, attributes,
      },
      create: {
        workspaceId: WS, name: CO.name, domain: CO.domain, country: CO.country, industry: CO.industry,
        employeeCount: 120, status: 'ENRICHED', dedupeKey: identity.dedupeKey, attributes,
      },
    });
    // fit=match 挂 Lead（authoritative Fit + backlogEligibleWhere 眼里的资格）
    await tx.lead.upsert({
      where: { workspaceId_icpId_canonicalCompanyId: { workspaceId: WS, icpId: icp.id, canonicalCompanyId: company.id } },
      update: { fitVerdict: 'match' },
      create: { workspaceId: WS, icpId: icp.id, canonicalCompanyId: company.id, fitVerdict: 'match' },
    });
    // 缺邮箱具名决策人（补全对象）
    const cdk = blindContactKey(contactIdentity({ fullName: PERSON.fullName }, company.dedupeKey));
    const contact = await tx.canonicalContact.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: cdk } },
      update: { title: PERSON.title },
      create: { workspaceId: WS, companyId: company.id, fullName: PERSON.fullName, title: PERSON.title, dedupeKey: cdk },
    });
    await tx.contactPoint.deleteMany({ where: { contactId: contact.id, type: 'email' } }); // 确保「缺邮箱」起点
    return { icpId: icp.id, companyId: company.id, contactId: contact.id };
  });
}

interface LeadRow {
  queue: string | null;
  totalScore: number | null;
  scores: Record<string, number> | null;
  scoreDetail: { notes?: string[] } | null;
  fitVerdict: string | null;
  id: string;
}
async function readLead(icpId: string, companyId: string): Promise<LeadRow> {
  return prisma.withWorkspace(WS, async (tx) => {
    const l = await tx.lead.findUnique({
      where: { workspaceId_icpId_canonicalCompanyId: { workspaceId: WS, icpId, canonicalCompanyId: companyId } },
      select: { id: true, queue: true, totalScore: true, scores: true, scoreDetail: true, fitVerdict: true },
    });
    return {
      id: l!.id, queue: l!.queue, totalScore: l!.totalScore,
      scores: l!.scores as never, scoreDetail: l!.scoreDetail as never, fitVerdict: l!.fitVerdict,
    };
  });
}

console.log('\n█ 🎯 AI 获客全漏斗闭环：对的公司 + 对的人 + 联系得上 → 推荐队列（单一变量=可达性）\n');
await cleanup();

// ── 构建真 providers + gateway（走真 SMTP 验证器 smtp_self）+ 两组活动 ──
const reg = new ModelProviderRegistry();
const gp = buildGatewayProvider();
if (gp) reg.register(gp);
if (stubAllowed()) reg.register(new StubModelProvider());
const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const providers = new DiscoveryProviderRegistry({ gateway, broker });
await providers.seed(ownerDb); // 幂等：smtp_self ENABLED + email_guess 行存在（默认 DISABLED）
const backlog = createBacklogActivities({ prisma, providers, gateway, ownerDb, broker });
const qualify = createQualifyActivities({ prisma });
// 收口⑥ DataRights：onModuleInit 幂等 seed jurisdiction_policy + 加载规则（决 storage_rights_decision）
const dataRights = new DataRightsService(prisma);
await dataRights.onModuleInit();

const { icpId, companyId, contactId } = await seed();
await setEmailGuess('DISABLED', {}); // 确保起点：邮箱补全默认关（证明 BEFORE 的可达=0 不是靠猜测）

// ══════════ 段 1 · 评分 BEFORE（决策人已找到，但联系不上）══════════
console.log('══ 段 1 · 评分 BEFORE —— 「对的人但联系不上」应挡在推荐门外 ══');
const sc1 = await qualify.scoreCandidates({ workspaceId: WS, icpId });
console.log('  scoreCandidates 结果：', JSON.stringify(sc1));
const before = await readLead(icpId, companyId);
console.log(`  Lead: queue=${before.queue} total=${before.totalScore} reachability=${before.scores?.reachability}`);
console.log(`  scores=${JSON.stringify(before.scores)}`);
ok(before.scores?.reachability === 0, 'BEFORE：reachability=0（决策人仅无邮箱 → 零可达渠道）');
ok((before.totalScore ?? 0) >= 0.55, `BEFORE：总分已 ≥0.55（=${before.totalScore}，即纯被可达门挡，非分不够）`);
ok(before.queue === 'needs_review', 'BEFORE：queue=needs_review（Reachability 硬底挡住伪推荐）');
ok(
  (before.scoreDetail?.notes ?? []).some((n) => n.includes('可达')),
  'BEFORE：scoreDetail 留痕「无可达联系方式 → 先联系人发现」',
);

// ══════════ 段 2 · 补全联系方式（开双闸 → 真 SMTP 猜测）══════════
console.log('\n══ 段 2 · 联系方式补全 —— 开 email_guess 双闸（ENABLED + config.lawfulBasis 测试 LIA）══');
await setEmailGuess('ENABLED', { lawfulBasis: LIA });
const gr = await backlog.guessEmailsBacklog({ workspaceId: WS, icpId, limit: 3 });
console.log('  guessEmailsBacklog 结果：', JSON.stringify(gr));
ok(!gr.skipped, '双闸过 → 未 skip');
ok(gr.scanned >= 1, `扫到目标公司（scanned=${gr.scanned} ≥ 1）`);
const points = await prisma.withWorkspace(WS, (tx) =>
  tx.contactPoint.findMany({ where: { contactId, type: 'email' } }),
);
for (const p of points) {
  console.log(`  contact_point: ${p.value}  status=${p.status}  verifiedAt=${p.verifiedAt ? p.verifiedAt.toISOString() : 'null'}`);
}
ok(points.length >= 1, '补全落库：决策人拿到 email contact_point（VALID/RISKY）');
ok(points.every((p) => p.status === 'VALID' || p.status === 'RISKY'), '落库 status ∈ {VALID,RISKY}（诚实不谎报）');

// ══════════ 段 3 · 评分 AFTER（联系得上 → 进推荐）══════════
console.log('\n══ 段 3 · 评分 AFTER —— 同一活动重评，观察队列翻转 ══');
const sc2 = await qualify.scoreCandidates({ workspaceId: WS, icpId });
console.log('  scoreCandidates 结果：', JSON.stringify(sc2));
const after = await readLead(icpId, companyId);
console.log(`  Lead: queue=${after.queue} total=${after.totalScore} reachability=${after.scores?.reachability}`);
ok((after.scores?.reachability ?? 0) > 0, `AFTER：reachability>0（=${after.scores?.reachability}，补全后可达）`);
ok((after.totalScore ?? 0) >= (before.totalScore ?? 0), `AFTER：总分不降（${before.totalScore} → ${after.totalScore}）`);
ok(after.queue === 'recommended', '🎯 AFTER：queue=recommended —— 获客闭环达成（对的人+联系得上→推荐）');

console.log('\n  ── 单一变量对照（唯一变化=决策人可达性）──');
console.log(`     reachability : ${before.scores?.reachability}  →  ${after.scores?.reachability}`);
console.log(`     总分         : ${before.totalScore}  →  ${after.totalScore}`);
console.log(`     队列         : ${before.queue}  →  ${after.queue}`);

// ══════════ 段 4 · LeadQualified 快照（交给下游 SaaS Campaign 的输出合同）══════════
console.log('\n══ 段 4 · LeadQualified 快照 —— 输出合同携带对的人 ref + 可达性 ══');
const snapInput = await prisma.withWorkspace(WS, async (tx) => {
  const c = await tx.canonicalCompany.findUnique({
    where: { id: companyId },
    include: { contacts: { include: { contactPoints: true } } },
  });
  const input: LeadQualifiedSnapshotInput = {
    lead: {
      id: after.id, workspaceId: WS, icpId, fitVerdict: after.fitVerdict,
      totalScore: after.totalScore, scores: after.scores, scoreDetail: after.scoreDetail, fitReasons: null,
    },
    icpVersion: 1,
    company: {
      id: c!.id, name: c!.name, domain: c!.domain, country: c!.country, status: c!.status,
      attributes: c!.attributes,
      contacts: c!.contacts.map((ct) => ({
        id: ct.id, title: ct.title, seniority: ct.seniority, department: ct.department,
        contactPoints: ct.contactPoints.map((p) => ({ status: p.status })),
      })),
    },
  };
  return input;
});
// 收口⑥：与 lead.service.decide 同法算 STORE 存储权利判定，接进快照（此前恒 null）
const rights = dataRights.evaluate(
  storageRightsContextForLead({
    country: snapInput.company.country,
    status: snapInput.company.status,
    hasNamedContacts: snapInput.company.contacts.length > 0,
  }),
);
const snap = buildLeadQualifiedSnapshot({ ...snapInput, storageRightsDecision: rights.effect });
console.log(`  snapshot: contact_refs=${snap.contact_refs.length} personal_data_class=${snap.personal_data_class} recommended_action=${snap.recommended_action}`);
console.log(`  snapshot.scores.reachability=${snap.scores.reachability}  fit_verdict=${snap.fit_verdict}`);
ok(snap.contact_refs.length === 1, '快照携带 1 名决策人 ref');
ok(snap.contact_refs[0].personal_data === true, '决策人 ref 标 personal_data=true（GDPR 最小化：只带 id+职务）');
ok((snap.scores.reachability ?? 0) > 0, '快照 scores.reachability>0（下游知道此线索可达）');
ok(snap.recommended_action === 'handoff_to_campaign', 'recommended_action=handoff_to_campaign（交棒 Campaign）');
// 收口⑥：storage_rights_decision 已接线（DE=EU 主体 + 具名决策人 red + STORE → ALLOW）
console.log(`  storage_rights_decision=${snap.storage_rights_decision}（红数据 EU STORE 判定，DataRightsService）`);
ok(snap.storage_rights_decision === 'ALLOW', '收口⑥：storage_rights_decision 已接线为真值（不再恒 null）');
// 仍待收口的输出合同缺口（诚实标注）
console.log(`  ⚠️ 仍缺（后续）：valid_until=${snap.valid_until}（鲜度模型）  cost=<缺字段>`);

// ── 收尾：email_guess 回默认 DISABLED + 清理 seed ──
await setEmailGuess('DISABLED', {});
await cleanup();

console.log(`\n██ ${failed === 0 ? '✅ 全漏斗闭环通过：AI 获客可端到端证明' : `❌ ${failed} 条失败`} ██`);
await prisma.$disconnect();
await ownerDb.$disconnect();
process.exit(failed === 0 ? 0 : 1);
