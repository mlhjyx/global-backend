/**
 * 制裁名单筛查（Qualify 第五门）—— 真实数据端到端（真库真 OFAC，无 sandbox，AGENTS.md §5）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-sanctions-screening.mts
 *
 * 七段（有界，真拉 OFAC SDN 一次）：
 *   Tier 0 · RLS guard + seed + 启用 ofac_sdn 源（owner 写，app_user 非 superuser 证 RLS 真生效）。
 *   Tier 1 · 真 OFAC 刷新：refreshSource 经 broker 真下载 SDN.XML → 解析 → 落库。🔴 只落 Entity——
 *            total 落 [8000,12000]（**非** ~19156，若个人泄漏则会到 19156）；publishDate 有值；零撤下。
 *   Tier 2 · 真筛查：rebuildIndex → 取真实被制裁实体名 screen → potential_match（命中自身 externalId）；
 *            清白无关名 → clear。
 *   Tier 3 · 🔴 decide 硬门：canonical 公司名=真实被制裁实体 → decide(accept) 抛 SANCTIONS_HOLD_UNRESOLVED
 *            （绝不建/发快照）；scoreLead(sanctionsHold) → queue='sanctions_hold'。
 *   Tier 4 · 人审清白：写命中审计件 → reviewSanctions(cleared_false_positive) → decide 再跑**成功**
 *            （reconcile 抑制，尊重人审）+ 快照 sanctions_screening.status='clear'。
 *   Tier 5 · 清白公司：无关名 → decide 成功 + LeadQualified 快照 sanctions_screening.status='clear'、
 *            list_versions 含 ofac_sdn。
 *   Tier 6 · §8.8 SUSPENDED fail-closed：source_policy SUSPENDED → refreshSource FAILED（broker 拒、零新增）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DataRightsService } from '../src/compliance/data-rights.service';
import { LeadService } from '../src/lead/lead.service';
import { SanctionsRefreshService } from '../src/sanctions/sanctions-refresh.service';
import { SanctionsScreeningService } from '../src/sanctions/sanctions-screening.service';
import { seedSanctions } from '../src/sanctions/sanctions-seed';
import { scoreLead, type CompanyForScoring, type IcpForScoring } from '../src/lead/scoring';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* worktree 无 .env → 用下方 fallback（OFAC 免 key，本验证只需 DB） */
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ICP_ID = '77777777-7777-4777-8777-7777777770f5';
const OFAC_DOMAIN = 'sanctionslistservice.ofac.treas.gov';

const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const prismaService = new PrismaService();
const dataRights = new DataRightsService(prismaService);
const sanctions = new SanctionsScreeningService(prismaService);
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prismaService) });
const refreshSvc = new SanctionsRefreshService({ ownerDb: owner, broker });
const leadSvc = new LeadService(prismaService, dataRights, sanctions);
const ctx = { workspaceId: WS, userId: 'sanctions-verify' } as never;

const icp: IcpForScoring = { rules: [], triggerSignals: [], committeeRoles: [] };

let failed = 0;
const ok = (cond: unknown, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

async function guardNotSuperuser(): Promise<void> {
  const rows = await prismaService.$queryRaw<Array<{ is_super: boolean }>>`
    SELECT usesuper AS is_super FROM pg_user WHERE usename = current_user`;
  if (rows[0]?.is_super) throw new Error('APP_DATABASE_URL 是 superuser——RLS 证明无效，拒跑');
}

async function cleanupTenant(): Promise<void> {
  await owner.sanctionsScreeningResult.deleteMany({ where: { workspaceId: WS } });
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } });
  await owner.workspace.deleteMany({ where: { id: WS } });
}

async function seedCompanyLead(name: string, country: string | null): Promise<string> {
  const company = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name, domain: `${name.replace(/\W+/g, '-')}.example`, country, status: 'ENRICHED', dedupeKey: `${name}:${country}` },
  });
  const lead = await owner.lead.create({
    data: { workspaceId: WS, icpId: ICP_ID, canonicalCompanyId: company.id, fitVerdict: 'match', queue: 'needs_review', totalScore: 0.4, scores: {}, scoreDetail: {} },
  });
  return lead.id;
}

async function main(): Promise<void> {
  await guardNotSuperuser();
  await cleanupTenant();
  await owner.workspace.create({ data: { id: WS, name: 'sanctions-verify' } });
  await dataRights.onModuleInit();
  await seedSanctions(owner);

  // ── Tier 0：启用 ofac_sdn 源 ─────────────────────────────────────────────
  console.log('\n[Tier 0] RLS guard + seed + enable ofac_sdn');
  const src = await owner.sanctionsSource.findUniqueOrThrow({ where: { key: 'ofac_sdn' } });
  await owner.sanctionsSource.update({ where: { id: src.id }, data: { status: 'ENABLED' } });
  await owner.sourcePolicy.update({ where: { domain: OFAC_DOMAIN }, data: { reviewStatus: 'APPROVED' } });
  ok(true, 'ofac_sdn ENABLED + source_policy APPROVED（app_user 非 superuser）');

  // ── Tier 1：真 OFAC 刷新（Entity-only）──────────────────────────────────
  console.log('\n[Tier 1] 真拉 OFAC SDN.XML → 解析 → 落库（仅 Entity）');
  const summary = await refreshSvc.refreshSource(src.id);
  console.log(`   refresh: status=${summary.status} total=${summary.total} added=${summary.added} publishDate=${summary.publishDate}`);
  ok(summary.status === 'DONE', 'refresh DONE');
  ok(summary.total >= 8000 && summary.total <= 12000, `Entity total ${summary.total} 落 [8000,12000]（非 ~19156 → 个人未泄漏）`);
  ok(!!summary.publishDate, `publishDate 有值（${summary.publishDate}）`);
  const entCount = await owner.sanctionsEntity.count({ where: { sourceId: src.id, withdrawnAt: null } });
  ok(entCount === summary.total, `sanctions_entity 活跃行=${entCount} 与 total 一致`);

  // ── Tier 2：真筛查 ──────────────────────────────────────────────────────
  console.log('\n[Tier 2] rebuildIndex + screen 真实被制裁实体');
  await sanctions.rebuildIndex();
  ok(sanctions.isActive(), '索引 active');
  const sample = await owner.sanctionsEntity.findFirstOrThrow({ where: { sourceId: src.id, withdrawnAt: null }, orderBy: { externalId: 'asc' } });
  console.log(`   sample sanctioned entity: "${sample.primaryName}" (${sample.country ?? '—'}, uid ${sample.externalId})`);
  const hit = sanctions.screen(sample.primaryName, sample.country);
  ok(hit.status === 'potential_match', `真实被制裁名 → potential_match（${hit.matches.length} 候选）`);
  ok(hit.matches.some((m) => m.externalId === sample.externalId), '命中含该实体自身 externalId');
  ok(!!hit.listVersions.ofac_sdn, `listVersions 含 ofac_sdn=${hit.listVersions.ofac_sdn}`);
  const clean = sanctions.screen('Zzyzx Nonexistent Widgets Unlimited QX7', 'DE');
  ok(clean.status === 'clear', '清白无关名 → clear');

  // scoreLead 队列覆盖
  const company: CompanyForScoring = { name: sample.primaryName, domain: null, country: sample.country, industry: null, employeeCount: null, revenueUsd: null, attributes: null, status: 'ENRICHED', contacts: [] };
  ok(scoreLead(company, icp, { sanctionsHold: true }).queue === 'sanctions_hold', 'scoreLead(sanctionsHold) → queue=sanctions_hold');

  // ── Tier 3：decide 硬门 ─────────────────────────────────────────────────
  console.log('\n[Tier 3] decide(accept) 对被制裁公司 → 硬拦');
  const badLeadId = await seedCompanyLead(sample.primaryName, sample.country);
  let blocked = false;
  try {
    await leadSvc.decide(ctx, badLeadId, 'accept');
  } catch (e) {
    blocked = String((e as { response?: { error?: { code?: string } } })?.response?.error?.code ?? e).includes('SANCTIONS_HOLD_UNRESOLVED');
  }
  ok(blocked, 'decide(accept) 抛 SANCTIONS_HOLD_UNRESOLVED（绝不交付）');
  const evAfterBlock = await owner.outboxEvent.count({ where: { workspaceId: WS, eventType: 'LeadQualified' } });
  ok(evAfterBlock === 0, '零 LeadQualified 事件（快照未建）');

  // ── Tier 4：人审清白 → decide 成功 ─────────────────────────────────────
  console.log('\n[Tier 4] reviewSanctions(cleared_false_positive) → decide 成功');
  const badLead = await owner.lead.findUniqueOrThrow({ where: { id: badLeadId }, select: { canonicalCompanyId: true } });
  await owner.sanctionsScreeningResult.create({
    data: { workspaceId: WS, canonicalCompanyId: badLead.canonicalCompanyId, screenedName: sample.primaryName, status: 'potential_match', matches: hit.matches as never, topScore: hit.matches[0]?.score ?? null, reviewState: 'open', listVersions: hit.listVersions as never },
  });
  await leadSvc.reviewSanctions(ctx, badLeadId, 'cleared_false_positive', 'verify: false positive');
  const posOutcome = await leadSvc.decide(ctx, badLeadId, 'accept').then(() => 'ok').catch((e) => String(e));
  ok(posOutcome === 'ok', `清白后 decide 成功（reconcile 抑制；${posOutcome}）`);
  const clearedEv = await owner.outboxEvent.findFirst({ where: { workspaceId: WS, aggregateId: badLeadId, eventType: 'LeadQualified' }, orderBy: { occurredAt: 'desc' } });
  const clearedPayload = clearedEv?.payload as { sanctions_screening?: { status?: string } } | undefined;
  ok(clearedPayload?.sanctions_screening?.status === 'clear', `清白后公司快照 sanctions_screening.status=clear（${clearedPayload?.sanctions_screening?.status}）`);

  // ── Tier 5：清白公司 decide → clear 快照 ────────────────────────────────
  console.log('\n[Tier 5] 清白公司 decide → 快照 clear');
  const cleanLeadId = await seedCompanyLead('Bright Clean Trading Co', 'DE');
  await leadSvc.decide(ctx, cleanLeadId, 'accept');
  const cleanLead = await owner.lead.findUniqueOrThrow({ where: { id: cleanLeadId } });
  const cleanEv = await owner.outboxEvent.findFirst({ where: { workspaceId: WS, aggregateId: cleanLeadId, eventType: 'LeadQualified' }, orderBy: { occurredAt: 'desc' } });
  const cleanPayload = cleanEv?.payload as { sanctions_screening?: { status?: string; list_versions?: Record<string, string> } } | undefined;
  ok(cleanLead.status === 'QUALIFIED', '清白公司 decide → QUALIFIED');
  ok(cleanPayload?.sanctions_screening?.status === 'clear', `清白快照 status=clear`);
  ok(!!cleanPayload?.sanctions_screening?.list_versions?.ofac_sdn, 'clear 快照 list_versions 含 ofac_sdn（可审计）');

  // ── Tier 6：SUSPENDED fail-closed ───────────────────────────────────────
  console.log('\n[Tier 6] source_policy SUSPENDED → refresh fail-closed');
  await owner.sourcePolicy.update({ where: { domain: OFAC_DOMAIN }, data: { reviewStatus: 'SUSPENDED' } });
  const beforeCount = await owner.sanctionsEntity.count({ where: { sourceId: src.id } });
  const suspendedSummary = await refreshSvc.refreshSource(src.id).then((s) => s).catch(() => ({ status: 'FAILED' as const }));
  const afterCount = await owner.sanctionsEntity.count({ where: { sourceId: src.id } });
  ok(suspendedSummary.status === 'FAILED', 'SUSPENDED → refreshSource FAILED（broker 拒下载）');
  ok(afterCount === beforeCount, '零新增（fail-closed，未落库）');

  // ── cleanup ─────────────────────────────────────────────────────────────
  await owner.sourcePolicy.update({ where: { domain: OFAC_DOMAIN }, data: { reviewStatus: 'APPROVED' } });
  await owner.sanctionsSource.update({ where: { id: src.id }, data: { status: 'DISABLED' } });
  await cleanupTenant();

  console.log(`\n${failed === 0 ? '✅ 全绿' : `❌ ${failed} 处失败`}`);
  await owner.$disconnect();
  await prismaService.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect().catch(() => undefined);
  process.exit(1);
});
