/**
 * 待办 2 create 层收尾端到端实测（#54-D/#54-E / #62-2/#62-3）—— 真库真 RLS 真盲化，无 sandbox。
 * 直接跑 `persistDiscoveredContacts`，两场景 + 二次跑幂等断言：
 *   ① RISKY（#54-E）：既有 Anna 的邮箱点标 RISKY 后，同址不同名 Bob → **新建独立行**（不并回 Anna 的邮箱行）；
 *   ② 歧义（#54-D 硬化）：两条同名不同邮箱 Anna 共存后，来件**无邮箱** Anna → **新建独立第 3 行**（不并回任一），
 *      **且二次跑不生第 4 行**（纯 Approach A 会在此翻键生重复——本例正是幂等硬底）。
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-contact-decline-honor.mts
 *
 * ⚠️ 必须以 app_user（非 superuser）连接跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 * ⚠️ 纯落库路径（无网络/无 provider）：只验解析前置拒并 + create 层不碰撞键 + 幂等。
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

const WS = 'dceeeeee-0000-4000-8000-0000000000d3';
const DOMAINS = ['decline-risky.test', 'decline-ambig.test', 'decline-misjoin.test'] as const;
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
      create: { workspaceId: WS, name: `DECLINE ${domain}`, domain, dedupeKey: domain, status: 'ENRICHED' },
    });
    return { id: company.id, dedupeKey: company.dedupeKey };
  });
}

async function persist(
  company: { id: string; dedupeKey: string },
  contacts: ProviderContactRecord[],
): Promise<{ created: number; merged: number; skippedSuppressed: number }> {
  return prisma.withWorkspace(WS, (tx) =>
    persistDiscoveredContacts(tx, { workspaceId: WS, company, adapterKey: ADAPTER, contacts, suppressedEmails: new Set<string>() }),
  );
}

async function contactCount(company: { id: string }): Promise<number> {
  return prisma.withWorkspace(WS, (tx) => tx.canonicalContact.count({ where: { companyId: company.id } }));
}

async function markEmailRisky(company: { id: string }, email: string): Promise<void> {
  await prisma.withWorkspace(WS, async (tx) => {
    const cts = await tx.canonicalContact.findMany({ where: { companyId: company.id }, select: { id: true } });
    await tx.contactPoint.updateMany({
      where: { contactId: { in: cts.map((c) => c.id) }, type: 'email', value: email },
      data: { status: 'RISKY' },
    });
  });
}

async function cleanup(): Promise<void> {
  await prisma.withWorkspace(WS, async (tx) => {
    const cos = await tx.canonicalCompany.findMany({ where: { dedupeKey: { in: [...DOMAINS] } }, select: { id: true } });
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

console.log('\n█ 待办 2 create 层收尾：createContact 尊重 resolve 拒并（不碰撞键 + 同源再跑幂等）\n');
await cleanup();

// ══════════ 场景 ① · RISKY 同址不同名（#54-E）══════════
console.log('══ 场景 ① · 既有 Anna（邮箱后标 RISKY）+ 同址 Bob → 新建独立行（不并回 Anna） ══');
const cRisky = await seedCompany(DOMAINS[0]);
const shared = 'shared@catchall.test';
await persist(cRisky, [rec('Anna Weber', { email: shared })]); // Anna 用 catch-all 建行（键 e:shared）
await markEmailRisky(cRisky, shared); // 事后标 RISKY
const rBob = await persist(cRisky, [rec('Bob Jones', { email: shared })]); // 同址不同名
ok((await contactCount(cRisky)) === 2, `两条不并（Anna + Bob，=2）——catch-all/RISKY 误并被根治`);
ok(rBob.created === 1 && rBob.merged === 0, `Bob 记为新建（created=1, merged=0）`);
const rBob2 = await persist(cRisky, [rec('Bob Jones', { email: shared })]); // 二次跑
ok((await contactCount(cRisky)) === 2, `二次跑不生第 3 行（=2）——同源再跑幂等`);
ok(rBob2.merged === 1, `二次跑经 resolve 命中 Bob 行合并（merged=1）`);

// ══════════ 场景 ② · 同名歧义（#54-D 硬化 + 幂等硬底）══════════
console.log('\n══ 场景 ② · 两条同名不同邮箱 Anna + 来件无邮箱 Anna → 新建独立第 3 行、二次跑不生第 4 行 ══');
const cAmbig = await seedCompany(DOMAINS[1]);
await persist(cAmbig, [rec('Anna Weber', { email: 'anna.a@x.test' })]); // row1（e:anna.a）
await persist(cAmbig, [rec('Anna Weber', { email: 'anna.b@x.test' })]); // row2（e:anna.b，邮箱冲突 → 不并）
ok((await contactCount(cAmbig)) === 2, `两条同名不同邮箱共存（=2，邮箱冲突守卫）`);
const rAmb = await persist(cAmbig, [rec('Anna Weber')]); // 无邮箱 → 歧义拒并 → dx 键新建
ok((await contactCount(cAmbig)) === 3, `无邮箱 Anna 新建独立第 3 行（=3，不并回 row1/row2）`);
ok(rAmb.created === 1, `记为新建（created=1）`);
await persist(cAmbig, [rec('Anna Weber')]); // 二次跑
ok((await contactCount(cAmbig)) === 3, `🔴 二次跑不生第 4 行（=3）——歧义拒并键确定性 → 幂等（纯碰撞探测会在此翻键生重复）`);

// ══════════ 场景 ③ · 同名歧义但各带不同 VALID 邮箱（误并回归）══════════
console.log('\n══ 场景 ③ · 两条无邮箱同名董事 + 各带不同邮箱的两个同名人 → 各自成行（不塌成一行） ══');
const cMis = await seedCompany(DOMAINS[2]);
await persist(cMis, [rec('John Smith', { externalIds: [{ scheme: 'uk-ch-officer', value: 'OID111' }] })]); // R1（c:name，ext111）
await persist(cMis, [rec('John Smith', { externalIds: [{ scheme: 'uk-ch-officer', value: 'OID222' }] })]); // R2（ext 冲突→dx:x:222）
ok((await contactCount(cMis)) === 2, `两条无邮箱同名董事共存（=2，externalId 冲突守卫）`);
await persist(cMis, [rec('John Smith', { email: 'alice@acme.test' })]); // 歧义 → dx:e:alice
await persist(cMis, [rec('John Smith', { email: 'bob@gmail.test' })]); // 歧义 → dx:e:bob（≠ alice）
ok((await contactCount(cMis)) === 4, `🔴 alice/bob 各自成第 3/4 行（=4）——同名不同邮箱绝不塌成一行`);
await persist(cMis, [rec('John Smith', { email: 'alice@acme.test' })]); // alice 二次跑
ok((await contactCount(cMis)) === 4, `alice 二次跑经 Tier 1 命中合并（=4）——幂等`);

await cleanup();
await prisma.$disconnect();
console.log(failed ? `\n██ ❌ ${failed} 条断言失败 ██\n` : '\n██ ✅ 全部通过 ██\n');
process.exit(failed ? 1 : 0);
