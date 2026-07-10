/**
 * TED P1 中标发现 —— 真实数据端到端（真库真 API，无 sandbox，CLAUDE.md §5）。
 * 需 postgres 在跑；new-api 网关在跑（fit 门用）。一个真 ICP：泵 + 德国 → CPV 42120000 + DEU。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-ted-discovery.mts
 *
 * 三段证明（有界样本，绝不 grind 全量）：
 *   Tier 1 · 真 API：provider.discoverCompanies 直打 TED → 真中标公司（名/ISO-3/税号/官网）+
 *            合规自检（绿事实记录**绝不含具名邮箱**）+ CC BY 4.0 署名。
 *   Tier 2 · 真落库：seed（ted → ENABLED）→ 真 executeQuery fan-out（source_hint=ted）→ raw →
 *            真 canonicalizeRun → canonical_company（attributes.ted 命名空间事实）。
 *   Tier 3 · 真 fit 门：judgeFitCompany 对落库公司跑四门判别（泵卖家 ICP）→ 打印 verdict。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createDiscoveryActivities, PlanQuery } from '../src/temporal/discovery.activities';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { TedDiscoveryProvider } from '../src/discovery/providers/ted.provider';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { judgeFitCompany, IcpBrief } from '../src/discovery/fit-judge';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // 一次性验证 workspace
const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa001';
const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa002';
const ICP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa003';
const RUN2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa004'; // §8.8 负向门一次性 run
const CPV = '42120000'; // 泵与压缩机
const COUNTRY = 'DEU';
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();
// 收口②：唯一执行闸门——直连与 registry 共用同一 ToolBroker（source_policy fail-closed）
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });

async function main() {
  // ══════════ Tier 1 · 真 API（provider 直打 TED）══════════
  console.log(`\n══ Tier 1 · 真 API：泵(CPV ${CPV}) + 德国(${COUNTRY}) 近 60 天中标公告 ══`);
  const provider = new TedDiscoveryProvider({ broker });
  const q = {
    sourceClass: 'public_intelligence' as const,
    filters: { cpv: CPV, buyer_country: COUNTRY, since_days: 60 },
    keywords: [],
    limit: 25,
  };
  const res = await provider.discoverCompanies(q, { workspaceId: WS });
  console.log(`   拉到 ${res.records.length} 家中标公司（去重后）`);
  for (const r of res.records.slice(0, 8)) {
    const ted = r.attributes?.ted as Record<string, unknown>;
    console.log(
      `   · ${r.name}  [${r.country ?? '?'}]  域名=${r.domain ?? '—'}  税号=${ted?.winner_identifier ?? '—'}  CPV=${(ted?.cpv as string[] | undefined)?.join(',') ?? '—'}`,
    );
  }
  ok(res.records.length > 0, 'Tier 1：真 API 返回 ≥1 家中标公司');
  ok(res.records.every((r) => !!r.name), '每条都有公司名（主解析键）');
  ok(
    res.records.every((r) => (r.attributes?.ted as Record<string, unknown>)?.license === 'CC-BY-4.0'),
    '每条带 CC BY 4.0 署名（license 义务）',
  );
  // 🔴 合规硬自检：绿事实记录里绝不出现具名邮箱/个人联系点
  const serialized = JSON.stringify(res.records);
  ok(!/@/.test(serialized) && !/"?winner[_-]?email"?/i.test(serialized), '🔴 绿记录里无邮箱/具名联系点（个人数据隔离）');

  if (!res.records.length) {
    console.log('   ⚠️ 近 60 天该 CPV+国别无中标公告，跳过 Tier 2/3（非失败，属数据稀疏）');
    return;
  }

  // ══════════ Tier 2 · 真落库（seed → executeQuery → canonicalizeRun）══════════
  console.log('\n══ Tier 2 · 真落库：seed(ted) → executeQuery(source_hint=ted) → canonicalizeRun ══');
  await new DiscoveryProviderRegistry().seed(ownerDb); // ted → data_provider ENABLED + source_policy
  const tedRow = await ownerDb.dataProvider.findUnique({ where: { key: 'ted' } });
  const polRow = await ownerDb.sourcePolicy.findUnique({ where: { domain: 'api.ted.europa.eu' } });
  ok(tedRow?.status === 'ENABLED' && tedRow.class === 'public_intelligence', 'data_provider ted 已 seed=ENABLED');
  ok(polRow?.personalData === true && polRow.reviewStatus === 'APPROVED', 'source_policy api.ted.europa.eu personalData=true/APPROVED');

  // 一次性 run（raw_source_record.runId FK → discovery_run）
  await ownerDb.discoveryRun.deleteMany({ where: { id: RUN } });
  await ownerDb.discoveryRun.create({ data: { id: RUN, workspaceId: WS, planId: PLAN, icpId: ICP, status: 'RUNNING' } });

  const reg = new ModelProviderRegistry();
  const gp = buildGatewayProvider();
  if (gp) reg.register(gp);
  if (stubAllowed()) reg.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
  const providers = new DiscoveryProviderRegistry({ gateway, broker }); // §8.8 用途门在 Broker 内单点判定（收口②）
  const acts = createDiscoveryActivities({ prisma, providers, gateway });

  const planQuery: PlanQuery = {
    source_class: 'public_intelligence',
    filters: { cpv: CPV, buyer_country: COUNTRY, since_days: 60, source_hint: 'ted' },
    keywords: [],
    priority: 1,
  };
  const exec = await acts.executeQuery({ workspaceId: WS, runId: RUN, query: planQuery });
  console.log(`   executeQuery：provider=${exec.provider} rawCount=${exec.rawCount}`);
  ok(exec.provider === 'ted', 'fan-out 命中 ted（source_hint 收窄生效）');
  ok(exec.rawCount > 0, `raw_source_record 落地 ${exec.rawCount} 条`);

  const canon = await acts.canonicalizeRun({ workspaceId: WS, runId: RUN });
  console.log(`   canonicalizeRun：companies=${canon.companies} suppressed=${canon.suppressed}`);
  ok(canon.companies > 0, `canonical_company 归一 ${canon.companies} 家`);

  const landed = await prisma.withWorkspace(WS, (tx) =>
    tx.canonicalCompany.findMany({ where: { workspaceId: WS }, take: 5 }),
  );
  const withTed = landed.filter((c) => !!(c.attributes as Record<string, unknown> | null)?.ted);
  ok(withTed.length > 0, 'canonical.attributes.ted 命名空间事实已写入');

  // ── §8.5 证据署名 + §8.4 税号身份 + §8.3 alpha-2（审查修正落库验证）──
  // 仅核验本 run 证据（field_evidence 无 FK → 跨 run 不级联删；按本 run raw 精确圈定，排除历史遗留行）。
  const runRawIds = await prisma.withWorkspace(WS, (tx) =>
    tx.rawSourceRecord.findMany({ where: { runId: RUN }, select: { id: true } }),
  );
  const ev = await prisma.withWorkspace(WS, (tx) =>
    tx.fieldEvidence.findMany({
      where: { workspaceId: WS, providerKey: 'ted', rawRecordId: { in: runRawIds.map((r) => r.id) } },
      select: { license: true },
    }),
  );
  ok(ev.length > 0 && ev.every((e) => e.license === 'CC BY 4.0'), `§8.5 field_evidence.license='CC BY 4.0'（本 run ${ev.length} 条，非 licensed）`);
  const keys = await prisma.withWorkspace(WS, (tx) =>
    tx.canonicalCompany.findMany({ where: { workspaceId: WS }, select: { dedupeKey: true, country: true } }),
  );
  ok(keys.some((k) => k.dedupeKey.startsWith('id:ted-natid:')), '§8.4 无域名中标方按税号成 id:ted-natid: key（防同名同国误并）');
  ok(keys.some((k) => k.country?.length === 2), '§8.3 canonical 国别已转 alpha-2（DE 非 DEU）');

  // ── §8.8 负向门：allowedPurpose 去掉 discovery → TED 直连被拒（不发请求、零落地）──
  await ownerDb.sourcePolicy.update({ where: { domain: 'api.ted.europa.eu' }, data: { allowedPurpose: ['enrichment'] } });
  await ownerDb.discoveryRun.deleteMany({ where: { id: RUN2 } });
  await ownerDb.discoveryRun.create({ data: { id: RUN2, workspaceId: WS, planId: PLAN, icpId: ICP, status: 'RUNNING' } });
  const exec2 = await acts.executeQuery({ workspaceId: WS, runId: RUN2, query: planQuery });
  ok(exec2.provider !== 'ted' && exec2.rawCount === 0, `§8.8 用途门：去 discovery 用途 → TED 零落地（provider=${exec2.provider}, raw=${exec2.rawCount}）`);
  await ownerDb.sourcePolicy.update({ where: { domain: 'api.ted.europa.eu' }, data: { allowedPurpose: ['discovery', 'enrichment'] } });

  // ══════════ Tier 3 · 真 fit 门 ══════════
  console.log('\n══ Tier 3 · 真 fit 门：泵部件卖家 ICP → judgeFitCompany（四门判别）══');
  const icpBrief: IcpBrief = {
    seller: 'Pump components & industrial machinery supplier',
    seller_summary: '出海卖家，供应泵、泵部件与工业机械配套，寻找欧盟公共采购中标的活跃买方/同行。',
    icp_name: 'EU pump & machinery buyers/peers',
    company_attributes: { industry: 'pumps, industrial machinery', keywords: ['pump', 'compressor', 'machinery'] },
    target_markets: ['DEU', 'EU'],
  };
  let judged = 0;
  for (const c of landed.slice(0, 3)) {
    const verdict = await judgeFitCompany(gateway, WS, icpBrief, {
      id: c.id,
      name: c.name,
      domain: c.domain,
      country: c.country,
      industry: c.industry,
      attributes: c.attributes,
    });
    console.log(`   · ${c.name} → fit=${verdict?.verdict ?? 'null(模型不可用/瞬时失败)'}`);
    if (verdict) judged++;
  }
  ok(judged > 0, 'Tier 3：fit 门在真数据上真实产出判别（match/weak/mismatch 皆算门跑通）');
}

try {
  await main();
} finally {
  // 清理（owner 连接绕 RLS）：删 run 级联 raw；删 canonical 级联 identity_link/field_evidence
  await ownerDb.sourcePolicy
    .update({ where: { domain: 'api.ted.europa.eu' }, data: { allowedPurpose: ['discovery', 'enrichment'] } })
    .catch(() => {}); // §8.8 负向门失败也复位策略
  await ownerDb.fieldEvidence.deleteMany({ where: { workspaceId: WS } }).catch(() => {}); // 无 FK，手动清（防跨 run 累积）
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } }).catch(() => {});
  await ownerDb.discoveryRun.deleteMany({ where: { id: { in: [RUN, RUN2] } } }).catch(() => {});
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
