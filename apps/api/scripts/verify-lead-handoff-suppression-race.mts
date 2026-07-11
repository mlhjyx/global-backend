/**
 * 真库验证（Codex PR #72 P1「Recheck suppression before handoff」）：LeadService.decide 交棒前
 * 对公司行加 SELECT … FOR UPDATE，堵住 Art.17 冻结竞态窗口。无 sandbox、走**真** PrismaService（app_user
 * + RLS + PII 扩展）+ 真 DataRightsService（真库 jurisdiction_policy 规则）+ 真 LeadService.decide。
 *
 * 交错构造（确定性）：
 *  ① 一条独立 app_user 事务对公司行发 `UPDATE … status='SUPPRESSED'`（**不提交**，持写锁）——模拟 freezeSubject。
 *  ② 证据：此刻另开 app_user 短事务**无锁**读 company.status → 仍见陈旧 ENRICHED（旧代码 findUnique 就用这值判 ALLOW）。
 *  ③ 起 decide(accept)（不 await）。修复后其 SELECT FOR UPDATE 撞到 ①的行锁 → **阻塞**；断言 ~800ms 后仍未结算。
 *  ④ 提交 freeze → decide 解锁、READ COMMITTED 下重读到 SUPPRESSED → rights=DENY → 抛 STORAGE_RIGHTS_NOT_GRANTED。
 *  ⑤ 断言：无 LeadQualified 交棒、lead 未 QUALIFIED、无 LeadDecision（整事务原子回滚）、company=SUPPRESSED。
 *  ⑥ 正路：另一 ENRICHED 公司无并发 freeze → decide(accept) 正常发 LeadQualified（修复不误伤 happy path）。
 *
 * 运行：cd apps/api && node --import tsx scripts/verify-lead-handoff-suppression-race.mts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DataRightsService } from '../src/compliance/data-rights.service';
import { LeadService } from '../src/lead/lead.service';

const OWNER_URL = process.env.DATABASE_URL ?? 'postgresql://global:global@localhost:5432/global_dev';
const APP_URL = process.env.APP_DATABASE_URL ?? 'postgresql://app_user:app_pw@localhost:5432/global_dev';
const WS = '99999999-9999-4999-8999-999999999901';

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const freezeClient = new PrismaClient({ datasourceUrl: APP_URL });
const prismaService = new PrismaService();
const dataRights = new DataRightsService(prismaService);
const leadSvc = new LeadService(prismaService, dataRights);
const ctx = { workspaceId: WS, userId: 'race-verify' } as never;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

async function guardNotSuperuser(): Promise<void> {
  const rows = await freezeClient.$queryRaw<Array<{ is_super: boolean }>>`
    SELECT usesuper AS is_super FROM pg_user WHERE usename = current_user`;
  if (rows[0]?.is_super) throw new Error('APP_DATABASE_URL 是 superuser——行锁/RLS 证明无效，拒跑');
}

async function seedCompanyWithLead(name: string): Promise<{ companyId: string; leadId: string }> {
  const company = await owner.canonicalCompany.create({
    data: {
      workspaceId: WS,
      name,
      domain: `${name}.example`,
      country: 'DE', // EU 主体；STORE+red+EU → ALLOW（与 verify-outbox-delivery 同证过的正路）
      status: 'ENRICHED',
      dedupeKey: `${name}.example`,
      contacts: {
        create: [{
          workspaceId: WS,
          fullName: 'Race Verifier',
          title: 'Head of Procurement',
          seniority: 'director',
          dedupeKey: `race-${name}`,
          contactPoints: { create: [{ workspaceId: WS, type: 'email', value: `proc@${name}.example`, status: 'VALID' }] },
        }],
      },
    },
  });
  const lead = await owner.lead.create({
    data: {
      workspaceId: WS,
      icpId: '77777777-7777-4777-8777-777777777701',
      canonicalCompanyId: company.id,
      fitVerdict: 'match',
      fitReasons: { reasons: ['race-verify'] },
      totalScore: 0.61,
      scores: { fit: 0.9, role: 0.5, intent: 0.4, dataQuality: 0.7, reachability: 0.6, engagement: 0 },
      scoreDetail: { verify: true },
      queue: 'recommended',
    },
  });
  return { companyId: company.id, leadId: lead.id };
}

async function cleanup(): Promise<void> {
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } });
  await owner.workspace.deleteMany({ where: { id: WS } });
}

async function main(): Promise<void> {
  await guardNotSuperuser();
  await cleanup(); // 上次残留
  await owner.workspace.create({ data: { id: WS, name: 'handoff-race-verify' } });
  const ruleCount = await dataRights.onModuleInit().then(() => dataRights.ruleCount());
  assert(ruleCount > 0, `jurisdiction_policy 规则已加载（${ruleCount} 条）——引擎非 fail-closed 全拒`);

  // ── 竞态路：freeze 并发提交在 decide 读后、提交前 ──────────────────────────────
  const neg = await seedCompanyWithLead('race-neg');

  let releaseFreeze!: () => void;
  const freezeHeld = new Promise<void>((res) => { releaseFreeze = res; });
  let signalLocked!: () => void;
  const freezeLocked = new Promise<void>((res) => { signalLocked = res; });

  // ① 持锁的未提交 SUPPRESSED（模拟 freezeSubject 的 updateMany，独立 app_user 连接）
  const freezeTx = freezeClient.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${WS}, true)`;
      await tx.$executeRaw`UPDATE canonical_company SET status = 'SUPPRESSED' WHERE id = ${neg.companyId}::uuid`;
      signalLocked();
      await freezeHeld; // 持事务开启（行写锁不放）直到被释放
    },
    { timeout: 20000 },
  );
  await freezeLocked;

  // ② 证据：无锁读在未提交 freeze 期间仍见陈旧 ENRICHED（旧代码 findUnique 据此误判 ALLOW）
  const stale = await prismaService.withWorkspace(WS, (tx) =>
    tx.canonicalCompany.findUnique({ where: { id: neg.companyId }, select: { status: true } }),
  );
  assert(stale?.status === 'ENRICHED', '无锁读在 freeze 未提交时见陈旧 ENRICHED（正是旧代码的漏判窗口）');

  // ③ decide(accept)——修复后 SELECT FOR UPDATE 撞行锁 → 阻塞
  let settled = false;
  const decidePromise = leadSvc
    .decide(ctx, neg.leadId, 'accept')
    .then((r) => { settled = true; return { ok: true as const, r }; })
    .catch((e) => { settled = true; return { ok: false as const, e }; });
  await sleep(800);
  assert(!settled, 'decide 被公司行锁阻塞（SELECT … FOR UPDATE 已生效，未在陈旧读上抢跑交棒）');

  // ④ 提交 freeze → decide 解锁重读 SUPPRESSED → DENY
  releaseFreeze();
  await freezeTx;
  const outcome = await decidePromise;
  assert(!outcome.ok, 'freeze 提交后 decide 被拒（未交棒）');
  const code = (outcome as { e?: { response?: { error?: { code?: string } } } }).e?.response?.error?.code;
  assert(code === 'STORAGE_RIGHTS_NOT_GRANTED', `拒因 = STORAGE_RIGHTS_NOT_GRANTED（实得 ${code ?? String((outcome as { e?: unknown }).e)}）`);

  // ⑤ 原子回滚 + 零泄漏
  const lqCount = await owner.outboxEvent.count({ where: { workspaceId: WS, eventType: 'LeadQualified', aggregateId: neg.leadId } });
  assert(lqCount === 0, '🔴 冻结公司无 LeadQualified 交棒（Art.17 未漏网）');
  const leadAfter = await owner.lead.findUnique({ where: { id: neg.leadId }, select: { status: true } });
  assert(leadAfter?.status !== 'QUALIFIED', 'lead 未标 QUALIFIED（decide 事务原子回滚）');
  const decCount = await owner.leadDecision.count({ where: { leadId: neg.leadId } });
  assert(decCount === 0, '无 LeadDecision 落库（随事务回滚）');
  const compAfter = await owner.canonicalCompany.findUnique({ where: { id: neg.companyId }, select: { status: true } });
  assert(compAfter?.status === 'SUPPRESSED', 'company 终态 SUPPRESSED（freeze 已提交）');

  // ⑥ 正路：ENRICHED 公司无并发 freeze → 正常交棒（修复不误伤 happy path）
  const pos = await seedCompanyWithLead('race-pos');
  const posOutcome = await leadSvc.decide(ctx, pos.leadId, 'accept');
  assert(posOutcome != null, 'ENRICHED 公司 decide(accept) 成功返回');
  const posLq = await owner.outboxEvent.count({ where: { workspaceId: WS, eventType: 'LeadQualified', aggregateId: pos.leadId } });
  assert(posLq === 1, 'ENRICHED 公司 → 发 1 条 LeadQualified（正路完好）');

  console.log('\nALL GREEN — Art.17 交棒竞态闸真库验证通过');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await owner.$disconnect();
    await freezeClient.$disconnect();
    await prismaService.$disconnect();
  });
