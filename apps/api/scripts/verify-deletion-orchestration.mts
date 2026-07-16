/**
 * 收口⑥ PR-B 真库验证（无 sandbox）：GDPR Art.17 删除编排 DSR 全链演练。
 * 运行：cd /global/backend/apps/api && node --import tsx scripts/verify-deletion-orchestration.mts
 *
 * 覆盖：contact 主体 + company 主体 全链（受理→冻结→擦除→重评分请求→回执）、幂等重跑、
 * append-only 回执拒改、RLS 跨租户隔离、🔴 擦除后无 PII 残留 + 事件/回执内容最小化。
 * 🔴 RLS 硬规矩：app 连接必须是 app_user（非 superuser），开头 guard，否则证明失效。
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeletionService } from '../src/compliance/deletion.service';
import { createDeletionActivities } from '../src/temporal/deletion.activities';
import { encryptPii } from '../src/compliance/pii-crypto';
import type { DeletionWorkflowInput } from '../src/compliance/deletion.types';

const WS = '00000000-0000-0000-0000-0000000000de';
const WS2 = '00000000-0000-0000-0000-0000000000df'; // 跨租户 RLS 反例
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) fail++;
}

async function cleanup(owner: PrismaClient, ws: string): Promise<void> {
  await owner.deletionReceipt.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.deletionRequest.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.outboxEvent.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.suppressionRecord.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.fieldEvidence.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.lead.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.contactPoint.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.canonicalContact.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.icpDefinition.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
  await owner.companyProfile.deleteMany({ where: { workspaceId: ws } }).catch(() => {});
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置');
  const prisma = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  const su = await prisma.$queryRaw<{ is_superuser: string }[]>`SELECT current_setting('is_superuser') AS is_superuser`;
  if (su[0]?.is_superuser === 'on') {
    console.error('💥 app 连接是 superuser（APP_DATABASE_URL 应指向 app_user）——RLS/GRANT 会被绕，验证失效。中止。');
    process.exit(2);
  }
  console.log('— A. superuser guard 通过（app 连接非 superuser）');

  await cleanup(owner, WS);
  await cleanup(owner, WS2);
  await owner.workspace.upsert({ where: { id: WS }, update: {}, create: { id: WS, name: 'deletion-verify' } });

  const delSvc = new DeletionService(prisma);
  const acts = createDeletionActivities({ prisma });

  // ── 共享种子：seller + ACTIVE ICP ───────────────────────────────────────────────
  const seller = await owner.companyProfile.create({ data: { workspaceId: WS, name: 'Seller Co' } });
  const icp = await owner.icpDefinition.create({
    data: { workspaceId: WS, companyId: seller.id, name: 'Del Verify ICP', status: 'ACTIVE' },
  });

  // ═══════════ B. CONTACT 主体全链 ═══════════════════════════════════════════════
  const NAME = 'Klaus Löschmann';
  const EMAIL = 'klaus.loeschmann@deltarget.example';
  const PHONE = '+49 30 1234567';
  const company = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Del Target Co', domain: 'deltarget.example', dedupeKey: 'd:deltarget.example', status: 'NEW' },
  });
  await owner.lead.create({ data: { workspaceId: WS, icpId: icp.id, canonicalCompanyId: company.id, status: 'DISCOVERED' } });
  const contactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({
      data: { workspaceId: WS, companyId: company.id, fullName: NAME, dedupeKey: `e:${EMAIL.toLowerCase()}` },
    });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: EMAIL } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'phone', value: PHONE } });
    return c.id;
  });
  await owner.fieldEvidence.createMany({
    data: [
      { workspaceId: WS, entityType: 'contact', entityId: contactId, field: 'person.profile', value: { personal_data: true, buying_role: 'procurement' }, providerKey: 'decision_maker', license: 'public', dataClass: 'red' },
      { workspaceId: WS, entityType: 'contact', entityId: contactId, field: 'email', value: encryptPii(EMAIL), providerKey: 'decision_maker', license: 'public', dataClass: 'red' },
    ],
  });

  // 受理（DeletionService → 落 deletion_request + 事务性 outbox 发 DeletionRequested）
  const view = await delSvc.createRequest(WS, 'verify-actor', { subjectType: 'contact', subjectId: contactId, reason: 'erasure', requestRef: 'DSR-1' });
  check('B1 受理请求 status=RECEIVED', view.status === 'RECEIVED');
  const reqCmd = await owner.outboxEvent.count({ where: { workspaceId: WS, eventType: 'DeletionRequested', aggregateId: view.id } });
  check('B2 事务性 outbox 发 DeletionRequested', reqCmd === 1);

  const input: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: view.id, subjectType: 'contact', subjectId: contactId };

  const located = await acts.freezeSubject(input);
  check('B3 定位：1 contact / 2 contactPoints / 2 fieldEvidence / 1 ICP', located.contactIds.length === 1 && located.contactPointsCount === 2 && located.fieldEvidenceCount === 2 && located.affectedIcpIds.length === 1);
  check('B4 located PII-free（无邮箱/人名字段）', JSON.stringify(located).indexOf(EMAIL) === -1 && JSON.stringify(located).indexOf(NAME) === -1);
  const supp = await owner.suppressionRecord.findFirst({ where: { workspaceId: WS, type: 'email', value: EMAIL.toLowerCase() } });
  check('B5 冻结写 suppression_record(email)', !!supp);
  const afterFreeze = await owner.deletionRequest.findUnique({ where: { id: view.id } });
  check('B6 状态 → FROZEN', afterFreeze?.status === 'FROZEN');

  await acts.eraseSubject({ input, located });
  const goneContact = await owner.canonicalContact.findUnique({ where: { id: contactId } });
  const gonePoints = await owner.contactPoint.count({ where: { contactId } });
  const goneEvidence = await owner.fieldEvidence.count({ where: { entityType: 'contact', entityId: contactId } });
  check('B7 🔴 canonical_contact 硬删（无 PII 残留）', goneContact === null);
  check('B8 🔴 contact_point 级联删净', gonePoints === 0);
  check('B9 🔴 field_evidence(contact) 删净', goneEvidence === 0);
  const rescore = await owner.outboxEvent.count({ where: { workspaceId: WS, eventType: 'QualifyRequested', aggregateId: icp.id } });
  check('B10 受影响 ACTIVE ICP 发 QualifyRequested 重评分', rescore === 1);
  const afterErase = await owner.deletionRequest.findUnique({ where: { id: view.id } });
  check('B11 状态 → ERASING', afterErase?.status === 'ERASING');

  const counts = await acts.completeDeletion({ input, located });
  check('B12 回执计数正确', counts.contactsErased === 1 && counts.contactPointsErased === 2 && counts.fieldEvidenceErased === 2 && counts.leadsRescoreRequested === 1 && counts.signalsRevoked === 0);
  const receipt = await owner.deletionReceipt.findUnique({ where: { deletionRequestId: view.id } });
  check('B13 deletion_receipt 落库（只计数无 PII）', !!receipt && receipt.contactsErased === 1 && JSON.stringify(receipt).indexOf(EMAIL) === -1 && JSON.stringify(receipt).indexOf(NAME) === -1);
  const doneReq = await owner.deletionRequest.findUnique({ where: { id: view.id } });
  check('B14 状态 → COMPLETED', doneReq?.status === 'COMPLETED');
  const completedEv = await owner.outboxEvent.findFirst({ where: { workspaceId: WS, eventType: 'DeletionCompleted', aggregateId: view.id } });
  check('B15 DeletionCompleted 事件发出（RESTRICTED）', !!completedEv && completedEv.privacyClassification === 'RESTRICTED');
  check('B16 🔴 事件 payload 无人名/邮箱明文', !!completedEv && JSON.stringify(completedEv.payload).indexOf(EMAIL) === -1 && JSON.stringify(completedEv.payload).indexOf(NAME) === -1);

  // append-only：app_user 改回执必被 DB 拒
  let blockedUpd = false;
  try { await prisma.withWorkspace(WS, (tx) => tx.deletionReceipt.updateMany({ where: { id: receipt!.id }, data: { contactsErased: 999 } })); } catch { blockedUpd = true; }
  check('B17 append-only：app_user UPDATE deletion_receipt 被 DB 拒', blockedUpd);

  // 幂等：重跑 freeze/erase/complete 不报错、不产生重复回执、状态仍 COMPLETED
  const located2 = await acts.freezeSubject(input);
  await acts.eraseSubject({ input, located: located2 });
  await acts.completeDeletion({ input, located: located2 });
  const receiptCount = await owner.deletionReceipt.count({ where: { deletionRequestId: view.id } });
  const stillDone = await owner.deletionRequest.findUnique({ where: { id: view.id } });
  check('B18 幂等重跑：回执不重复 + 状态仍 COMPLETED', receiptCount === 1 && stillDone?.status === 'COMPLETED');

  // ═══════════ C. COMPANY 主体全链 ═══════════════════════════════════════════════
  const NAME2 = 'Petra Firmenlöschung';
  const EMAIL2 = 'petra@delco2.example';
  const company2 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Del Co Two GmbH', domain: 'delco2.example', dedupeKey: 'd:delco2.example', status: 'ENRICHED' },
  });
  await owner.lead.create({ data: { workspaceId: WS, icpId: icp.id, canonicalCompanyId: company2.id, status: 'DISCOVERED' } });
  const contactId2 = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: company2.id, fullName: NAME2, dedupeKey: `e:${EMAIL2}` } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: EMAIL2 } });
    return c.id;
  });
  await owner.fieldEvidence.create({ data: { workspaceId: WS, entityType: 'contact', entityId: contactId2, field: 'person.profile', value: { personal_data: true }, providerKey: 'decision_maker', license: 'public', dataClass: 'red' } });

  const viewC = await delSvc.createRequest(WS, 'verify-actor', { subjectType: 'company', subjectId: company2.id, reason: 'objection' });
  const inputC: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: viewC.id, subjectType: 'company', subjectId: company2.id };
  const locatedC = await acts.freezeSubject(inputC);
  const suppDomain = await owner.suppressionRecord.count({ where: { workspaceId: WS, type: 'domain', value: 'delco2.example' } });
  const suppName = await owner.suppressionRecord.count({ where: { workspaceId: WS, type: 'company_name' } });
  check('C1 company 冻结：suppress domain + company_name', suppDomain === 1 && suppName >= 1);
  await acts.eraseSubject({ input: inputC, located: locatedC });
  const co2 = await owner.canonicalCompany.findUnique({ where: { id: company2.id } });
  const co2Contacts = await owner.canonicalContact.count({ where: { companyId: company2.id } });
  check('C2 company 主体：公司标 SUPPRESSED（保留绿区事实，不硬删记录）', co2?.status === 'SUPPRESSED');
  check('C3 🔴 公司下联系人硬删净', co2Contacts === 0);
  const countsC = await acts.completeDeletion({ input: inputC, located: locatedC });
  check('C4 company 回执：companiesSuppressed=1 / contactsErased=1', countsC.companiesSuppressed === 1 && countsC.contactsErased === 1);

  // ═══════════ D. RLS 跨租户隔离 ═════════════════════════════════════════════════
  await owner.workspace.upsert({ where: { id: WS2 }, update: {}, create: { id: WS2, name: 'deletion-verify-other' } });
  const crossVisible = await prisma.withWorkspace(WS2, (tx) => tx.deletionRequest.findUnique({ where: { id: view.id } }));
  check('D1 RLS：他租户看不到本 workspace 的 deletion_request', crossVisible === null);
  const crossReceipts = await prisma.withWorkspace(WS2, (tx) => tx.deletionReceipt.count({}));
  check('D2 RLS：他租户 deletion_receipt 计数为 0（本 WS 的不可见）', crossReceipts === 0);

  // ═══════════ E. F2：回执 append-only 不可被删父级联绕过 ═══════════════════════════
  // view 是 B 段已 COMPLETED 且有回执的请求；app_user 删其父 deletion_request 应被拒（REVOKE DELETE + FK RESTRICT）。
  let delBlocked = false;
  try { await prisma.withWorkspace(WS, (tx) => tx.deletionRequest.deleteMany({ where: { id: view.id } })); } catch { delBlocked = true; }
  check('E1 F2：app_user 删有回执的 deletion_request 被拒（护回执 append-only 不被级联抹除）', delBlocked);

  // ═══════════ F. F3：并发重复 DSR 去重（部分唯一索引 + P2002 复用）══════════════════
  const fCompany = await owner.canonicalCompany.create({ data: { workspaceId: WS, name: 'F Race Co', domain: 'frace.example', dedupeKey: 'd:frace.example', status: 'NEW' } });
  const fContactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: fCompany.id, fullName: 'Race Person', dedupeKey: 'e:race@frace.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'race@frace.example' } });
    return c.id;
  });
  const races = await Promise.allSettled([
    delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: fContactId }),
    delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: fContactId }),
  ]);
  const okViews = races.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof delSvc.createRequest>>> => r.status === 'fulfilled').map((r) => r.value);
  const distinctReqs = await owner.deletionRequest.count({ where: { workspaceId: WS, subjectType: 'contact', subjectId: fContactId } });
  check('F1 F3：并发同主体两次受理只落 1 条 deletion_request（部分唯一索引兜底 + P2002 复用）', distinctReqs === 1 && okViews.length === 2 && okViews[0].id === okViews[1].id);

  // ═══════════ G. F1：部分失败恢复——擦除已发生但状态 FAILED，重跑取持久化 stats 写忠实回执不伪造 0 ═══
  const gCompany = await owner.canonicalCompany.create({ data: { workspaceId: WS, name: 'G Recover Co', domain: 'grecover.example', dedupeKey: 'd:grecover.example', status: 'NEW' } });
  const gContactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: gCompany.id, fullName: 'Recover Person', dedupeKey: 'e:recover@grecover.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'recover@grecover.example' } });
    return c.id;
  });
  const gView = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: gContactId });
  const gInput: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: gView.id, subjectType: 'contact', subjectId: gContactId };
  await acts.freezeSubject(gInput);
  await acts.eraseSubject({ input: gInput, located: await acts.freezeSubject(gInput) }); // 擦除 + stats 持久化，contact 已删
  await owner.deletionRequest.update({ where: { id: gView.id }, data: { status: 'FAILED', error: 'simulated complete failure' } });
  // 人工重跑：freeze 重算 located=空（contact 已删）→ complete 应取持久化 stats（=1）而非伪造 0
  const gEmptyLocated = await acts.freezeSubject(gInput);
  const gCounts = await acts.completeDeletion({ input: gInput, located: gEmptyLocated });
  const gReceipt = await owner.deletionReceipt.findUnique({ where: { deletionRequestId: gView.id } });
  const gReq = await owner.deletionRequest.findUnique({ where: { id: gView.id } });
  check('G1 F1：FAILED(擦除已发生) 重跑取持久化 stats 写忠实回执（contactsErased=1 非 0）', gReceipt?.contactsErased === 1 && gCounts.contactsErased === 1);
  check('G2 F1：FAILED(擦除已发生) 收尾为 COMPLETED', gReq?.status === 'COMPLETED');
  // 反例：擦除从未发生（FROZEN）的 complete 应拒绝伪造回执
  const g2ContactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: gCompany.id, fullName: 'Never Erased', dedupeKey: 'e:never@grecover.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'never@grecover.example' } });
    return c.id;
  });
  const g2View = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: g2ContactId });
  const g2Input: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: g2View.id, subjectType: 'contact', subjectId: g2ContactId };
  const g2Located = await acts.freezeSubject(g2Input); // 只 FROZEN，未 erase
  let refused = false;
  try { await acts.completeDeletion({ input: g2Input, located: g2Located }); } catch { refused = true; }
  check('G3 F1：擦除未发生(FROZEN) 的 complete 拒绝伪造回执', refused);

  // ═══════════ H. F4：company 冻结即 SUPPRESSED + 擦除时刻捕获漏网新联系人 ═══════════════
  const hCompany = await owner.canonicalCompany.create({ data: { workspaceId: WS, name: 'H Straggler Co', domain: 'hstrag.example', dedupeKey: 'd:hstrag.example', status: 'NEW' } });
  await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: hCompany.id, fullName: 'Straggler One', dedupeKey: 'e:one@hstrag.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'one@hstrag.example' } });
  });
  const hView = await delSvc.createRequest(WS, 'actor', { subjectType: 'company', subjectId: hCompany.id });
  const hInput: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: hView.id, subjectType: 'company', subjectId: hCompany.id };
  const hLocated = await acts.freezeSubject(hInput);
  const hCoAfterFreeze = await owner.canonicalCompany.findUnique({ where: { id: hCompany.id } });
  check('H1 F4：company 冻结即标 SUPPRESSED（不等到 erase，尽早拦发现）', hCoAfterFreeze?.status === 'SUPPRESSED');
  // 模拟冻结后并发发现新增的漏网联系人
  await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: hCompany.id, fullName: 'Straggler Two', dedupeKey: 'e:two@hstrag.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'two@hstrag.example' } });
  });
  await acts.eraseSubject({ input: hInput, located: hLocated });
  const hRemaining = await owner.canonicalContact.count({ where: { companyId: hCompany.id } });
  check('H2 F4：擦除时刻重查捕获冻结后新增的漏网联系人（0 残留）', hRemaining === 0);

  // 清理
  await cleanup(owner, WS);
  await cleanup(owner, WS2);
  await prisma.$disconnect();
  await owner.$disconnect();
  console.log(fail === 0 ? '\n🎉 删除编排 PR-B 全链验证全绿' : `\n💥 ${fail} 处失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
