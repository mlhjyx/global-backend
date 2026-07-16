/**
 * 收口⑥ PR #60 补丁真实验证（无 sandbox，真库）：证明 canonical_contact.dedupe_key 不再明文泄 PII。
 *  段1 真写路径：persistDiscoveredContacts（真 createContact）落一个带 email 的联系人 → owner 裸读
 *       storage 值 → 断言 dedupe_key = bi:v1:<hex>、不含明文 email、非 legacy e: 键形。
 *  段2 回填逻辑：seed 一个 legacy 明文键联系人 → 施回填同款盲化（blindContactKey）→ 断言变 bi:v1:、
 *       且幂等重跑（isBlindedContactKey 命中 → 跳过）。
 * 运行：cd /global/backend/apps/api && node --import tsx scripts/verify-blind-dedupe.mts
 */
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url) });
import { PrismaClient, Prisma } from '@prisma/client';
import { persistDiscoveredContacts } from '../src/discovery/contact-persist';
import { blindContactKey, isBlindedContactKey } from '../src/compliance/pii-crypto';

const WS = 'bb11d000-0000-4000-8000-000000000060';
const DOMAIN = 'blindverify.invalid';
const EMAIL = 'blind@blindverify.invalid';
const NAME = 'Blind Verify Person';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ 断言失败：${msg}`);
  console.log(`  ✅ ${msg}`);
}

async function main(): Promise<void> {
  if (!process.env.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY 未配置');
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  // 清理旧跑（幂等）：删本验证 workspace 的公司（级联删联系人）。
  await owner.canonicalContact.deleteMany({ where: { workspaceId: WS } });
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } });

  const company = await owner.canonicalCompany.create({
    data: { workspaceId: WS, name: 'Blind Verify Co', domain: DOMAIN, dedupeKey: `d:${DOMAIN}`, status: 'ENRICHED' },
  });

  console.log('\n█ 段1：真写路径 persistDiscoveredContacts → dedupe_key 应盲化\n');
  await owner.$transaction(async (tx) => {
    await persistDiscoveredContacts(tx as unknown as Prisma.TransactionClient, {
      workspaceId: WS,
      company: { id: company.id, dedupeKey: company.dedupeKey },
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: NAME, email: EMAIL, personalData: true }],
      suppressedEmails: new Set(),
    });
  });

  // owner 裸读 storage 值（绕透明扩展）。
  const rows = await owner.canonicalContact.findMany({
    where: { workspaceId: WS, companyId: company.id },
    select: { dedupeKey: true },
  });
  assert(rows.length === 1, `落库 1 个联系人（实得 ${rows.length}）`);
  const stored = rows[0].dedupeKey;
  console.log(`  storage dedupe_key = ${stored}`);
  assert(isBlindedContactKey(stored), 'dedupe_key 以 bi:v1: 前缀（已盲化）');
  assert(!stored.includes(EMAIL), '明文 email 不在 dedupe_key 中');
  assert(!stored.startsWith('e:'), '非 legacy 明文键形 e:');
  assert(stored === blindContactKey(`e:${EMAIL}`), '盲值 == blindContactKey(e:<email>)（确定性，upsert 幂等成立）');

  console.log('\n█ 段2：回填盲化 legacy 明文键 + 幂等\n');
  const legacyKey = `e:legacy@${DOMAIN}`;
  const legacy = await owner.canonicalContact.create({
    data: { workspaceId: WS, companyId: company.id, fullName: 'Legacy Person', dedupeKey: legacyKey },
  });
  assert(!isBlindedContactKey(legacyKey), 'seed 的 legacy 键是明文（含 email）');
  // 回填同款逻辑（backfill-pii-encryption.mts 步骤1 的 dedupe_key 分支）
  let blinded = 0;
  const all = await owner.canonicalContact.findMany({ where: { workspaceId: WS }, select: { id: true, dedupeKey: true } });
  for (const r of all) {
    if (isBlindedContactKey(r.dedupeKey)) continue;
    await owner.canonicalContact.update({ where: { id: r.id }, data: { dedupeKey: blindContactKey(r.dedupeKey) } });
    blinded++;
  }
  assert(blinded === 1, `回填盲化 1 行（仅 legacy 行；段1 行已盲化被跳过）实得 ${blinded}`);
  const after = await owner.canonicalContact.findUnique({ where: { id: legacy.id }, select: { dedupeKey: true } });
  assert(!!after && isBlindedContactKey(after.dedupeKey), 'legacy 行已盲化 bi:v1:');
  assert(after!.dedupeKey === blindContactKey(legacyKey), '盲值确定（== blindContactKey(legacyKey)）');
  // 幂等重跑：所有行已盲化 → 0 变更
  let again = 0;
  const all2 = await owner.canonicalContact.findMany({ where: { workspaceId: WS }, select: { id: true, dedupeKey: true } });
  for (const r of all2) if (!isBlindedContactKey(r.dedupeKey)) again++;
  assert(again === 0, '回填幂等：重跑 0 明文键残留');

  // 清理
  await owner.canonicalContact.deleteMany({ where: { workspaceId: WS } });
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: WS } });
  await owner.$disconnect();
  console.log('\n✅ 全段通过：dedupe_key 去 PII 明文（盲化 bi:v1:），真写路径 + 回填 + 幂等均验证。\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
