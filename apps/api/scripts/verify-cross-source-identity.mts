/**
 * 跨源决策人身份解析端到端实测（选项 B · 待办 2）—— 真库真 RLS，无 sandbox。
 * 直接跑 `persistDiscoveredContacts`（含解析前置 resolvePersonIdentity），三场景断言：
 *   ① email/无-email 桥：同一人先无邮箱落库、再带邮箱同名落库 → **单条合并行** + email point 挂原行 + identity.merge 证据；
 *   ② 邮箱冲突守卫：同公司同名不同邮箱两条 → **两条不并**（🔴 绝不错并两个人）；
 *   ③ 称谓变体：`Dr. Johann Schmidt` 无邮箱 + `Johann Schmidt` 带邮箱 → 归一名精确 → **合并**（title 补空不覆盖）。
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-cross-source-identity.mts
 *
 * ⚠️ 必须以 app_user（非 superuser）连接跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 * ⚠️ 纯落库路径（无网络/无 provider）：只验解析前置 + 并入/新建 + 留痕语义。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { persistDiscoveredContacts } from '../src/discovery/contact-persist';
import type { ProviderContactRecord } from '../src/discovery/provider-contract';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'dceeeeee-0000-4000-8000-0000000000d2';
const DOMAINS = ['xsrc-s1.test', 'xsrc-s2.test', 'xsrc-s3.test'] as const;
const ADAPTER = 'decision_maker';

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();

const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → RLS 被绕，证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

const rec = (fullName: string, extra: Partial<ProviderContactRecord> = {}): ProviderContactRecord => ({
  externalId: `${fullName}:${extra.email ?? 'noemail'}`,
  fullName,
  personalData: true,
  buyingRole: 'decision_maker',
  ...extra,
});

async function seedCompany(domain: string): Promise<{ id: string; dedupeKey: string }> {
  return prisma.withWorkspace(WS, async (tx) => {
    const company = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: domain } },
      update: { domain },
      create: { workspaceId: WS, name: `XSRC ${domain}`, domain, dedupeKey: domain, status: 'ENRICHED' },
    });
    return { id: company.id, dedupeKey: company.dedupeKey };
  });
}

async function persist(
  company: { id: string; dedupeKey: string },
  contacts: ProviderContactRecord[],
): Promise<void> {
  await prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, {
      workspaceId: WS,
      company,
      adapterKey: ADAPTER,
      contacts,
      suppressedEmails: new Set<string>(),
    }),
  );
}

async function readCompany(company: { id: string }): Promise<{
  contacts: { id: string; fullName: string; title: string | null }[];
  emails: string[];
  merges: { match_rule?: string }[];
}> {
  return prisma.withWorkspace(WS, async (tx) => {
    const contacts = await tx.canonicalContact.findMany({
      where: { companyId: company.id },
      select: { id: true, fullName: true, title: true },
    });
    const ids = contacts.map((c) => c.id);
    const points = await tx.contactPoint.findMany({ where: { contactId: { in: ids }, type: 'email' } });
    const evidence = await tx.fieldEvidence.findMany({
      where: { entityId: { in: ids }, field: 'identity.merge' },
    });
    return {
      contacts,
      emails: points.map((p) => p.value),
      merges: evidence.map((e) => e.value as { match_rule?: string }),
    };
  });
}

async function cleanup(): Promise<void> {
  await prisma.withWorkspace(WS, async (tx) => {
    const cos = await tx.canonicalCompany.findMany({
      where: { dedupeKey: { in: [...DOMAINS] } },
      select: { id: true },
    });
    const ids = cos.map((c) => c.id);
    if (!ids.length) return;
    const cts = await tx.canonicalContact.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
    const ctIds = cts.map((c) => c.id);
    if (ctIds.length) {
      await tx.contactPoint.deleteMany({ where: { contactId: { in: ctIds } } });
      await tx.fieldEvidence.deleteMany({ where: { entityId: { in: ctIds } } });
      await tx.canonicalContact.deleteMany({ where: { id: { in: ctIds } } });
    }
    await tx.canonicalCompany.deleteMany({ where: { id: { in: ids } } });
  });
}

console.log('\n█ 选项 B · 待办 2：跨源决策人身份解析——桥接合并 / 邮箱冲突守卫 / 称谓变体\n');
await cleanup();

// ══════════ 场景 1 · email/无-email 桥（并入无邮箱行）══════════
console.log('══ 场景 1 · 同一人先无邮箱、再带邮箱同名 → 单条合并行 ══');
const s1 = await seedCompany(DOMAINS[0]);
await persist(s1, [rec('Ruud Croonen', { title: 'Geschäftsführer' })]); // 无邮箱
await persist(s1, [rec('Ruud Croonen', { email: 'ruud.croonen@xsrc-s1.test' })]); // 带邮箱同名
const r1 = await readCompany(s1);
ok(r1.contacts.length === 1, `canonicalContact 仅 1 条（=${r1.contacts.length}）——email/无-email 桥合并`);
ok(r1.emails.includes('ruud.croonen@xsrc-s1.test'), 'email point 挂在合并行上');
ok(r1.merges.some((m) => m.match_rule === 'name_exact'), `identity.merge 证据存在（match_rule=${r1.merges.map((m) => m.match_rule).join(',')}）`);
ok(r1.contacts[0]?.title === 'Geschäftsführer', 'title 保留（第二次无 title，补空不覆盖）');

// ══════════ 场景 2 · 邮箱冲突守卫（同名不同邮箱不并）══════════
console.log('\n══ 场景 2 · 同公司同名不同邮箱两条 → 两条不并（🔴 绝不错并）══');
const s2 = await seedCompany(DOMAINS[1]);
await persist(s2, [
  rec('Anna Weber', { email: 'anna.a@xsrc-s2.test' }),
  rec('Anna Weber', { email: 'anna.b@xsrc-s2.test' }),
]);
const r2 = await readCompany(s2);
ok(r2.contacts.length === 2, `canonicalContact 两条（=${r2.contacts.length}）——邮箱冲突守卫拦住误并`);
ok(r2.emails.length === 2, `两个 email point 各挂各行（=${r2.emails.length}）`);
ok(r2.merges.length === 0, `无 identity.merge（未发生合并，=${r2.merges.length}）`);

// ══════════ 场景 3 · 称谓变体合并（归一名精确）══════════
console.log('\n══ 场景 3 · "Dr. Johann Schmidt"（无邮箱）+ "Johann Schmidt"（带邮箱）→ 合并 ══');
const s3 = await seedCompany(DOMAINS[2]);
await persist(s3, [rec('Dr. Johann Schmidt', { title: 'CTO' })]); // 无邮箱 c: 键含 "dr."
await persist(s3, [rec('Johann Schmidt', { email: 'j.schmidt@xsrc-s3.test' })]); // 归一名精确
const r3 = await readCompany(s3);
ok(r3.contacts.length === 1, `canonicalContact 仅 1 条（=${r3.contacts.length}）——称谓变体经 normalizePersonName 桥合并`);
ok(r3.emails.includes('j.schmidt@xsrc-s3.test'), 'email point 挂在合并行上');
ok(r3.merges.some((m) => m.match_rule === 'name_exact'), `identity.merge match_rule=name_exact（=${r3.merges.map((m) => m.match_rule).join(',')}）`);
ok(r3.contacts[0]?.title === 'CTO', 'title 保留 CTO（补空不覆盖）');

await cleanup();
console.log(`\n██ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ██`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
