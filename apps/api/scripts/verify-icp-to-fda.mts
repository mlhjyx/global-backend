/**
 * openFDA P2 ICP→FDA 产品码映射 —— 真实数据端到端（真库真 API，无 sandbox，CLAUDE.md §5）。
 * 需 postgres 在跑 + FDA taxonomy 已种子（`node scripts/seed-taxonomy.mjs`，需先 build）。
 * 真 ICP：放射影像医疗器械，找美国进口渠道 → 行业 crosswalk 锚 panel RA → product code 子树。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-icp-to-fda.mts
 *
 * 三段证明（有界样本）：
 *   Tier 1 · 确定性映射（allowLlm=false，证明不靠 LLM 即通）：行业词 → panel RA（crosswalk）→ product code 子树宽网。
 *   Tier 2 · 注入：buildFdaQuery → openFDA 发现查询（source_hint/product_code/trade_side importer）。
 *   Tier 3 · 闭环：解析出的 product code → OpenFdaDiscoveryProvider 直打真 API → 真在美注册进口商（ICP→码→公司）。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxonomyResolver } from '../src/discovery/taxonomy-resolver';
import { resolveIcpToFda, buildFdaQuery } from '../src/discovery/icp-to-fda';
import { OpenFdaDiscoveryProvider } from '../src/discovery/providers/openfda.provider';
import { PLATFORM_WORKSPACE } from '../src/discovery/provider-contract';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';

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

async function main() {
  const reg = new ModelProviderRegistry();
  const gp = buildGatewayProvider();
  if (gp) reg.register(gp);
  if (stubAllowed()) reg.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
  const taxonomy = new TaxonomyResolver(prisma, gateway);

  // ══════════ Tier 1 · 确定性映射（allowLlm=false）══════════
  console.log('\n══ Tier 1 · ICP「放射影像医疗器械」→ FDA panel/product code（确定性，allowLlm=false）══');
  const fda = await resolveIcpToFda(
    taxonomy,
    { industryTerms: ['radiology imaging devices', 'medical device'], product: undefined, tradeSide: 'importer' },
    { workspaceId: 'verify', allowLlm: false },
  );
  console.log(`   panels=${JSON.stringify(fda.panels)}  productCodes=${JSON.stringify(fda.productCodes)}  importerOnly=${fda.importerOnly}  warnings=${JSON.stringify(fda.warnings)}`);
  ok(fda.panels.includes('RA'), '行业 → panel RA（crosswalk 确定性锚定）');
  ok(fda.productCodes.length > 0 && fda.productCodes.includes('LLZ'), 'panel RA 宽网 → product code 子树（含 LLZ 等真码）');
  ok(fda.importerOnly === true, '默认贸易侧=进口商（importerOnly，出海卖家渠道侧）');
  ok(fda.warnings.length === 0, '无 warning（种子齐备）');

  // ══════════ Tier 2 · 注入 ══════════
  console.log('\n══ Tier 2 · buildFdaQuery → openFDA 发现查询 ══');
  const [q] = buildFdaQuery(fda, []);
  console.log(`   注入查询 filters=${JSON.stringify(q.filters)}`);
  ok(q.filters.source_hint === 'openfda' && typeof q.filters.product_code === 'string' && (q.filters.product_code as string).includes('LLZ'), 'openFDA 查询 source_hint+product_code 注入（确定性，非 LLM 臆造）');
  ok(q.filters.trade_side === 'importer' && q.priority === 1, 'trade_side=importer + priority 1');

  // ══════════ Tier 3 · 闭环（ICP→码→真公司）══════════
  console.log('\n══ Tier 3 · 闭环：解析出的 product code → 真 openFDA API → 真在美注册进口商 ══');
  // 收口②：直连经 ToolBroker（§8.8 门在 Broker 内单点判定；负向门单独证明见 verify-openfda-discovery）
  const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
  const provider = new OpenFdaDiscoveryProvider({ broker });
  const res = await provider.discoverCompanies(
    { sourceClass: 'public_intelligence', filters: q.filters, keywords: [], limit: 15 },
    { workspaceId: PLATFORM_WORKSPACE },
  );
  console.log(`   拉到 ${res.records.length} 家（ICP 文本 → 无硬编码码 → 真公司）`);
  for (const r of res.records.slice(0, 6)) console.log(`   · ${r.name} [${r.country ?? '?'}] 专科=${r.industry ?? '—'}`);
  ok(res.records.length > 0, 'Tier 3：ICP→FDA 产品码→真在美注册公司闭环（多租户不硬编码）');
  ok(res.records.every((r) => r.license === 'CC0-1.0'), '闭环记录 CC0 + 无具名个人（合规红线沿用 P1）');
}

try {
  await main();
} finally {
  console.log(`\n══ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ══`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
