/**
 * verify-site-builder-m1b：P1 brandProfile 真机验证（§5 硬规矩，无 sandbox）。
 *
 * 四段：
 * ① 路由解析 + 网关真探活（brand_profile 路由主选微量真调——网关配置是活动的，用前探活不缓存结论）
 * ② researchBrand 真链路（真 ToolBroker → 真 searxng + 真 crawl4ai；robots 在工具层；
 *    SSRF 完整 egress gate 待 R1-safety，本脚本只允许开发者可信公开 URL）
 * ③ buildBrandProfile 全活动真跑（真库 intake+KB(BGE-M3) + 真研究 + 真模型 + evidence 闸）
 *    → brand_profile v1 落库、factSheet 全带合法 evidence、gaps 结构合规
 * ④ kb/status gaps 回填 + 重跑版本追加（v2，append-only）
 *
 * 依赖：cd /global/backend && docker compose -p global up -d postgres minio embeddings docling searxng crawl4ai new-api
 * 跑：cd /global/backend/apps/api && node --import tsx scripts/verify-site-builder-m1b.mts
 */
import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntakeService } from '../src/site-builder/intake.service';
import { KbService } from '../src/site-builder/kb.service';
import { StorageService } from '../src/site-builder/storage.service';
import { EmbeddingsClient } from '../src/site-builder/embeddings.client';
import { DoclingClient } from '../src/site-builder/docling.client';
import { resolveTaskRoute } from '../src/site-builder/agents/task-routes';
import { researchBrand } from '../src/site-builder/agents/brand-research';
import { EVIDENCE_SOURCE_TYPES, GapItem, RawFactItem } from '../src/site-builder/agents/brand-profile';
import { createSiteBuilderActivities } from '../src/temporal/site-builder.activities';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildGatewayProvider } from '../src/model-gateway/model-providers.config';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { budgetLedger, siteBuildBudgetCents } from '../src/tools/budget';

function ok(section: string, message: string): void {
  console.log(`  ✅ ${section} ${message}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  // ── ① 路由 + 网关探活 ────────────────────────────────────────────────
  console.log('① 路由解析 + 网关真探活');
  const route = resolveTaskRoute('site_builder.brand_profile');
  if (route.primary !== 'deepseek-v4-pro') throw new Error(`unexpected primary ${route.primary}`);
  const reg = new ModelProviderRegistry();
  const gp = buildGatewayProvider();
  if (!gp) throw new Error('MODEL_GATEWAY_URL/KEY 未配置——本 verify 必须真网关');
  reg.register(gp); // 刻意不注册 stub：探活失败要真失败
  const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
  const probeWs = randomUUID();
  const probe = await gateway.generateStructured<{ ok: boolean }>(
    {
      task: 'site_builder.brand_profile',
      prompt: 'Return exactly {"ok": true}.',
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      model: route.primary,
      maxTokens: 2000, // reasoning 模型：预算过小 content 为空（H2）
    },
    { workspaceId: probeWs },
  );
  if (probe.data.ok !== true) throw new Error('probe output mismatch');
  ok('探活', `${route.primary} 真调 OK（provider=${probe.provider}）`);

  // ── ② researchBrand 真链路 ───────────────────────────────────────────
  console.log('② researchBrand（真 searxng + 真 crawl4ai 经 ToolBroker）');
  const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
  const research = await researchBrand(
    { broker },
    {
      workspaceId: probeWs,
      runId: randomUUID(),
      companyName: 'KSB SE & Co. KGaA',
      industry: 'industrial pumps and valves',
      websiteUrl: 'https://www.ksb.com',
    },
  );
  const storefront = research.sources.filter((s) => s.sourceType === 'storefront').length;
  const web = research.sources.filter((s) => s.sourceType === 'web_research').length;
  console.log(`    sources: storefront=${storefront} web_research=${web} degraded=${research.degraded}`);
  if (research.sources.length === 0 && !research.degraded) {
    throw new Error('零来源却未标降级——降级语义失守');
  }
  for (const s of research.sources) {
    if (!s.url || !s.fetchedAt || !s.content) throw new Error(`source 结构不完整: ${s.url}`);
  }
  ok('研究', `${research.sources.length} 来源，结构完整（degraded=${research.degraded}）`);

  // ── ③ buildBrandProfile 全活动真跑 ───────────────────────────────────
  console.log('③ buildBrandProfile（真库+真 KB+真研究+真模型+evidence 闸）');
  const storage = new StorageService();
  await storage.onModuleInit();
  const kb = new KbService(prisma, new EmbeddingsClient(), new DoclingClient(), storage);
  const ws = randomUUID();
  const ctx = { userId: 'verify', workspaceId: ws, roles: [] };

  const intakeService = new IntakeService(prisma, { launchDemoV0: async () => undefined });
  const created = await intakeService.create(ctx, {
    company: { nameZh: '凯士比泵业验证站', nameEn: 'KSB SE & Co. KGaA' },
    industry: 'isic-2813',
    products: ['centrifugal pumps', 'industrial valves'],
    targetMarkets: ['DE', 'US'],
    hasWebsite: true,
    websiteUrl: 'https://www.ksb.com',
    businessEmail: 'sales@verify-m1b.example',
  });
  const siteId = created.siteId;
  // 有界样本 KB：一份真文本文档（真 BGE-M3 向量化真落库）
  await kb.ingestText(ctx, {
    siteId,
    source: 'upload',
    title: 'company-brief.md',
    text: [
      '# Company brief',
      'KSB manufactures centrifugal pumps and industrial valves.',
      'Key markets: Germany, United States. Export experience since decades.',
      'Products include high-pressure pumps for energy and water applications.',
    ].join('\n\n'),
  });

  const acts = createSiteBuilderActivities({ prisma, gateway, broker, kb });
  // 生产路径由 beginRefurbishRun 置 running；脚本模拟这个前置（run 守卫要求 running）
  const mkRunningRun = async (): Promise<string> => {
    const id = randomUUID();
    await prisma.withWorkspace(ws, (tx) =>
      tx.siteBuildRun.create({
        data: { id, workspaceId: ws, siteId, kind: 'refurbish', status: 'running' },
      }),
    );
    return id;
  };
  const runId = await mkRunningRun();
  const summary = await acts.buildBrandProfile({ workspaceId: ws, siteId, buildRunId: runId });
  console.log(
    `    v${summary.version}: facts=${summary.factCount} gaps=${summary.gapsCount} model=${summary.model} researchDegraded=${summary.researchDegraded}`,
  );
  if (summary.version !== 1) throw new Error('首跑版本应为 1');

  const row = await prisma.withWorkspace(ws, (tx) =>
    tx.brandProfile.findFirst({ where: { siteId }, orderBy: { version: 'desc' } }),
  );
  if (!row) throw new Error('brand_profile 未落库');
  const facts = (row.factSheet as unknown as RawFactItem[]) ?? [];
  for (const f of facts) {
    if (!f.evidence || !EVIDENCE_SOURCE_TYPES.includes(f.evidence.sourceType)) {
      throw new Error(`evidence 闸失守：${f.key} 无合法证据却在 factSheet`);
    }
    if (
      (f.evidence.sourceType === 'web_research' || f.evidence.sourceType === 'storefront') &&
      !f.evidence.url
    ) {
      throw new Error(`evidence 闸失守：${f.key} 网络证据缺 url`);
    }
  }
  const gaps = (row.gaps as unknown as GapItem[]) ?? [];
  for (const g of gaps) {
    if (!g.field || !g.reason || !g.hint) throw new Error('gap 结构不完整');
  }
  // C4 抽查：档案 JSON 里不应出现邮箱形态的个人数据
  const dump = JSON.stringify(row);
  if (/[a-z0-9._%+-]+@(?!verify-m1b)[a-z0-9.-]+\.[a-z]{2,}/i.test(dump)) {
    throw new Error('C4 失守：brand_profile 中出现邮箱');
  }
  ok('活动', `factSheet ${facts.length} 项全带合法 evidence；gaps ${gaps.length} 项结构合规；无邮箱 PII`);

  // ── ④ kb/status 回填 + 版本追加 ──────────────────────────────────────
  console.log('④ kb/status gaps 回填 + 重跑版本追加');
  const status = await kb.status(ctx, siteId);
  if (JSON.stringify(status.gaps) !== JSON.stringify(gaps)) {
    throw new Error('kb/status gaps 未回填最新 brand_profile');
  }
  const rerun = await acts.buildBrandProfile({ workspaceId: ws, siteId, buildRunId: await mkRunningRun() });
  if (rerun.version !== 2) throw new Error('重跑应追加 v2（append-only）');
  ok('回填', `kb/status gaps=${status.gaps.length} 命中；重跑 v${rerun.version} 追加不覆盖`);

  // ── ⑤ run 状态守卫（复审 Temporal F2）──────────────────────────────────
  console.log('⑤ run 守卫（cancelled → buildBrandProfile 早停拒绝，不写版本）');
  const cancelledRunId = randomUUID();
  await prisma.withWorkspace(ws, (tx) =>
    tx.siteBuildRun.create({
      data: { id: cancelledRunId, workspaceId: ws, siteId, kind: 'refurbish', status: 'cancelled' },
    }),
  );
  let guarded = false;
  try {
    await acts.buildBrandProfile({ workspaceId: ws, siteId, buildRunId: cancelledRunId });
  } catch (err) {
    guarded = /not running/.test(String(err));
  }
  if (!guarded) throw new Error('run 守卫失守：cancelled run 仍产出 brand profile');
  const versions = await prisma.withWorkspace(ws, (tx) => tx.brandProfile.count({ where: { siteId } }));
  if (versions !== 2) throw new Error(`守卫应阻止写版本，期望 2 版实得 ${versions}`);
  ok('守卫', `cancelled run 早停被拒（不烧模型），版本数仍 ${versions}`);

  // ── ⑥ 预算门（改动 1 + FIX A/B）：真 ledger + 真活动 ─────────────────────
  console.log('⑥ 预算门（默认 cap 真结算不打穿；小 cap → buildBrandProfile 打穿 → wasExhausted）');
  // (a) 反证：③ 的 runId 账户经 ensureRunBudget(默认 cap) 真跑——未误打穿，且真实结算令 remaining 下降
  if (budgetLedger.wasExhausted(runId)) throw new Error('预算门 false-trip：默认 cap 误判打穿');
  const remainingAfterRun = budgetLedger.remainingCents(runId);
  if (!(remainingAfterRun < siteBuildBudgetCents())) {
    throw new Error(`未见真实结算：remaining=${remainingAfterRun} 应 < cap ${siteBuildBudgetCents()}`);
  }
  budgetLedger.close(runId, { force: true });
  // (b) 打穿：SITE_BUILD_BUDGET_CENTS=1（buildBrandProfile 内 ensureRunBudget 立此 cap）→
  //     brand_profile LLM reserve(80¢) 必打穿；wasExhausted 须在 close 前查（close 清打穿标记）。
  const prevCap = process.env.SITE_BUILD_BUDGET_CENTS;
  process.env.SITE_BUILD_BUDGET_CENTS = '1';
  const tinyRunId = await mkRunningRun();
  budgetLedger.close(tinyRunId, { force: true }); // 干净起点（防残留账户）
  try {
    await acts.buildBrandProfile({ workspaceId: ws, siteId, buildRunId: tinyRunId });
  } catch {
    // 打穿→runAiTask 全模型被拒→抛错；生产由 workflow fail-safe 兜，此处直调捕获即可
  }
  const tinyExhausted = budgetLedger.wasExhausted(tinyRunId);
  budgetLedger.close(tinyRunId, { force: true });
  if (prevCap === undefined) delete process.env.SITE_BUILD_BUDGET_CENTS;
  else process.env.SITE_BUILD_BUDGET_CENTS = prevCap;
  if (!tinyExhausted) throw new Error('预算门失守：小 cap 未打穿（wasExhausted=false）');
  ok('预算门', `默认 cap remaining=${remainingAfterRun}¢ 真结算不打穿；小 cap(1¢) 真打穿 wasExhausted=true`);

  console.log('\n🎉 verify-site-builder-m1b 全绿');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('💥 verify 失败：', err);
  process.exit(1);
});
