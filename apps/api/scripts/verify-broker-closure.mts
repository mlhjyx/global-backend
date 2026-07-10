/**
 * 收口② ExecutionContext + Broker 真收口 —— 真实数据端到端（真库真 API，无 sandbox，CLAUDE.md §5）。
 * 需 postgres + new-api 网关 + crawl4ai 在跑。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-broker-closure.mts
 *
 * 验收三条（release-plan ②）+ 机制证明（有界样本）：
 *   A · source_policy fail-closed：required 工具未登记域拒绝；SUSPENDED 真库翻转 → Broker 真拦；恢复后放行。
 *   B · 预算超限真拦截：Broker 工具门（reserve 抛 BudgetExceededError）+ LLM 网关门（模型不被调用）。
 *   C · AI trace 写入成功：真 workspace uuid 经网关调用 → ai_trace 行真实落库（旧伪 workspace 'discovery'
 *       会 22P02 静默丢失——负向对照断言 0 行）。
 *   D · 主链经 Broker 仍出真数据：ted.search 真拉中标（CC BY 4.0）、crawl4ai.render 真渲染、
 *       http.get SSRF 护栏真拦内网。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { buildGatewayProvider } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';
import { budgetLedger, BudgetExceededError } from '../src/tools/budget';
import { ToolPolicyDenied } from '../src/tools/tool-broker';
import type { TedSearchInput, TedSearchOutput, HttpGetInput, HttpGetOutput } from '../src/tools/source-tools';
import type { CrawlHtmlResult } from '../src/adapters/web-crawler';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = randomUUID(); // 真实合法 uuid（ai_trace 列 @db.Uuid；无 FK，RLS uuid cast 是关键）
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await ownerDb.$connect();

  // 🛡️ RLS 证明前提：app 连接绝不能是 superuser（superuser 静默绕 RLS，证明失效）
  const [{ is_super }] = await prisma.$queryRawUnsafe<{ is_super: boolean }[]>(
    `select rolsuper as is_super from pg_roles where rolname = current_user`,
  );
  check('app 连接非 superuser（RLS 证明有效前提）', is_super === false);

  // ── 0. seed：source_policy 治理域登记（worker/API 启动幂等 seed 的同一路径）──
  await new DiscoveryProviderRegistry().seed(ownerDb);
  const governed = ['query.wikidata.org', 'www.wikidata.org', 'overpass-api.de', 'api.gleif.org', 'algolia.net', 'mapyourshow.com', 'api.ted.europa.eu', 'api.fda.gov'];
  const rows = await ownerDb.sourcePolicy.findMany({ where: { domain: { in: governed } }, select: { domain: true } });
  check('required 治理域 8 行全部登记（seed 幂等）', rows.length === 8, `got ${rows.length}`);

  const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });

  // ── A. source_policy fail-closed ──
  const unreg = await broker.checkSourcePolicy('wikidata.entity', 'not-registered.example');
  check('A1 required 工具 + 未登记域 → denied(unregistered)', !unreg.allowed && unreg.reason === 'unregistered');

  const noReader = buildToolBroker({});
  const noReaderChk = await noReader.checkSourcePolicy('ted.search', 'api.ted.europa.eu');
  check('A2 required 工具 + 无 reader → denied(policy_unavailable)（忘注入即拒）', !noReaderChk.allowed && noReaderChk.reason === 'policy_unavailable');

  const advisory = await broker.checkSourcePolicy('crawl4ai.fetch', 'some-company.example');
  check('A3 advisory 工具 + 未登记标的域 → 放行（不杀发现引擎）', advisory.allowed);

  // SUSPENDED 真库翻转 → Broker 真拦（api.fda.gov）→ 恢复
  await ownerDb.sourcePolicy.update({ where: { domain: 'api.fda.gov' }, data: { reviewStatus: 'SUSPENDED' } });
  try {
    let denied = false;
    try {
      await broker.invoke('openfda.search', { kind: 'registration', params: { productCodes: ['LLZ'], limit: 1, maxRecords: 1 } }, { workspaceId: WS });
    } catch (err) {
      denied = err instanceof ToolPolicyDenied && /SUSPENDED/.test(String(err));
    }
    check('A4 SUSPENDED 真库翻转 → invoke 真拦（ToolPolicyDenied，零出网）', denied);
  } finally {
    await ownerDb.sourcePolicy.update({ where: { domain: 'api.fda.gov' }, data: { reviewStatus: 'APPROVED' } });
  }

  // ── B. 预算超限真拦截 ──
  budgetLedger.open('verify-tool-budget', 0); // 0¢ 账户
  let toolBlocked = false;
  try {
    await broker.invoke('crawl4ai.fetch', { url: 'https://example.com/' }, { workspaceId: WS, runId: 'verify-tool-budget' });
  } catch (err) {
    toolBlocked = err instanceof BudgetExceededError;
  }
  budgetLedger.close('verify-tool-budget');
  check('B1 Broker 工具门：0¢ 账户 → reserve 抛 BudgetExceededError（工具不执行）', toolBlocked);

  // LLM 网关门：真网关（new-api），但预算在 reserve 处拦 → 模型不被调用、零 token 消耗
  const registry = new ModelProviderRegistry();
  const gwProvider = buildGatewayProvider();
  if (!gwProvider) throw new Error('MODEL_GATEWAY_URL 未配置（需 new-api 在跑）');
  registry.register(gwProvider);
  const gateway = new RouterModelGateway(new ModelRouter(registry), new AiTraceSink(prisma));

  budgetLedger.open('verify-llm-budget', 3); // taxonomy.normalize maxCostCents=5 > 3
  let llmBlocked = false;
  try {
    await gateway.generateStructured(
      { task: 'taxonomy.normalize', prompt: 'x', schema: { type: 'object' } },
      { workspaceId: WS, runId: 'verify-llm-budget' },
    );
  } catch (err) {
    llmBlocked = err instanceof BudgetExceededError;
  }
  budgetLedger.close('verify-llm-budget');
  check('B2 LLM 网关门：3¢ 账户 < est 5¢ → 真拦截（模型不被调用）', llmBlocked);

  // ── C. AI trace 写入成功（真 LLM 调用 + 真库断言）──
  const before = Date.now();
  const norm = await gateway.generateStructured<{ code: string | null }>(
    {
      task: 'taxonomy.normalize',
      prompt: '把词「Germany」归一到候选码表 [{"code":"DE","en":"Germany"},{"code":"FR","en":"France"}] 中的一个 code，只输出 JSON：{"code":"..."}',
      schema: { type: 'object', required: ['code'], properties: { code: { type: ['string', 'null'] } } },
      model: 'deepseek-v4-flash',
    },
    { workspaceId: WS, correlationId: 'verify-broker-closure' },
  );
  check('C1 真 LLM 调用成功（new-api）', norm.data != null, `code=${norm.data?.code}`);
  // fire-and-forget 落库 → 轮询等待
  let traceRows = 0;
  for (let i = 0; i < 20 && traceRows === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
    traceRows = await prisma.withWorkspace(WS, (tx) =>
      tx.aiTrace.count({ where: { workspaceId: WS, task: 'taxonomy.normalize', createdAt: { gte: new Date(before) } } }),
    );
  }
  check('C2 ai_trace 行真实写入目标 workspace（验收：AI trace 写入成功）', traceRows >= 1, `rows=${traceRows}`);
  const usageRows = await prisma.withWorkspace(WS, (tx) => tx.usageLedger.count({ where: { workspaceId: WS, resourceType: 'ai_tokens' } }));
  check('C3 usage_ledger(ai_tokens) 连带入账', usageRows >= 1, `rows=${usageRows}`);

  // 负向对照：伪 workspace 'discovery'（旧缺陷）→ 静默失败、零行（不阻断主流程）
  new AiTraceSink(prisma).record({ workspaceId: 'discovery', task: 'verify.negative', op: 'generateText', provider: 'x', model: 'm', status: 'OK', latencyMs: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  const fakeRows = await ownerDb.aiTrace.count({ where: { task: 'verify.negative' } });
  check('C4 负向对照：伪 workspace → 22P02 静默零行（这正是收口②消灭的缺陷路径）', fakeRows === 0, `rows=${fakeRows}`);

  // ── D. 主链经 Broker 仍出真数据（有界样本）──
  const ted = await broker.invoke<TedSearchInput, TedSearchOutput>(
    'ted.search',
    { kind: 'award', params: { cpvCodes: ['42120000'], buyerCountries: ['DEU'], sinceDays: 60, maxRecords: 5 } },
    { workspaceId: WS, correlationId: 'verify-broker-closure' },
  );
  check('D1 ted.search 经 Broker 真拉中标（泵+德国，有界 5 条）', (ted.data.awards ?? []).length > 0, `awards=${ted.data.awards?.length}`);

  const rendered = await broker.invoke<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }>(
    'crawl4ai.render',
    { url: 'https://example.com/' },
    { workspaceId: WS },
  );
  check('D2 crawl4ai.render 经 Broker 真渲染 HTML', !rendered.data.robotsBlocked && rendered.data.html.length > 100, `html=${rendered.data.html.length}B`);

  const ssrf = await broker.invoke<HttpGetInput, HttpGetOutput>('http.get', { url: 'http://169.254.169.254/latest/meta-data/' }, { workspaceId: WS });
  check('D3 http.get SSRF 护栏：云元数据 IP → blocked（零出网）', !!ssrf.data.blocked, `blocked=${ssrf.data.blocked}`);

  const sitemap = await broker.invoke<HttpGetInput, HttpGetOutput>('http.get', { url: 'https://www.iana.org/robots.txt' }, { workspaceId: WS });
  check('D4 http.get 经 Broker 真拉公网文本', sitemap.data.ok && sitemap.data.text.length > 0, `status=${sitemap.data.status}`);

  // 清理本次验证痕迹（ai_trace/usage_ledger 一次性 workspace 行）
  await ownerDb.usageLedger.deleteMany({ where: { workspaceId: WS } });
  await ownerDb.aiTrace.deleteMany({ where: { workspaceId: WS } });

  await prisma.$disconnect();
  await ownerDb.$disconnect();
  console.log(failed === 0 ? '\n全部断言通过 ✅' : `\n${failed} 条断言失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
