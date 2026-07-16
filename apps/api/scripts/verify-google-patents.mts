/**
 * 待办 3 · BigQuery Google Patents 发明人身份源（替代被封 EPO OPS）—— 真库真 API 端到端（无 sandbox，AGENTS.md §5）。
 * 需 postgres 在跑；GOOGLE_PATENTS_SA_JSON（服务账号 key 文件路径）+ GOOGLE_PATENTS_PROJECT（计费/配额 project）在 .env。
 * 真欧洲专利公司 = Siemens（DE，海量专利，稳定出发明人）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-google-patents.mts
 *
 * 四段证明（有界样本）：
 *   A · 真 API：provider.discoverContacts 经 BigQuery → 真近期发明人 + personalData + CC BY license
 *       + 🔴 无 residence/地址/国籍入结果（数据最小化）。
 *   B · 真落库：persistDiscoveredContacts → canonicalContact + person.profile 证据（license=CC-BY-4.0，署名落库）；
 *       二次跑**幂等**（Tier 2 归一名命中并入 / 名 dedupeKey 不重复建）。
 *   C · 跨源并：先 seed 同名 Impressum 联系人（decision_maker，带邮箱、无 externalId）→ 再跑 Google Patents →
 *       Tier 2/3 归一名并进同一行 + identity.merge 证据（兑现待办 2 跨源合并，第 4 个源）。
 *   D · §8.8 用途门：去掉 source_policy 的 discovery 用途 → 直连被拒（零发明人）。
 *
 * ⚠️ 必须以 app_user（非 superuser）跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { GooglePatentsInventorProvider } from '../src/discovery/providers/bigquery-patents.provider';
import { persistDiscoveredContacts } from '../src/discovery/contact-persist';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import type { ProviderContactRecord } from '../src/discovery/provider-contract';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'ddddcccc-0000-4000-8000-0000000e0002';
const GP_DOMAIN = 'bigquery.googleapis.com';
const KEY_B = 'vgp-siemens-b.test';
const KEY_C = 'vgp-siemens-c.test';
const TARGET = { name: 'Siemens', domain: 'siemens.com', country: 'DE' };

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
if (!(process.env.GOOGLE_PATENTS_SA_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS) || !process.env.GOOGLE_PATENTS_PROJECT) {
  console.error('❌ GOOGLE_PATENTS_SA_JSON（或 GOOGLE_APPLICATION_CREDENTIALS）+ GOOGLE_PATENTS_PROJECT 缺失（.env）——无 creds 无法真打 BigQuery。');
  process.exit(2);
}

const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });

async function seedCompany(dedupeKey: string): Promise<{ id: string; dedupeKey: string }> {
  return prisma.withWorkspace(WS, async (tx) => {
    const co = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey } },
      update: {},
      create: { workspaceId: WS, name: 'SIEMENS', domain: 'siemens.com', country: 'DE', dedupeKey, status: 'ENRICHED' },
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
  console.log('\n█ 待办 3 · BigQuery Google Patents 发明人身份源（真库真 API）\n');
  await new DiscoveryProviderRegistry().seed(ownerDb); // google_patents data_provider + bigquery.googleapis.com source_policy
  const pol = await ownerDb.sourcePolicy.findUnique({ where: { domain: GP_DOMAIN } });
  ok(pol?.personalData === true && pol.reviewStatus === 'APPROVED', 'source_policy Google Patents personalData=true/APPROVED 已 seed');
  await cleanup();

  // ══════════ A · 真 API ══════════
  console.log('\n══ A · 真 API：Siemens(DE) → 近期发明人 ══');
  const provider = new GooglePatentsInventorProvider({ broker });
  const res = await provider.discoverContacts(TARGET, { workspaceId: WS });
  console.log(`   拉到 ${res.contacts.length} 名发明人`);
  for (const c of res.contacts.slice(0, 6)) console.log(`   · ${c.fullName}  [${c.title}]  role=${c.buyingRole}`);
  ok(res.contacts.length > 0, 'A：真 API 返回 ≥1 名发明人');
  ok(res.contacts.every((c) => c.personalData === true), '每人 personalData=true（🔴 具名个人）');
  ok(res.contacts.every((c) => c.buyingRole === 'technical_buyer'), '每人 buyingRole=technical_buyer（技术评估席）');
  ok(res.contacts.every((c) => c.license === 'CC-BY-4.0'), '每人带 CC-BY-4.0 license 署名');
  ok(res.contacts.every((c) => c.externalIds === undefined), '🔴 无 externalIds（不走 Tier 0，走归一名并）');
  // 🔴 数据最小化硬自检：结果里绝不出现 residence/地址/国籍字段
  const serialized = JSON.stringify(res.contacts);
  ok(!/residence|"address"|nationality|locality|postal|country_code/i.test(serialized), '🔴 结果无 residence/地址/国籍/country_code（数据最小化）');

  if (!res.contacts.length) {
    console.log('   ⚠️ 无发明人（数据稀疏/锚需校准），跳过 B/C');
    return;
  }
  const inventor = res.contacts[0];

  // ══════════ B · 真落库 + 幂等 ══════════
  console.log('\n══ B · 真落库 → person.profile 证据（CC BY 署名）+ 二次幂等 ══');
  const coB = await seedCompany(KEY_B);
  const p1 = await persist(coB, 'google_patents', res.contacts);
  const b1 = await readCompany(coB.id);
  ok(b1.contacts.length === res.contacts.length && p1.created === res.contacts.length, `B：落库 ${b1.contacts.length} 名发明人（created=${p1.created}）`);
  ok(b1.evidence.some((e) => e.field === 'person.profile' && e.license === 'CC-BY-4.0'), 'person.profile 证据 license=CC-BY-4.0（🔴 CC BY 署名落库）');
  ok(b1.evidence.some((e) => e.field === 'person.profile' && (e.value as { personal_data?: boolean }).personal_data === true), 'person.profile 证据（personal_data 标记）');
  ok(!b1.points.some((p) => p.type === 'external_id'), '🔴 无 external_id 点（Google Patents 无稳定人 id）');

  const p2 = await persist(coB, 'google_patents', res.contacts); // 二次跑
  const b2 = await readCompany(coB.id);
  ok(b2.contacts.length === b1.contacts.length && p2.created === 0, `二次跑幂等：行数不变（=${b2.contacts.length}）、created=0、merged=${p2.merged}（Tier 2 归一名命中）`);

  // ══════════ C · 跨源并（Impressum 同名 → Google Patents 归一名并进同一行）══════════
  console.log('\n══ C · 跨源并：先 seed 同名 Impressum 联系人 → Google Patents 跑 → Tier 2/3 名并进同一行 ══');
  const coC = await seedCompany(KEY_C);
  // Impressum 侧（decision_maker）：同名、带邮箱、无 externalId
  await persist(coC, 'decision_maker', [
    { externalId: 'impressum#x', fullName: inventor.fullName, title: 'R&D Lead', email: `contact@${KEY_C}`, personalData: true, buyingRole: 'technical_buyer', sourcePage: `https://${KEY_C}/impressum` },
  ]);
  const cBefore = await readCompany(coC.id);
  // Google Patents 侧：同名发明人
  const gpSame = res.contacts.filter((c) => c.fullName === inventor.fullName);
  const pc = await persist(coC, 'google_patents', gpSame);
  const cAfter = await readCompany(coC.id);
  ok(cBefore.contacts.length === 1, `Impressum 先落 1 条（=${cBefore.contacts.length}）`);
  ok(cAfter.contacts.length === 1 && pc.merged >= 1, `Google Patents 同名发明人并进同一行（行数仍 1，merged=${pc.merged}）——跨源合并`);
  ok(cAfter.points.some((p) => p.type === 'email'), '同一行挂 email(Impressum)');
  const merges = cAfter.evidence.filter((e) => e.field === 'identity.merge').map((e) => (e.value as { match_rule?: string }).match_rule);
  ok(merges.length >= 1, `identity.merge 证据存在（match_rule=${merges.join(',')}）`);

  // ══════════ D · §8.8 用途门 ══════════
  console.log('\n══ D · §8.8 用途门：去 source_policy discovery 用途 → 零发明人 ══');
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { allowedPurpose: ['enrichment'] } });
  const resDenied = await new GooglePatentsInventorProvider({ broker }).discoverContacts(TARGET, { workspaceId: WS });
  ok(resDenied.contacts.length === 0, `§8.8 用途门：去 discovery 用途 → 零发明人（=${resDenied.contacts.length}）`);
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { allowedPurpose: ['discovery', 'enrichment'] } });
}

try {
  await main();
} catch (err) {
  console.error('\n❌ main() 抛出（此前会被 finally 的 process.exit 掩盖成假通过）：', err);
  failed++;
} finally {
  await ownerDb.sourcePolicy
    .update({ where: { domain: GP_DOMAIN }, data: { allowedPurpose: ['discovery', 'enrichment'] } })
    .catch(() => {}); // D 段失败也复位策略
  await cleanup();
  console.log(`\n██ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ██`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
