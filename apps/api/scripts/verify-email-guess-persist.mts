/**
 * 邮箱猜测「落库」端到端实测（选项 B · P0.3）—— 真库真 SMTP，无 sandbox。
 * seed 一个缺邮箱的具名决策人 → service.guessEmailsForCompany（排列/格式学习 + 真 SMTP + 落库）
 * → 读回 contact_point(status/verifiedAt) + field_evidence(email.guess) 证明真进了库。
 *   node --import tsx scripts/verify-email-guess-persist.mts
 *
 * ⚠️ Mac 端口25 常封 → SMTP 不可达 → 猜测多为 unverified(RISKY)：落库为 RISKY contact_point
 *    （allowedActions 不含 outreach），诚实不谎报 VALID。VALID 命中需放行 25 出网的环境。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { contactIdentity } from '../src/discovery/identity';
import { blindContactKey } from '../src/compliance/pii-crypto';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'dceeeeee-0000-4000-8000-0000000000b0';
const DOMAIN = 'osna-pumpen.de';
const NAME = 'OSNA GmbH';
const PERSON = 'Ruud Croonen';

const prisma = new PrismaService();
await prisma.$connect();

async function main() {
  const reg = new ModelProviderRegistry();
  const gp = buildGatewayProvider();
  if (gp) reg.register(gp);
  if (stubAllowed()) reg.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
  const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
  const registry = new DiscoveryProviderRegistry({ gateway, broker });
  const service = new DiscoveryService(prisma, registry);
  const ctx = { userId: 'demo-user', workspaceId: WS, roles: ['admin'] };

  console.log('\n█ 选项 B · P0.3：邮箱猜测「落库」端到端——seed 缺邮箱决策人 → 猜 → 真进库\n');

  // ── seed：一个有域名的公司 + 一个缺邮箱的具名决策人（幂等 upsert）──
  const { companyId, contactId } = await prisma.withWorkspace(WS, async (tx) => {
    const company = await tx.canonicalCompany.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: DOMAIN } },
      update: { domain: DOMAIN, status: 'ACTIVE' },
      create: { workspaceId: WS, name: NAME, domain: DOMAIN, dedupeKey: DOMAIN },
    });
    const cdk = blindContactKey(contactIdentity({ fullName: PERSON }, company.dedupeKey));
    const contact = await tx.canonicalContact.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: WS, dedupeKey: cdk } },
      update: { title: 'Geschäftsführer' },
      create: { workspaceId: WS, companyId: company.id, fullName: PERSON, title: 'Geschäftsführer', dedupeKey: cdk },
    });
    // 清掉此人任何旧 email point，确保「缺邮箱」起点（幂等可重跑）
    await tx.contactPoint.deleteMany({ where: { contactId: contact.id, type: 'email' } });
    return { companyId: company.id, contactId: contact.id };
  });
  console.log(`  seed：公司 ${NAME}(${DOMAIN}) · 决策人 ${PERSON}（Geschäftsführer，无邮箱）\n`);

  // ── 调 service：猜测 + 落库（人名邮箱需 lawful-basis）──
  const LIA = { basis: 'legitimate_interest' as const, ref: 'DEMO-LIA-pump-outreach' };
  const summary = await service.guessEmailsForCompany(ctx, companyId, { lawfulBasis: LIA, maxProbe: 6 });
  console.log('  service.guessEmailsForCompany 汇总：', JSON.stringify(summary, null, 0));

  // ── 读回库里真结果 ──
  const { points, evidence } = await prisma.withWorkspace(WS, async (tx) => ({
    points: await tx.contactPoint.findMany({ where: { contactId, type: 'email' } }),
    evidence: await tx.fieldEvidence.findMany({ where: { entityId: contactId, field: 'email.guess' } }),
  }));

  console.log('\n  ── 库内读回 ──');
  for (const p of points) {
    console.log(`  contact_point: ${p.value}  status=${p.status}  verifiedAt=${p.verifiedAt ? p.verifiedAt.toISOString() : 'null'}`);
  }
  for (const e of evidence) {
    const v = e.value as Record<string, unknown>;
    console.log(`  field_evidence[email.guess]: pattern=${v.pattern} confidence=${v.confidence} status=${v.status} verified=${v.verified}`);
    console.log(`     allowedActions=${JSON.stringify(e.allowedActions)}  personal_data=${v.personal_data}  lawful_basis=${JSON.stringify(v.lawful_basis)}`);
  }
  if (!points.length) console.log('  （无 email point：本次猜测 blocked/exhausted/undeliverable，未落——诚实不造记录）');

  console.log('\n█ 说明：RISKY=未经 SMTP 证实的猜测，落库但 allowedActions 不含 outreach（不可群发）；');
  console.log('█       VALID=SMTP 证实（需放行端口25环境）才含 outreach；suppression 命中不落；人名邮箱全程 personal_data 隔离。');
}

try { await main(); } finally { await prisma.$disconnect(); }
