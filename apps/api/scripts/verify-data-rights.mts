/**
 * 收口⑥ PR-A 真库验证（无 sandbox）：DataRights 判定 + policy_decision_log + PII 加密 + jurisdiction_policy。
 * 运行：cd /global/backend/apps/api && node --import tsx scripts/verify-data-rights.mts
 *
 * 🔴 RLS 硬规矩：app 连接必须是 app_user（非 superuser），否则 RLS/GRANT 被绕、证明失效。开头 guard。
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DataRightsService } from '../src/compliance/data-rights.service';
import { isEncryptedPii } from '../src/compliance/pii-crypto';
import type { LawfulBasis } from '../src/discovery/provider-contract';

const WS = '00000000-0000-0000-0000-0000000000d6';
const LIA: LawfulBasis = { basis: 'legitimate_interest', ref: 'LIA-verify-1', note: 'John Doe balancing note' };
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置');
  const prisma = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  // ── A. superuser guard（app 连接必须非 superuser，RLS/GRANT 才真实生效）─────────────
  const su = await prisma.$queryRaw<{ is_superuser: string }[]>`SELECT current_setting('is_superuser') AS is_superuser`;
  if (su[0]?.is_superuser === 'on') {
    console.error('💥 app 连接是 superuser（APP_DATABASE_URL 应指向 app_user）——RLS/GRANT 会被绕，验证失效。中止。');
    process.exit(2);
  }
  console.log('— A. superuser guard 通过（app 连接非 superuser）');

  await owner.workspace.upsert({ where: { id: WS }, update: {}, create: { id: WS, name: 'data-rights-verify' } });

  // ── B. seed + loadRules ────────────────────────────────────────────────────────
  const svc = new DataRightsService(prisma);
  await svc.onModuleInit(); // seed jurisdiction_policy（owner）+ loadRules（app_user SELECT）
  check('B1 规则加载 > 30 行（含 PIPL）', svc.ruleCount() > 30);
  const piplRows = await owner.jurisdictionPolicy.count({ where: { processorJurisdiction: 'CN', effect: 'REQUIRE_APPROVAL' } });
  check('B2 jurisdiction_policy PIPL 跨境行已 seed（EU/UK→CN 通配）', piplRows >= 2);

  // ── C. 7 动作跨法域判定（确定性引擎）───────────────────────────────────────────
  const dGreen = svc.evaluate({ action: 'EXPORT', dataClass: 'green', subjectJurisdiction: 'EU', processorJurisdiction: 'EU', hasEvidence: true });
  check('C1 green EXPORT 放行', dGreen.allowed);
  const dRedNoBasis = svc.evaluate({ action: 'AI_PROCESS', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU' });
  check('C2 red/EU AI_PROCESS 无 basis 拒 + Art.14', !dRedNoBasis.allowed && dRedNoBasis.article14NoticeRequired);
  const dRedBasis = svc.evaluate({ action: 'AI_PROCESS', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU', lawfulBasis: LIA });
  check('C3 red/EU AI_PROCESS 有 basis 放行', dRedBasis.allowed);
  const dPipl = svc.evaluate({ action: 'EXPORT', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'CN', lawfulBasis: LIA });
  check('C4 PIPL EU→CN EXPORT 人审（即便有 basis）', dPipl.effect === 'REQUIRE_APPROVAL' && !dPipl.allowed);
  const dUs = svc.evaluate({ action: 'AI_PROCESS', dataClass: 'red', subjectJurisdiction: 'US', processorJurisdiction: 'US' });
  check('C5 red/US AI_PROCESS 放行（CCPA 较宽）', dUs.allowed);
  const dSup = svc.evaluate({ action: 'STORE', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU', suppressed: true });
  check('C6 禁联最先拒', !dSup.allowed && dSup.reason === 'suppressed');
  const dNoEv = svc.evaluate({ action: 'DERIVE', dataClass: 'green', subjectJurisdiction: 'US', processorJurisdiction: 'US', hasEvidence: false });
  check('C7 证据先行：DERIVE 无 evidence 拒', !dNoEv.allowed && dNoEv.reason === 'no_evidence');

  // ── D. evaluateAndLog 落 policy_decision_log（无 PII + append-only）───────────────
  const before = await owner.policyDecisionLog.count({ where: { workspaceId: WS } });
  await svc.evaluateAndLog(
    WS,
    { action: 'OUTREACH', dataClass: 'red', subjectJurisdiction: 'EU', processorJurisdiction: 'EU', lawfulBasis: LIA },
    { subjectType: 'contact', subjectId: '11111111-1111-1111-1111-111111111111', actorId: 'user-x' },
  );
  const after = await owner.policyDecisionLog.count({ where: { workspaceId: WS } });
  check('D1 判定写入 policy_decision_log', after === before + 1);
  const logged = await owner.policyDecisionLog.findFirst({ where: { workspaceId: WS }, orderBy: { createdAt: 'desc' } });
  check('D2 只落 basis 引用（ref）', logged?.lawfulBasisRef === 'LIA-verify-1');
  check('D3 🔴 日志绝不嵌人名明文（note 未落）', JSON.stringify(logged).indexOf('John Doe') === -1);
  // append-only：app_user 应无 UPDATE/DELETE 权 → 尝试更新必抛。
  let blocked = false;
  try {
    await prisma.policyDecisionLog.updateMany({ where: { id: logged!.id }, data: { reason: 'tampered' } });
  } catch {
    blocked = true;
  }
  check('D4 append-only：app_user UPDATE policy_decision_log 被 DB 拒', blocked);

  // ── E. PII 加密往返（透明加解密 + DB 密文）──────────────────────────────────────
  const company = await owner.companyProfile.create({ data: { workspaceId: WS, name: 'DR Verify Co' } });
  const canonical = await owner.canonicalCompany.create({ data: { workspaceId: WS, name: 'DR Verify Co', dedupeKey: `dr-${company.id}` } });
  const NAME = 'Klaus Beispiel';
  const EMAIL = 'klaus.beispiel@example.de';
  const contactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: canonical.id, fullName: NAME, dedupeKey: `klaus-${canonical.id}` } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: EMAIL } });
    return c.id;
  });
  const back = await prisma.withWorkspace(WS, (tx) => tx.canonicalContact.findUnique({ where: { id: contactId }, include: { contactPoints: true } }));
  check('E1 读回 fullName 明文', back?.fullName === NAME);
  check('E2 读回 email 明文', back?.contactPoints?.[0]?.value === EMAIL);
  const raw = await owner.canonicalContact.findUnique({ where: { id: contactId }, include: { contactPoints: true } });
  check('E3 DB full_name 密文', isEncryptedPii(raw?.fullName ?? ''));
  check('E4 DB contact_point.value 密文', isEncryptedPii(raw?.contactPoints?.[0]?.value ?? ''));

  // 清理。
  await owner.canonicalCompany.delete({ where: { id: canonical.id } }).catch(() => {});
  await owner.companyProfile.delete({ where: { id: company.id } }).catch(() => {});
  await owner.policyDecisionLog.deleteMany({ where: { workspaceId: WS } }).catch(() => {});

  await prisma.$disconnect();
  await owner.$disconnect();
  console.log(fail === 0 ? '\n🎉 DataRights PR-A 验证全绿' : `\n💥 ${fail} 处失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
