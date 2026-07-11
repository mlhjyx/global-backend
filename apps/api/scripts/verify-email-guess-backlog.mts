/**
 * 存量邮箱猜测「主链自动触发」端到端实测（选项 B · P0.4，阶段⑤b）—— 真库真 SMTP、真 RLS，无 sandbox。
 * seed fit=match(挂 Lead) + 有域名 + 缺邮箱决策人 → 开 email_guess(ENABLED + config.lawfulBasis)
 * → 跑 guessEmailsBacklog 活动（有界 limit）→ 读回断言：
 *   ① contact_point 落库为 VALID/RISKY，且 field_evidence[email.guess] 的 RISKY allowedActions **不含 outreach**；
 *   ② canonical_company.emailGuessAttemptedAt 已 stamp；
 *   ③ 重跑幂等（水位新鲜 → scanned 减少/为 0，不再重锤 MX）；
 *   ④ 翻 DISABLED → skipped(kill_switch_disabled)；config 去 LIA → skipped(no_lawful_basis_configured)——红线可证伪。
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-email-guess-backlog.mts
 *
 * ⚠️ 前置：迁移 `add_email_guess_watermark` 必须先 apply（`pnpm --filter @global/db exec prisma migrate deploy`），
 *    否则 canonical_company.email_guess_attempted_at 列不存在、活动查询报错。
 * ⚠️ 必须以 app_user（非 superuser）连接跑，否则 RLS 被绕、证明无意义（开头硬 guard）。
 * ⚠️ Mac 端口25 常封 → SMTP 不可达 → 猜测多为 unverified(RISKY)：落库为 RISKY（无 outreach），诚实不谎报 VALID。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBacklogActivities } from '../src/temporal/backlog.activities';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { contactIdentity } from '../src/discovery/identity';
import { blindContactKey } from '../src/compliance/pii-crypto';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'dceeeeee-0000-4000-8000-0000000000c4';
const ICP = 'dceeeeee-0000-4000-8000-0000000000c5'; // 合成 icpId（Lead.icpId 无 FK；活动不解析 ICP）
const DOMAIN = 'osna-pumpen.de';
const NAME = 'OSNA GmbH (P0.4 backlog verify)';
const PERSON = 'Ruud Croonen';
const LIA = { basis: 'legitimate_interest', ref: 'DEMO-LIA-global-interim-p04' };

let failed = 0;
const ok = (cond: boolean, msg: string) => {
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
  console.error('❌ app 连接是 superuser → RLS 被绕，证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

async function setEmailGuess(status: 'ENABLED' | 'DISABLED', config: unknown): Promise<void> {
  await ownerDb.dataProvider.upsert({
    where: { key: 'email_guess' },
    update: { status, config: config as never },
    create: { key: 'email_guess', class: 'email_verification', status, costPerCallCents: 0, config: config as never },
  });
}

async function seed(): Promise<{ companyId: string; contactId: string }> {
  return prisma.withWorkspace(WS, async (tx) => {
    const company = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: DOMAIN } },
      update: { domain: DOMAIN, status: 'ENRICHED', emailGuessAttemptedAt: null },
      create: { workspaceId: WS, name: NAME, domain: DOMAIN, dedupeKey: DOMAIN, status: 'ENRICHED' },
    });
    // fit=match 挂 Lead（per ICP×公司）——backlogEligibleWhere 用 leads.some.fitVerdict='match' 过滤
    await tx.lead.upsert({
      where: { workspaceId_icpId_canonicalCompanyId: { workspaceId: WS, icpId: ICP, canonicalCompanyId: company.id } },
      update: { fitVerdict: 'match' },
      create: { workspaceId: WS, icpId: ICP, canonicalCompanyId: company.id, fitVerdict: 'match' },
    });
    // 缺邮箱具名决策人（补全对象）
    const cdk = blindContactKey(contactIdentity({ fullName: PERSON }, company.dedupeKey));
    const contact = await tx.canonicalContact.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: cdk } },
      update: { title: 'Geschäftsführer' },
      create: { workspaceId: WS, companyId: company.id, fullName: PERSON, title: 'Geschäftsführer', dedupeKey: cdk },
    });
    await tx.contactPoint.deleteMany({ where: { contactId: contact.id, type: 'email' } }); // 确保「缺邮箱」起点
    return { companyId: company.id, contactId: contact.id };
  });
}

async function cleanup(): Promise<void> {
  await prisma.withWorkspace(WS, async (tx) => {
    const cos = await tx.canonicalCompany.findMany({ where: { dedupeKey: DOMAIN }, select: { id: true } });
    const ids = cos.map((c) => c.id);
    if (!ids.length) return;
    const cts = await tx.canonicalContact.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
    const ctIds = cts.map((c) => c.id);
    if (ctIds.length) {
      await tx.contactPoint.deleteMany({ where: { contactId: { in: ctIds } } });
      await tx.fieldEvidence.deleteMany({ where: { entityId: { in: ctIds } } });
    }
    await tx.canonicalContact.deleteMany({ where: { id: { in: ctIds } } });
    await tx.lead.deleteMany({ where: { canonicalCompanyId: { in: ids } } });
    await tx.canonicalCompany.deleteMany({ where: { id: { in: ids } } });
  });
}

console.log('\n█ 选项 B · P0.4：邮箱猜测「主链自动触发」端到端——双闸门 + 补全 + 水位 + 幂等 + 红线可证伪\n');
await cleanup();

// ── 构建真 providers + gateway（走真 SMTP 验证器 smtp_self）──
const reg = new ModelProviderRegistry();
const gp = buildGatewayProvider();
if (gp) reg.register(gp);
if (stubAllowed()) reg.register(new StubModelProvider());
const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const providers = new DiscoveryProviderRegistry({ gateway, broker });
await providers.seed(ownerDb); // 幂等：确保 smtp_self ENABLED + email_guess 行存在
const acts = createBacklogActivities({ prisma, providers, gateway, ownerDb, broker });

// ══════════ 段 1 · 双闸全开 → 自动补全 + 落库 + 水位 ══════════
console.log('══ 段 1 · 双闸全开（email_guess ENABLED + config.lawfulBasis）→ 自动补全 ══');
const { contactId } = await seed();
await setEmailGuess('ENABLED', { lawfulBasis: LIA });
const r1 = await acts.guessEmailsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });
console.log('  guessEmailsBacklog 结果：', JSON.stringify(r1));
ok(!r1.skipped, '双闸过 → 未 skip');
ok(r1.scanned >= 1, `扫到目标公司（scanned=${r1.scanned} ≥ 1）`);

const { points, evidence, company } = await prisma.withWorkspace(WS, async (tx) => ({
  points: await tx.contactPoint.findMany({ where: { contactId, type: 'email' } }),
  evidence: await tx.fieldEvidence.findMany({ where: { entityId: contactId, field: 'email.guess' } }),
  company: await tx.canonicalCompany.findFirst({ where: { dedupeKey: DOMAIN }, select: { emailGuessAttemptedAt: true } }),
}));
ok(company?.emailGuessAttemptedAt != null, `水位已 stamp（emailGuessAttemptedAt=${company?.emailGuessAttemptedAt?.toISOString() ?? 'null'}）`);
for (const p of points) {
  console.log(`  contact_point: ${p.value}  status=${p.status}  verifiedAt=${p.verifiedAt ? p.verifiedAt.toISOString() : 'null'}`);
  ok(p.status === 'VALID' || p.status === 'RISKY', `落库 status ∈ {VALID,RISKY}（=${p.status}）`);
}
for (const e of evidence) {
  const v = e.value as Record<string, unknown>;
  const actions = e.allowedActions as unknown as string[];
  console.log(`  field_evidence[email.guess]: status=${v.status} verified=${v.verified} allowedActions=${JSON.stringify(actions)} personal_data=${v.personal_data}`);
  if (v.status === 'RISKY') ok(!actions.includes('outreach'), 'RISKY 猜测 allowedActions **不含 outreach**（未证实不可群发）');
  ok(v.personal_data === true, 'personal_data=true（人名邮箱隔离留痕）');
  ok(v.lawful_basis != null, 'lawful_basis 留痕（问责）');
}
if (!points.length) console.log('  （无 email point：本环境 SMTP 不可达/域无 MX → 诚实未落，水位仍 stamp）');

// ══════════ 段 2 · 重跑幂等（水位新鲜 → 离开过滤集）══════════
console.log('\n══ 段 2 · 重跑幂等（emailGuessAttemptedAt 新鲜 < 30d TTL → 不再入选）══');
const r2 = await acts.guessEmailsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });
console.log('  重跑结果：', JSON.stringify(r2));
ok(r2.scanned === 0, `水位新鲜 → 本公司离开过滤集（scanned=${r2.scanned} = 0，不重锤 MX）`);

// ══════════ 段 3 · kill-switch DISABLED → skip ══════════
console.log('\n══ 段 3 · kill-switch DISABLED → 一个都不探（红线可证伪）══');
await seed(); // 重置水位为 null，证明 skip 不是因为水位
await setEmailGuess('DISABLED', { lawfulBasis: LIA });
const r3 = await acts.guessEmailsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });
console.log('  DISABLED 结果：', JSON.stringify(r3));
ok(r3.skipped === true && r3.reason === 'kill_switch_disabled', 'DISABLED → skipped(kill_switch_disabled)');

// ══════════ 段 4 · ENABLED 但 config 无 LIA → skip ══════════
console.log('\n══ 段 4 · ENABLED 但 config 无 lawfulBasis → 一个都不探（红线可证伪）══');
await setEmailGuess('ENABLED', {});
const r4 = await acts.guessEmailsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });
console.log('  无 LIA 结果：', JSON.stringify(r4));
ok(r4.skipped === true && r4.reason === 'no_lawful_basis_configured', 'ENABLED+无LIA → skipped(no_lawful_basis_configured)');

// 收尾：关掉 email_guess（回默认 DISABLED）+ 清理 seed
await setEmailGuess('DISABLED', {});
await cleanup();

console.log(`\n██ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ██`);
await prisma.$disconnect();
await ownerDb.$disconnect();
process.exit(failed === 0 ? 0 : 1);
