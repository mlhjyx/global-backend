/**
 * P2 ICP→CPV 映射 —— 真库 + 真 API 端到端（无 sandbox，CLAUDE.md §5）。
 * **前置**：先跑 `node --import tsx scripts/seed-taxonomy.mjs`（写入 CPV 子树 + node 28 crosswalk）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-icp-to-cpv.mts
 *
 * 证明：§8.2 crosswalks 暴露 · resolveIcpToCpv 确定性 + 覆盖门 · buildTedQuery 注入 · 注入的
 *       filters 真驱动 TED 中标发现（闭环：ICP 文本 → CPV → TED 真拉公司）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ModelGateway } from '../src/model-gateway/model-gateway';
import { TaxonomyResolver } from '../src/discovery/taxonomy-resolver';
import { resolveIcpToCpv, buildTedQuery } from '../src/discovery/icp-to-cpv';
import { TedDiscoveryProvider } from '../src/discovery/providers/ted.provider';
import { sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

// TaxonomyResolver 需要一个 ModelGateway，但确定性路径（allowLlm:false）永不调用它。
const noLlm = { generateStructured: async () => { throw new Error('no-llm in deterministic verify'); } } as unknown as ModelGateway;

async function main() {
  const tax = new TaxonomyResolver(prisma, noLlm);

  // ══════════ Tier 1 · 真库 taxonomy（§8.2 + resolveIcpToCpv）══════════
  console.log('\n══ Tier 1 · 真库 taxonomy：§8.2 crosswalks 暴露 + resolveIcpToCpv 确定性 ══');
  const ind = await tax.resolve('industry', 'pumps', { allowLlm: false });
  ok(!!ind?.crosswalks?.cpv?.includes('42120000'), `§8.2 industry('pumps').crosswalks.cpv 含 42120000（=${JSON.stringify(ind?.crosswalks?.cpv)}）`);
  const de = await tax.resolve('country', 'Germany', { allowLlm: false });
  ok(de?.crosswalks?.alpha3?.[0] === 'DEU', `country('Germany').crosswalks.alpha3[0]=DEU（=${JSON.stringify(de?.crosswalks?.alpha3)}）`);

  const r = await resolveIcpToCpv(tax, { industryTerms: ['pumps'], targetCountries: ['Germany'] }, { allowLlm: false });
  console.log(`   resolveIcpToCpv(pumps, Germany) → cpv=${JSON.stringify(r.cpvCodes)} buyer=${JSON.stringify(r.buyerCountries)} warn=${r.warnings.length}`);
  ok(r.cpvCodes.includes('42120000') && r.buyerCountries[0] === 'DEU' && r.warnings.length === 0, '确定性解析 → cpv⊇42120000 + DEU + 无 warning');

  const rUs = await resolveIcpToCpv(tax, { industryTerms: ['pumps'], targetCountries: ['United States'] }, { allowLlm: false });
  ok(rUs.buyerCountries.length === 0 && rUs.warnings.some((w) => /icp_fit_warning/.test(w)), `覆盖门：US → buyer 空 + icp_fit_warning（=${rUs.warnings[0] ?? '—'}）`);

  // 注入（§8.7）：真解析结果 → TED 查询
  const queries = buildTedQuery(r, []);
  const ted = queries.find((q) => q.filters.source_hint === 'ted');
  ok(!!ted && String(ted.filters.cpv).startsWith('4212') && ted.filters.buyer_country === 'DEU', `buildTedQuery 注入 source_hint=ted（cpv=${ted?.filters.cpv} buyer=${ted?.filters.buyer_country}）`);

  // ══════════ Tier 2 · 真 API：注入的 filters 真驱动 TED（闭环）══════════
  console.log('\n══ Tier 2 · 真 API：ICP→CPV 注入的 filters → TED 真拉中标公司（闭环）══');
  const provider = new TedDiscoveryProvider({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
  const res = await provider.discoverCompanies({
    sourceClass: 'public_intelligence',
    filters: { ...ted!.filters, since_days: 90 },
    keywords: [],
    limit: 10,
  });
  console.log(`   TED 用计划注入 filters（cpv=${ted!.filters.cpv}, buyer=${ted!.filters.buyer_country}）拉到 ${res.records.length} 家`);
  for (const c of res.records.slice(0, 5)) console.log(`   · ${c.name} [${c.country ?? '?'}]`);
  ok(res.records.length > 0, 'TED 用 ICP→CPV 注入的 filters 真拉到中标公司（闭环成立）');
}

try {
  await main();
} finally {
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
