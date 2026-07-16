/**
 * 收口⑥ PII 加密真库烟测（无 sandbox）：验证透明加解密端到端——
 *  ① PrismaService（扩展 client）写联系人 → 读回得**明文**（解密）；
 *  ② owner 裸 client 读同一行 → full_name / contact_point.value 是**密文**（enc:v1:）；
 *  ③ 同 email 重 upsert 幂等（确定性密文使唯一键成立，不产生重复行）。
 * 运行：cd /global/backend/apps/api && node --import tsx scripts/verify-pii-smoke.mts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { isEncryptedPii } from '../src/compliance/pii-crypto';

const WS = '00000000-0000-0000-0000-0000000000c6';
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置');
  const prisma = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  // 准备：owner 建租户锚 + 公司（company 是 RLS 表，用 owner 绕 RLS 建，简化烟测）。
  await owner.workspace.upsert({ where: { id: WS }, update: {}, create: { id: WS, name: 'pii-smoke' } });
  const company = await owner.companyProfile.create({ data: { workspaceId: WS, name: 'PII Smoke Co' } });
  const canonical = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'PII Smoke Co', dedupeKey: `pii-smoke-${company.id}` },
  });

  const NAME = 'Erika Mustermann';
  const EMAIL = 'erika.mustermann@example.de';

  // ① 写：经扩展 client 的 withWorkspace 事务建联系人 + email 点。
  const contactId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalContact.create({
      data: { workspaceId: WS, companyId: canonical.id, fullName: NAME, dedupeKey: `erika-${canonical.id}` },
    });
    await tx.contactPoint.upsert({
      where: { contactId_type_value: { contactId: c.id, type: 'email', value: EMAIL } },
      update: {},
      create: { workspaceId: WS, contactId: c.id, type: 'email', value: EMAIL },
    });
    return c.id;
  });

  // ① 读回（扩展 client）→ 应得明文。
  const readBack = await prisma.withWorkspace(WS, (tx) =>
    tx.canonicalContact.findUnique({ where: { id: contactId }, include: { contactPoints: true } }),
  );
  check('读回 fullName 解密为明文', readBack?.fullName === NAME);
  check('读回 contact_point.value 解密为明文', readBack?.contactPoints?.[0]?.value === EMAIL);

  // ② owner 裸 client 读同一行 → 密文。
  const raw = await owner.canonicalContact.findUnique({ where: { id: contactId }, include: { contactPoints: true } });
  check('DB 落库 full_name 是密文（enc:v1:）', isEncryptedPii(raw?.fullName ?? ''));
  check('明文人名绝不在 DB 明文列', (raw?.fullName ?? '').indexOf(NAME) === -1);
  check('DB 落库 contact_point.value 是密文', isEncryptedPii(raw?.contactPoints?.[0]?.value ?? ''));

  // ③ 幂等：同 email 重 upsert，不新增行（确定性密文 → 唯一键命中）。
  await prisma.withWorkspace(WS, (tx) =>
    tx.contactPoint.upsert({
      where: { contactId_type_value: { contactId, type: 'email', value: EMAIL } },
      update: {},
      create: { workspaceId: WS, contactId, type: 'email', value: EMAIL },
    }),
  );
  const count = await owner.contactPoint.count({ where: { contactId, type: 'email' } });
  check('确定性密文使唯一键幂等（email 点仍 1 行）', count === 1);

  // 清理。
  await owner.canonicalCompany.delete({ where: { id: canonical.id } }).catch(() => {});
  await owner.companyProfile.delete({ where: { id: company.id } }).catch(() => {});

  await prisma.$disconnect();
  await owner.$disconnect();
  console.log(fail === 0 ? '\n🎉 PII 烟测全绿' : `\n💥 ${fail} 处失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
