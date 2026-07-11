/**
 * 真库验证（Codex PR #65 P1「Merge duplicate blinded contacts during backfill」+ #60 P2「Preserve
 * verification state」）：新盲化写路径已为**同一身份**先建 `bi:v1:` 行、legacy 明文行（`e:`）尚存时，
 * 回填盲化 legacy 行会撞 `(workspace_id, dedupe_key)` 唯一键。修复后回填**合并**而非崩溃，且保全验证态。
 * 无 sandbox、裸 owner 连接直读写存储值（与回填一致）。
 *
 * 构造：同一公司下同一身份两行——L=legacy(`e:<email>` 明文键 + 明文 full_name + VALID 明文 email 点 + 明文 phone 点)、
 *       S=新盲化(`bi:v1:blind(e:<email>)` + 加密 full_name + UNVERIFIED 加密 email 点)；L 上另挂一条 field_evidence。
 * ① 探针：对 L 直接 bare `update dedupe_key=blinded` → 抛 P2002（正是旧回填会崩迁移、留 PII 明文键的点）。
 * ② 跑真 runBackfill()：断言不崩、merges=1、L 已删、S 存活、S 只剩 1 个 email 点且验证态被 L 的 VALID 折叠保全、
 *    L 的 phone 点改挂到 S 并加密、L 的 field_evidence 改挂到 S、无重复点。
 * ③ 再跑 runBackfill()：幂等（merges=0，S 不变）。
 *
 * 运行：cd apps/api && node --import tsx scripts/verify-backfill-blinded-merge.mts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { blindContactKey, encryptPii, isEncryptedPii } from '../src/compliance/pii-crypto';
import { runBackfill } from './backfill-pii-encryption.mts';

const OWNER_URL = process.env.DATABASE_URL ?? 'postgresql://global:global@localhost:5432/global_dev';
const WS = '99999999-9999-4999-8999-999999999902';
const EMAIL = 'proc@merge.example';
const RAW_KEY = `e:${EMAIL}`;
const VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');
// 独立联系人 T（已盲化，不参与 step-1 合并）：单行内明文 VALID + 密文 UNVERIFIED 同值点 → 专测 step-2 去重折叠。
const T_EMAIL = 'solo@merge.example';
const T_VERIFIED_AT = new Date('2026-02-02T00:00:00.000Z');

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

async function cleanup(): Promise<void> {
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } });
  await owner.workspace.deleteMany({ where: { id: WS } });
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置——无法验证');
  await cleanup();
  await owner.workspace.create({ data: { id: WS, name: 'backfill-merge-verify' } });
  const company = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Merge Co', domain: 'merge.example', dedupeKey: 'merge.example' },
  });
  const blinded = blindContactKey(RAW_KEY);

  // L = legacy 明文行（明文键 + 明文 full_name + 标量元数据 + VALID 明文 email 点 + 明文 phone 点）
  const legacy = await owner.canonicalContact.create({
    data: {
      workspaceId: WS,
      companyId: company.id,
      fullName: 'Legacy Person',
      title: 'Head of Procurement', // survivor 缺此三项 → 合并须补空（不丢职务元数据）
      seniority: 'director',
      department: 'procurement',
      dedupeKey: RAW_KEY,
      contactPoints: {
        create: [
          { workspaceId: WS, type: 'email', value: EMAIL, status: 'VALID', verifiedAt: VERIFIED_AT },
          { workspaceId: WS, type: 'phone', value: '+49 30 1234567', status: 'UNVERIFIED' },
        ],
      },
    },
  });
  await owner.fieldEvidence.create({
    data: {
      workspaceId: WS, entityType: 'contact', entityId: legacy.id, field: 'person.profile',
      value: { personal_data: true } as never, providerKey: 'verify', license: 'public',
      allowedActions: ['display'] as never, dataClass: 'red',
    },
  });

  // S = 新盲化行（同一身份：blinded 键 + 加密 full_name + UNVERIFIED 加密 email 点）
  const survivor = await owner.canonicalContact.create({
    data: {
      workspaceId: WS,
      companyId: company.id,
      fullName: encryptPii('Legacy Person'),
      dedupeKey: blinded, // 缺 title/seniority/department → 合并须从 legacy 补空
      contactPoints: {
        create: [{ workspaceId: WS, type: 'email', value: encryptPii(EMAIL), status: 'UNVERIFIED' }],
      },
    },
  });

  // T = 已盲化独立行（不参与 step-1 合并）：单行内明文 VALID + 密文 UNVERIFIED 同 email 值（历史误 upsert 密文 dup）
  //     → 专测 step-2 去重折叠分支（#60 P2 新代码路径，此前无 verify 覆盖=false-green）。
  const solo = await owner.canonicalContact.create({
    data: {
      workspaceId: WS,
      companyId: company.id,
      fullName: encryptPii('Solo Person'),
      dedupeKey: blindContactKey(`e:${T_EMAIL}`),
      contactPoints: {
        create: [
          { workspaceId: WS, type: 'email', value: T_EMAIL, status: 'VALID', verifiedAt: T_VERIFIED_AT },
          { workspaceId: WS, type: 'email', value: encryptPii(T_EMAIL), status: 'UNVERIFIED' },
        ],
      },
    },
  });

  // ① 探针：旧回填的 bare update 会撞唯一键 → P2002（崩迁移、留 PII 明文键）
  let collided = false;
  try {
    await owner.canonicalContact.update({ where: { id: legacy.id }, data: { dedupeKey: blinded } });
  } catch (e) {
    collided = (e as { code?: string }).code === 'P2002';
  }
  assert(collided, '① bare update 盲化 legacy 键撞 (workspace_id,dedupe_key) 唯一键 P2002（旧回填崩点）');
  const legacyStill = await owner.canonicalContact.findUnique({ where: { id: legacy.id }, select: { dedupeKey: true } });
  assert(legacyStill?.dedupeKey === RAW_KEY, '① 撞键后 legacy 键未变（P2002 拒写）——正是「PII 明文键留库」的旧结局');

  // ② 真 runBackfill：合并而非崩溃
  const counts = await runBackfill();
  assert(counts.merges === 1, `② runBackfill 合并 1 行（merges=${counts.merges}），未抛错`);
  const legacyGone = await owner.canonicalContact.findUnique({ where: { id: legacy.id } });
  assert(legacyGone === null, '② legacy 行已删');
  const survAfter = await owner.canonicalContact.findUnique({ where: { id: survivor.id }, select: { dedupeKey: true } });
  assert(survAfter?.dedupeKey === blinded, '② survivor 存活且键仍为 bi:v1:（同一身份收敛为一行）');

  const survPts = await owner.contactPoint.findMany({ where: { contactId: survivor.id } });
  const emails = survPts.filter((p) => p.type === 'email');
  assert(emails.length === 1, `② survivor 仅 1 个 email 点（明文点折叠进密文点，未重复）——实得 ${emails.length}`);
  assert(isEncryptedPii(emails[0].value), '② 保留 email 点是密文（enc:v1:）');
  assert(emails[0].status === 'VALID', '🔴② 验证态保全：折叠后 email 点=VALID（#60 P2，未被默认 UNVERIFIED 覆盖丢分）');
  assert(emails[0].verifiedAt?.getTime() === VERIFIED_AT.getTime(), '② verifiedAt 一并保全');
  const phones = survPts.filter((p) => p.type === 'phone');
  assert(phones.length === 1 && isEncryptedPii(phones[0].value), '② legacy phone 点改挂到 survivor 并加密（无等价点→改挂）');

  const evOnLegacy = await owner.fieldEvidence.count({ where: { entityType: 'contact', entityId: legacy.id } });
  const evOnSurvivor = await owner.fieldEvidence.count({ where: { entityType: 'contact', entityId: survivor.id } });
  assert(evOnLegacy === 0 && evOnSurvivor === 1, '② field_evidence 由 legacy 改挂到 survivor（无孤儿证据）');

  // ②b 标量补空：survivor 缺 title/seniority/department → 合并从 legacy 补齐（不丢职务元数据）
  const survScalars = await owner.canonicalContact.findUnique({
    where: { id: survivor.id }, select: { title: true, seniority: true, department: true },
  });
  assert(
    survScalars?.title === 'Head of Procurement' && survScalars?.seniority === 'director' && survScalars?.department === 'procurement',
    '②b 合并把 legacy 的 title/seniority/department 补空到 survivor（迁移不静默丢失职务元数据）',
  );

  // ②c step-2 去重折叠分支（#60 P2 新路径）：T 明文 VALID + 密文 UNVERIFIED 同值 → 明文加密后撞既有密文点 → 折叠保 VALID、删明文
  assert(counts.dedup >= 1, `②c step-2 去重分支确被执行（dedup=${counts.dedup} ≥1）`);
  const soloPts = await owner.contactPoint.findMany({ where: { contactId: solo.id, type: 'email' } });
  assert(soloPts.length === 1, `②c step-2 去重后 T 仅剩 1 个 email 点——实得 ${soloPts.length}`);
  assert(isEncryptedPii(soloPts[0].value), '②c 保留点是密文');
  assert(
    soloPts[0].status === 'VALID' && soloPts[0].verifiedAt?.getTime() === T_VERIFIED_AT.getTime(),
    '🔴②c step-2 去重分支验证态保全：折叠后=VALID+verifiedAt（#60 P2 新路径真被验证，非 false-green）',
  );

  // ③ 幂等再跑
  const again = await runBackfill();
  assert(again.merges === 0, `③ 再跑无合并（merges=${again.merges}）——幂等`);
  const survPts2 = await owner.contactPoint.findMany({ where: { contactId: survivor.id, type: 'email' } });
  assert(survPts2.length === 1 && survPts2[0].status === 'VALID', '③ survivor email 点仍单一且 VALID（幂等不损）');

  console.log('\nALL GREEN — 盲化撞键合并 + 验证态保全 真库验证通过');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await owner.$disconnect();
  });
