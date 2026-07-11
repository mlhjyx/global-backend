/**
 * 待办 3 · 法国 dirigeants 身份源（INPI RNE 经开放政务网关）—— 真库真 API 端到端（无 sandbox，CLAUDE.md §5）。
 * 需 postgres 在跑；**无 API key**（开放 API）。真法国公司 = WILO FRANCE（FR，泵企，clean align）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-inpi-rne.mts
 *
 * 五段证明（有界样本）：
 *   A · 真 API：provider.discoverContacts 直打开放 API → 真 dirigeant + personalData + Licence Ouverte
 *       license + 🔴 无 DOB/annee/nationalite 入结果（数据最小化）+ 无 externalIds（name-merge）。
 *   B · 真落库：persistDiscoveredContacts → canonicalContact + person.profile 证据；
 *       二次跑**幂等**（Tier 2 归一名命中并入，不重复建）。
 *   C · 跨源并：先 seed 同名 Impressum 联系人（decision_maker，带邮箱）→ 再跑本源 →
 *       Tier 2 归一名并进同一行 + identity.merge 证据（兑现待办 2 跨源合并，第 3 个源）。
 *   D · 🔴 同名边界：seed 2 个不同同名行（2 邮箱）→ 跑无邮箱同名 dirigeant → **不误并**（#62 歧义守卫→欠并新建）。
 *   E · §8.8 用途门：去掉 source_policy 的 discovery 用途 → 本源直连被拒（零 dirigeant）。
 *
 * ⚠️ 必须以 app_user（非 superuser）跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { InpiRneContactProvider } from '../src/discovery/providers/inpi-rne.provider';
import { persistDiscoveredContacts } from '../src/discovery/contact-persist';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import type { ProviderContactRecord } from '../src/discovery/provider-contract';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'ccccbbbb-0000-4000-8000-0000000d0001';
const RNE_DOMAIN = 'recherche-entreprises.api.gouv.fr';
const COMPANY = { name: 'WILO FRANCE', domain: 'wilo.fr', country: 'FR' };
const KEY_B = 'vrne-wilo-b.test';
const KEY_C = 'vrne-wilo-c.test';
const KEY_D = 'vrne-wilo-d.test';

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → RLS 被绕。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });

async function seedCompany(dedupeKey: string): Promise<{ id: string; dedupeKey: string }> {
  return prisma.withWorkspace(WS, async (tx) => {
    const co = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey } },
      update: {},
      create: { workspaceId: WS, name: COMPANY.name, domain: COMPANY.domain, country: 'FR', dedupeKey, status: 'ENRICHED' },
    });
    return { id: co.id, dedupeKey: co.dedupeKey };
  });
}

async function persist(company: { id: string; dedupeKey: string }, adapterKey: string, contacts: ProviderContactRecord[]) {
  return prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, { workspaceId: WS, company, adapterKey, contacts, suppressedEmails: new Set<string>() }),
  );
}

async function readCompany(companyId: string) {
  return prisma.withWorkspace(WS, async (tx) => {
    const contacts = await tx.canonicalContact.findMany({ where: { companyId }, select: { id: true, fullName: true } });
    const ids = contacts.map((c) => c.id);
    const points = ids.length ? await tx.contactPoint.findMany({ where: { contactId: { in: ids } } }) : [];
    const evidence = ids.length ? await tx.fieldEvidence.findMany({ where: { entityId: { in: ids } } }) : [];
    return { contacts, points, evidence };
  });
}

async function cleanup(): Promise<void> {
  const cos = await ownerDb.canonicalCompany.findMany({ where: { workspaceId: WS }, select: { id: true } });
  const ids = cos.map((c) => c.id);
  if (ids.length) {
    const cts = await ownerDb.canonicalContact.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
    const ctIds = cts.map((c) => c.id);
    if (ctIds.length) {
      await ownerDb.contactPoint.deleteMany({ where: { contactId: { in: ctIds } } });
      await ownerDb.fieldEvidence.deleteMany({ where: { entityId: { in: ctIds } } });
      await ownerDb.canonicalContact.deleteMany({ where: { id: { in: ctIds } } });
    }
    await ownerDb.canonicalCompany.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  console.log('\n█ 待办 3 · 法国 dirigeants 身份源（INPI RNE 开放网关，真库真 API）\n');
  await new DiscoveryProviderRegistry().seed(ownerDb); // inpi_rne data_provider + source_policy
  const pol = await ownerDb.sourcePolicy.findUnique({ where: { domain: RNE_DOMAIN } });
  ok(pol?.personalData === true && pol.reviewStatus === 'APPROVED', 'source_policy inpi_rne personalData=true/APPROVED 已 seed');
  await cleanup();

  // ══════════ A · 真 API ══════════
  console.log('\n══ A · 真 API：WILO FRANCE(FR) → dirigeants ══');
  const provider = new InpiRneContactProvider({ broker });
  const res = await provider.discoverContacts(COMPANY, { workspaceId: WS });
  console.log(`   拉到 ${res.contacts.length} 名 dirigeant`);
  for (const c of res.contacts.slice(0, 8)) console.log(`   · ${c.fullName}  [${c.title}]  role=${c.buyingRole}`);
  ok(res.contacts.length > 0, 'A：真 API 返回 ≥1 名 dirigeant');
  ok(res.contacts.every((c) => c.personalData === true), '每人 personalData=true（🔴 具名个人）');
  ok(res.contacts.every((c) => c.license === 'Licence-Ouverte-2.0'), '每人带 Licence-Ouverte-2.0 license 署名');
  ok(res.contacts.every((c) => c.externalIds === undefined), '🔴 无 externalIds（name-merge，非 Tier 0）');
  const serialized = JSON.stringify(res.contacts);
  ok(!/naissance|nationalite|date_of_birth/i.test(serialized), '🔴 结果无 DOB/annee/nationalite（数据最小化）');

  if (!res.contacts.length) {
    console.log('   ⚠️ 无 dirigeant（数据稀疏/对齐失败），跳过 B/C/D');
    return;
  }
  const director = res.contacts[0];

  // ══════════ B · 真落库 + 幂等 ══════════
  console.log('\n══ B · 真落库 → person.profile 证据 + 二次幂等 ══');
  const coB = await seedCompany(KEY_B);
  const p1 = await persist(coB, 'inpi_rne', res.contacts);
  const b1 = await readCompany(coB.id);
  ok(b1.contacts.length === res.contacts.length && p1.created === res.contacts.length, `B：落库 ${b1.contacts.length} 名 dirigeant（created=${p1.created}）`);
  ok(b1.evidence.some((e) => e.field === 'person.profile' && (e.value as { personal_data?: boolean }).personal_data === true), 'person.profile 证据（personal_data 标记）');
  ok(b1.evidence.some((e) => e.field === 'person.profile') && b1.contacts.length > 0, 'person.profile 证据存在');

  const p2 = await persist(coB, 'inpi_rne', res.contacts); // 二次跑
  const b2 = await readCompany(coB.id);
  ok(b2.contacts.length === b1.contacts.length && p2.created === 0, `二次跑幂等：行数不变（=${b2.contacts.length}）、created=0、merged=${p2.merged}（Tier 2 归一名命中）`);

  // ══════════ C · 跨源并（Impressum 同名 → 本源并进同一行）══════════
  console.log('\n══ C · 跨源并：先 seed 同名 Impressum 联系人 → 本源跑 → 名并进同一行 ══');
  const coC = await seedCompany(KEY_C);
  await persist(coC, 'decision_maker', [
    { externalId: 'impressum#x', fullName: director.fullName, title: 'Directeur', email: `contact@${KEY_C}`, personalData: true, buyingRole: 'decision_maker', sourcePage: `https://${KEY_C}/mentions-legales` },
  ]);
  const cBefore = await readCompany(coC.id);
  const same = res.contacts.filter((c) => c.fullName === director.fullName);
  const pc = await persist(coC, 'inpi_rne', same);
  const cAfter = await readCompany(coC.id);
  ok(cBefore.contacts.length === 1, `Impressum 先落 1 条（=${cBefore.contacts.length}）`);
  ok(cAfter.contacts.length === 1 && pc.merged >= 1, `本源同名 dirigeant 并进同一行（行数仍 1，merged=${pc.merged}）——跨源合并`);
  ok(cAfter.points.some((p) => p.type === 'email'), '同一行挂 email(Impressum)');
  const merges = cAfter.evidence.filter((e) => e.field === 'identity.merge').map((e) => (e.value as { match_rule?: string }).match_rule);
  ok(merges.length >= 1, `identity.merge 证据存在（match_rule=${merges.join(',')}）`);

  // ══════════ D · 🔴 同名边界（2 个不同同名行 → 无邮箱同名不误并）══════════
  console.log('\n══ D · 同名边界：2 个不同同名（2 邮箱）→ 无邮箱同名 dirigeant → 不误并（#62 歧义守卫）══');
  const coD = await seedCompany(KEY_D);
  const dupName = director.fullName;
  await persist(coD, 'decision_maker', [
    { externalId: 'imp#1', fullName: dupName, title: 'Gérant', email: `a@${KEY_D}`, personalData: true, buyingRole: 'decision_maker' },
    { externalId: 'imp#2', fullName: dupName, title: 'Gérant', email: `b@${KEY_D}`, personalData: true, buyingRole: 'decision_maker' },
  ]);
  const dBefore = await readCompany(coD.id);
  const pd = await persist(coD, 'inpi_rne', [{ externalId: 'rne#x', fullName: dupName, title: 'Président', personalData: true, buyingRole: 'economic_buyer', license: 'Licence-Ouverte-2.0' }]);
  const dAfter = await readCompany(coD.id);
  ok(dBefore.contacts.length === 2, `先落 2 个不同同名行（2 邮箱，=${dBefore.contacts.length}）`);
  ok(dAfter.contacts.length === 3 && pd.created === 1 && pd.merged === 0, `🔴 无邮箱同名 dirigeant 不误并（行 2→${dAfter.contacts.length}，created=${pd.created}）——#62 歧义守卫→欠并新建`);

  // ══════════ E · §8.8 用途门 ══════════
  console.log('\n══ E · §8.8 用途门：去 source_policy discovery 用途 → 本源零 dirigeant ══');
  await ownerDb.sourcePolicy.update({ where: { domain: RNE_DOMAIN }, data: { allowedPurpose: ['enrichment'] } });
  const resDenied = await new InpiRneContactProvider({ broker }).discoverContacts(COMPANY, { workspaceId: WS });
  ok(resDenied.contacts.length === 0, `§8.8 用途门：去 discovery 用途 → 本源零 dirigeant（=${resDenied.contacts.length}）`);
  await ownerDb.sourcePolicy.update({ where: { domain: RNE_DOMAIN }, data: { allowedPurpose: ['discovery', 'enrichment'] } });
}

try {
  await main();
} finally {
  await ownerDb.sourcePolicy
    .update({ where: { domain: RNE_DOMAIN }, data: { allowedPurpose: ['discovery', 'enrichment'] } })
    .catch(() => {}); // E 段失败也复位策略
  await cleanup();
  console.log(`\n██ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ██`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
