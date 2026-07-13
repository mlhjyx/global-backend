/**
 * 收口⑥ PR-B 竞态硬化真库验证（无 sandbox）——Codex P1/P2 on PR #63 的四条 race/计数修复。
 * 运行：cd apps/api && node --import tsx scripts/verify-deletion-race-hardening.mts
 *
 * 覆盖：
 *   F1 Recompute counts — company 删除：冻结后新增漏网联系人 → 擦除计数/回执取**真实擦除面**（非冻结快照）。
 *   F2 Suppress late emails — contact 删除：冻结后才挂上的邮箱 → 擦除时补写 suppression_record。
 *   F3 Person-level suppression — contact 删除写 person-level 禁联键 → 同一人**换新邮箱**再被发现也拦下。
 *   F4a Prevent late inserts（确定性）— 公司已 SUPPRESSED → persistDiscoveredContacts 整批不入库。
 *   F4b Prevent late inserts（真并发锁）— 擦除侧 FOR UPDATE 挡住并发发现侧 FOR SHARE，后者提交后见 SUPPRESSED 而跳过。
 * 🔴 RLS 硬规矩：app 连接必须是 app_user（非 superuser），开头 guard，否则证明失效。
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeletionService } from '../src/compliance/deletion.service';
import { createDeletionActivities } from '../src/temporal/deletion.activities';
import { persistDiscoveredContacts } from '../src/discovery/contact-persist';
import type { DeletionWorkflowInput } from '../src/compliance/deletion.types';

const WS = '00000000-0000-0000-0000-0000000000ce';
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) fail++;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function deferred(): { p: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

async function cleanup(owner: PrismaClient): Promise<void> {
  await owner.deletionReceipt.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.deletionRequest.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.outboxEvent.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.suppressionRecord.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.lead.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.contactPoint.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.canonicalContact.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置');
  const prisma = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  const su = await prisma.$queryRaw<{ is_superuser: string }[]>`SELECT current_setting('is_superuser') AS is_superuser`;
  if (su[0]?.is_superuser === 'on') {
    console.error('💥 app 连接是 superuser（APP_DATABASE_URL 应指向 app_user）——RLS 会被绕，验证失效。中止。');
    process.exit(2);
  }
  console.log('— A. superuser guard 通过（app 连接非 superuser）');

  await cleanup(owner);
  await owner.workspace.upsert({ where: { id: WS }, update: {}, create: { id: WS, name: 'del-race-verify' } });

  const delSvc = new DeletionService(prisma);
  const acts = createDeletionActivities({ prisma });

  // ═══════════ F1. Recompute counts from the final erase set（company 删除）═══════════════════════
  const co1 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co One', domain: 'race1.example', dedupeKey: 'd:race1.example', status: 'NEW' },
  });
  await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co1.id, fullName: 'Snapshot One', dedupeKey: 'e:snap1@race1.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'snap1@race1.example' } });
  });
  const v1 = await delSvc.createRequest(WS, 'actor', { subjectType: 'company', subjectId: co1.id });
  const in1: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: v1.id, subjectType: 'company', subjectId: co1.id };
  const loc1 = await acts.freezeSubject(in1);
  check('F1.0 冻结快照只见 1 联系人', loc1.contactIds.length === 1 && loc1.contactPointsCount === 1);
  // 冻结后新增「漏网」联系人（模拟并发发现在冻结后、擦除前提交）
  await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co1.id, fullName: 'Straggler Two', dedupeKey: 'e:snap2@race1.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'snap2@race1.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'phone', value: '+49 111 222' } });
  });
  const counts1 = await acts.eraseSubject({ input: in1, located: loc1 });
  check('F1.1 擦除计数取真实擦除面：contactsErased=2（非冻结快照 1）', counts1.contactsErased === 2);
  check('F1.2 擦除计数：contactPointsErased=3（1+2 真实点数，非快照 1）', counts1.contactPointsErased === 3);
  const req1 = await owner.deletionRequest.findUnique({ where: { id: v1.id } });
  check('F1.3 stats 持久化为真实计数（contactsErased=2）', (req1?.stats as { contactsErased?: number } | null)?.contactsErased === 2);
  const rc1 = await acts.completeDeletion({ input: in1, located: loc1 });
  const receipt1 = await owner.deletionReceipt.findUnique({ where: { deletionRequestId: v1.id } });
  check('F1.4 回执忠实反映真实擦除面（contactsErased=2 / contactPointsErased=3）', rc1.contactsErased === 2 && receipt1?.contactsErased === 2 && receipt1?.contactPointsErased === 3);
  const co1Left = await owner.canonicalContact.count({ where: { companyId: co1.id } });
  check('F1.5 🔴 公司下联系人（含漏网）全删净', co1Left === 0);

  // ═══════════ F2. Suppress emails added after the freeze step（contact 删除）═══════════════════════
  const co2 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Two', domain: 'race2.example', dedupeKey: 'd:race2.example', status: 'NEW' },
  });
  const EMAIL_EARLY = 'early@race2.example';
  const EMAIL_LATE = 'late@race2.example';
  const c2Id = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co2.id, fullName: 'Late Mailer', dedupeKey: `e:${EMAIL_EARLY}` } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: EMAIL_EARLY } });
    return c.id;
  });
  const v2 = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: c2Id });
  const in2: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: v2.id, subjectType: 'contact', subjectId: c2Id };
  const loc2 = await acts.freezeSubject(in2);
  const suppEarly = await owner.suppressionRecord.count({ where: { workspaceId: WS, type: 'email', value: EMAIL_EARLY } });
  check('F2.0 冻结写早邮箱 suppression', suppEarly === 1);
  // 冻结后给同一联系人挂一个**新邮箱**（快照未见）
  await prisma.withWorkspace(WS, async (tx) => {
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c2Id, type: 'email', value: EMAIL_LATE } });
  });
  await acts.eraseSubject({ input: in2, located: loc2 });
  const suppLate = await owner.suppressionRecord.count({ where: { workspaceId: WS, type: 'email', value: EMAIL_LATE } });
  check('F2.1 🔴 擦除时刻补写「冻结后新增邮箱」的 suppression_record', suppLate === 1);
  const c2Gone = await owner.canonicalContact.findUnique({ where: { id: c2Id } });
  check('F2.2 contact 硬删净', c2Gone === null);

  // ═══════════ F3. Person-level suppression（换邮箱再现也拦下）══════════════════════════════════════
  const co3 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Three', domain: 'race3.example', dedupeKey: 'd:race3.example', status: 'NEW' },
  });
  const PERSON = 'Petra Wiedergänger';
  const c3Id = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co3.id, fullName: PERSON, dedupeKey: 'e:petra.old@race3.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'petra.old@race3.example' } });
    return c.id;
  });
  const v3 = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: c3Id });
  const in3: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: v3.id, subjectType: 'contact', subjectId: c3Id };
  await acts.freezeSubject(in3);
  const suppPerson = await owner.suppressionRecord.findFirst({ where: { workspaceId: WS, type: 'contact_key' } });
  check('F3.0 冻结写 person-level 禁联键（contact_key，盲化 bi:v1:）', !!suppPerson && suppPerson.value.startsWith('bi:v1:'));
  check('F3.1 🔴 禁联表不存人名明文', !suppPerson || !suppPerson.value.toLowerCase().includes('petra'));
  await acts.eraseSubject({ input: in3, located: await acts.freezeSubject(in3) });
  // 该人以**不同邮箱**在同公司被重新发现 → persistDiscoveredContacts 应命中 person-level 键而跳过
  const reingest = await prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, {
      workspaceId: WS,
      company: { id: co3.id, dedupeKey: co3.dedupeKey },
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: PERSON, email: 'petra.NEW@elsewhere.example', personalData: true }],
      suppressedEmails: new Set(), // 新邮箱不在 email 禁联 → 只有 person-level 键能拦
    }),
  );
  check('F3.2 🔴 换新邮箱再现被 person-level 键拦下（skipped=1, created=0）', reingest.skippedSuppressed === 1 && reingest.created === 0);
  const c3Reborn = await owner.canonicalContact.count({ where: { companyId: co3.id } });
  check('F3.3 🔴 被擦除的具名人未被重建（公司下 0 联系人）', c3Reborn === 0);

  // ═══════════ F4a. Prevent late inserts — 公司已 SUPPRESSED（确定性闸）══════════════════════════════
  const co4 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Four', domain: 'race4.example', dedupeKey: 'd:race4.example', status: 'SUPPRESSED' },
  });
  const r4 = await prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, {
      workspaceId: WS,
      company: { id: co4.id, dedupeKey: co4.dedupeKey },
      adapterKey: 'decision_maker',
      contacts: [
        { externalId: 'a', fullName: 'Ghost A', email: 'a@race4.example', personalData: true },
        { externalId: 'b', fullName: 'Ghost B', email: 'b@race4.example', personalData: true },
      ],
      suppressedEmails: new Set(),
    }),
  );
  check('F4a 公司 SUPPRESSED → FOR SHARE 复检整批不入库（skipped=2, created=0）', r4.skippedSuppressed === 2 && r4.created === 0);
  const co4Left = await owner.canonicalContact.count({ where: { companyId: co4.id } });
  check('F4a.1 🔴 SUPPRESSED 公司无新联系人落地', co4Left === 0);

  // ═══════════ F4b. Prevent late inserts — 真并发锁（FOR UPDATE 挡 FOR SHARE）═══════════════════════
  const co5 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Five', domain: 'race5.example', dedupeKey: 'd:race5.example', status: 'NEW' },
  });
  // 事务 A（擦除侧）：对公司取 FOR UPDATE + 标 SUPPRESSED，然后**持锁不提交**（等信号）。
  const acquired = deferred();
  const release = deferred();
  const aPromise = prisma.withWorkspace(WS, async (tx) => {
    await tx.$queryRaw`SELECT id FROM canonical_company WHERE id = ${co5.id}::uuid FOR UPDATE`;
    await tx.canonicalCompany.updateMany({ where: { id: co5.id }, data: { status: 'SUPPRESSED' } });
    acquired.resolve();
    await release.p; // 持事务开启（持锁）
  });
  await acquired.p;
  // 事务 B（发现侧）：并发跑 persistDiscoveredContacts → 其内部 FOR SHARE 应被 A 的 FOR UPDATE 挡住。
  const tStart = Date.now();
  const bPromise = prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, {
      workspaceId: WS,
      company: { id: co5.id, dedupeKey: co5.dedupeKey },
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'c', fullName: 'Concurrent Ghost', email: 'ghost@race5.example', personalData: true }],
      suppressedEmails: new Set(),
    }),
  );
  await sleep(400); // B 此刻应阻塞在 FOR SHARE 上
  release.resolve(); // 放行 A 提交（公司已 SUPPRESSED）
  await aPromise;
  const r5 = await bPromise;
  const bElapsed = Date.now() - tStart;
  check('F4b 并发发现侧被 FOR UPDATE 阻塞（≥350ms 才返回）', bElapsed >= 350);
  check('F4b.1 🔴 A 提交后 B 见 SUPPRESSED → 跳过（skipped=1, created=0）', r5.skippedSuppressed === 1 && r5.created === 0);
  const co5Left = await owner.canonicalContact.count({ where: { companyId: co5.id } });
  check('F4b.2 🔴 完成擦除后无「漏网」新 PII 落到本公司', co5Left === 0);

  // ═══════════ F5. contact 主体重物化残留并发窗口收口（PR #80 复审 CONFIRMED）══════════════════════════
  // F5a 有界对账（确定性）+ 数据丢失护栏；F5b 真并发：erase 对账的 FOR UPDATE 排空并发 persist 的 FOR SHARE。
  // 见 docs/implementation-records/deletion-art17-residual-window.md。
  const REBORN = 'Wiedergeborener Zeuge';

  // — F5a：对账删净窗口内重物化件；先存同名另一真人（createdAt < 受理时）绝不误删（=与被驳回 sweep 的关键差异）——
  const co6 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Six', domain: 'race6.example', dedupeKey: 'd:race6.example', status: 'NEW' },
  });
  // 先存的**同名另一真人**（早于 DSR 受理）——护栏对象，必须存活。经扩展 client 建（fullName 加密，贴近真实数据）
  // 后回填 createdAt 到 DSR 之前。🔴 id-based 断言（不按 fullName 过滤——owner 非扩展 client 读到的是密文）。
  const preExistingId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co6.id, fullName: REBORN, dedupeKey: 'e:other.samename@race6.example' } });
    return c.id;
  });
  await owner.canonicalContact.update({ where: { id: preExistingId }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
  // DSR 目标原始件
  const c6Id = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co6.id, fullName: REBORN, dedupeKey: 'e:reborn.old@race6.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'reborn.old@race6.example' } });
    return c.id;
  });
  const v6 = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: c6Id });
  const in6: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: v6.id, subjectType: 'contact', subjectId: c6Id };
  const loc6 = await acts.freezeSubject(in6);
  // 模拟竞态 persist 的产物：受理后新建的**同人新邮箱**重物化件（真实竞态里创建闸读快照在冻结提交前 → 漏拦）
  const artifactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co6.id, fullName: REBORN, dedupeKey: 'e:reborn.NEW@elsewhere.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'reborn.NEW@elsewhere.example' } });
    return c.id;
  });
  const counts6 = await acts.eraseSubject({ input: in6, located: loc6 });
  check('F5a 对账把「原始件 + 重物化同人件」一并擦除（contactsErased=2）', counts6.contactsErased === 2);
  const artifactGone = await owner.canonicalContact.findUnique({ where: { id: artifactId } });
  check('F5a.1 🔴 竞态重物化件（受理后新建同人）被对账删净', artifactGone === null);
  const survivor = await owner.canonicalContact.findUnique({ where: { id: preExistingId } });
  check('F5a.2 🔴 先存的同名另一真人（createdAt < 受理时，同名同公司）未被误删（数据丢失护栏）', survivor !== null);

  // — F5b：真并发。B（发现侧）持 FOR SHARE + 新建重物化件不提交；freeze 写 contact_key；erase 对账的
  //   FOR UPDATE 应被 B 挡住（排空）→ 放行 B 提交后对账见其重物化件并删净。——
  const co7 = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Race Co Seven', domain: 'race7.example', dedupeKey: 'd:race7.example', status: 'NEW' },
  });
  const PERSON7 = 'Konkurrent Wiedergänger';
  const c7Id = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co7.id, fullName: PERSON7, dedupeKey: 'e:k.old@race7.example' } });
    await tx.contactPoint.create({ data: { workspaceId: WS, contactId: c.id, type: 'email', value: 'k.old@race7.example' } });
    return c.id;
  });
  const v7 = await delSvc.createRequest(WS, 'actor', { subjectType: 'contact', subjectId: c7Id });
  const in7: DeletionWorkflowInput = { workspaceId: WS, deletionRequestId: v7.id, subjectType: 'contact', subjectId: c7Id };
  const loc7 = await acts.freezeSubject(in7); // 冻结提交 contact_key（B 已在窗口内，见下）

  const bHeld = deferred();
  const bRelease = deferred();
  const bPromise7 = prisma.withWorkspace(WS, async (tx) => {
    // 模拟竞态 persist：先对公司取 FOR SHARE（与 persistDiscoveredContacts 同），再新建同人新邮箱行，持锁不提交
    await tx.$queryRaw`SELECT status FROM canonical_company WHERE id = ${co7.id}::uuid FOR SHARE`;
    await tx.canonicalContact.create({ data: { workspaceId: WS, companyId: co7.id, fullName: PERSON7, dedupeKey: 'e:k.race@elsewhere.example' } });
    bHeld.resolve();
    await bRelease.p; // 持 FOR SHARE 不提交
  });
  await bHeld.p;
  // erase 对账的 FOR UPDATE 应阻塞在 B 的 FOR SHARE 上：400ms 后仍未返回 = 确实被挡（区分「无锁则早返回」）。
  let eDone = false;
  const ePromise7 = acts.eraseSubject({ input: in7, located: loc7 }).then((r) => {
    eDone = true;
    return r;
  });
  await sleep(400);
  check('F5b erase 对账的 FOR UPDATE 被并发 persist 的 FOR SHARE 阻塞（400ms 后仍未返回）', eDone === false);
  bRelease.resolve(); // 放行 B 提交（重物化件此刻落库、createdAt > 受理时）
  await bPromise7;
  const counts7 = await ePromise7;
  check('F5b.1 🔴 排空后对账把并发重物化件纳入擦除（contactsErased=2）', counts7.contactsErased === 2);
  const co7Left = await owner.canonicalContact.count({ where: { companyId: co7.id } });
  check('F5b.2 🔴 完成擦除后公司下 0 该人行（含真并发重物化件）', co7Left === 0);

  await cleanup(owner);
  await prisma.$disconnect();
  await owner.$disconnect();
  console.log(fail === 0 ? '\n🎉 删除竞态硬化验证全绿（Codex P1/P2 on PR #63 + PR #80 残留窗口收口 F5）' : `\n💥 ${fail} 处失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
