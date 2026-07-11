/**
 * 收口⑥ 存量 PII 加密回填（一次性数据迁移，必须在 PII 加密代码上线时/后立即跑）。
 * 把历史明文 canonical_contact.full_name / contact_point.value / field_evidence PII 副本加密为 enc:v1:。
 * 幂等：已加密行跳过（isEncryptedPii）。确定性密文使唯一键成立——contact_point 若已存在同 (contact,type,密文)
 * 行（历史误 upsert 产生的密文 dup），删除本明文行而非更新（避免唯一键冲突 + 消重）。
 *
 * ⚠️ 未跑此回填则：新 upsert 的 where.value 被加密后匹配不到旧明文行 → 造重复行 + 旧明文 PII 永留库。
 * 运行：cd apps/api && node --import tsx scripts/backfill-pii-encryption.mts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { encryptPii, isEncryptedPii } from '../src/compliance/pii-crypto';

const PII_TYPES = ['email', 'phone', 'linkedin'];

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置——无法回填');
  // owner 裸 client（无扩展）：直接读写存储值，精确控制密文，避免透明层双重处理。
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  let names = 0;
  let points = 0;
  let dedup = 0;
  let evidence = 0;

  // 1. canonical_contact.full_name（唯一键在 dedupeKey，无 value 冲突 → 直接 update）。
  const contacts = await owner.canonicalContact.findMany({ select: { id: true, fullName: true } });
  for (const c of contacts) {
    if (isEncryptedPii(c.fullName)) continue;
    await owner.canonicalContact.update({ where: { id: c.id }, data: { fullName: encryptPii(c.fullName) } });
    names++;
  }

  // 2. contact_point.value（PII 类型；确定性密文 → 冲突则删明文消重）。
  const pts = await owner.contactPoint.findMany({
    where: { type: { in: PII_TYPES } },
    select: { id: true, contactId: true, type: true, value: true },
  });
  for (const p of pts) {
    if (isEncryptedPii(p.value)) continue;
    const ct = encryptPii(p.value);
    const existing = await owner.contactPoint.findFirst({
      where: { contactId: p.contactId, type: p.type, value: ct },
      select: { id: true },
    });
    if (existing && existing.id !== p.id) {
      await owner.contactPoint.delete({ where: { id: p.id } });
      dedup++;
    } else {
      await owner.contactPoint.update({ where: { id: p.id }, data: { value: ct } });
      points++;
    }
  }

  // 3. field_evidence PII 副本：email/phone/linkedin（标量字符串 value）+ email.guess（嵌套 email）。
  const scalars = await owner.fieldEvidence.findMany({ where: { field: { in: PII_TYPES } }, select: { id: true, value: true } });
  for (const e of scalars) {
    if (typeof e.value === 'string' && !isEncryptedPii(e.value)) {
      await owner.fieldEvidence.update({ where: { id: e.id }, data: { value: encryptPii(e.value) } });
      evidence++;
    }
  }
  const guesses = await owner.fieldEvidence.findMany({ where: { field: 'email.guess' }, select: { id: true, value: true } });
  for (const g of guesses) {
    const v = g.value as { email?: unknown } | null;
    if (v && typeof v.email === 'string' && !isEncryptedPii(v.email)) {
      await owner.fieldEvidence.update({ where: { id: g.id }, data: { value: { ...v, email: encryptPii(v.email) } } });
      evidence++;
    }
  }

  await owner.$disconnect();
  console.log(`✅ 回填完成：full_name ${names} 行、contact_point ${points} 行加密 + ${dedup} 行去重、field_evidence ${evidence} 行`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
