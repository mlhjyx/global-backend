import { createHash } from 'node:crypto';
import { getTask } from '../../ai-tasks/task-registry';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import type { ChatResponse } from '../../model-gateway/types';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import {
  runModelWebSearch,
  type ModelWebSearchCandidate,
  type ModelWebSearchTurn,
  type WebSearchToolHit,
} from '../model-web-search/model-web-search';
import { normalizeDomain } from '../identity';
import { settledModelFailureReason } from '../settled-model-failure';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
} from '../company-discovery-lineage';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { SearxngSearchOutput } from '../../tools/builtin-tools';

const PROVIDER_KEY = 'model_web_search' as const;
/** 结构确认任务的契约字面量（execution-authority 策略要求 getTask 用字面量或同文件单一声明常量）。 */
const SEARCH_TASK = 'discovery.web_search_candidates';
const LINEAGE_RESULT_SCHEMA = 'discovery-web-search-candidates/v1';
/** 可注册域名形态（与工具环 parseModelWebSearchAnswer 的域名校验一致）。 */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63})$/u;

/**
 * 模型驱动的联网搜索 provider（获客通路 A 第三步；WEB-1）。
 *
 * 两段式：
 *  1. 探索环 `runModelWebSearch`：模型自己规划检索词，经受治理工具执行搜索
 *     （SearXNG 免费，或 DeepSeek tools/search），直到给出候选 JSON；
 *  2. 结构确认 `discovery.web_search_candidates`（generateStructured + 持久投影）：
 *     以检索证据为唯一材料，由模型给出最终候选——这一步的 durable 回执就是本
 *     provider 的公司血缘（producerId=任务 id，schema discovery-web-search-candidates/v1）。
 *     探索环的搜索回执只是辅助回执（auxiliary），不进入公司血缘。
 *
 * 证据落地：最终候选必须能在实际检索结果里按主机名找到出处，否则丢弃（绝不接受
 * 模型凭空给出的域名）。记录按域名去重，blockedDomains 生效。
 *
 * 两个开关（关闭即回滚）：
 *  - `MODEL_WEB_SEARCH_PROVIDER=on`（默认 off）：provider 是否参与 discovery 路由；
 *  - `MODEL_WEB_SEARCH_EXECUTOR=searxng|deepseek`（默认 searxng）：检索执行器。
 *
 * 不变量：无 gateway/broker 时 fail-safe 返回空（绝不绕过 ToolBroker 出网）；
 * 执行控制错误（预算/取消）照常穿透，不吞；血缘无法证明即不返回血缘（执行面 fail-closed）。
 */
export class ModelWebSearchDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = PROVIDER_KEY;
  readonly classes: SourceClass[] = ['public_intelligence'];
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(
    private readonly deps: {
      gateway?: ModelGateway;
      broker?: ExecutionBroker;
      runtimeTelemetry?: RuntimeTelemetry;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private enabled(): boolean {
    return (this.env.MODEL_WEB_SEARCH_PROVIDER ?? '').trim() === 'on';
  }

  private executor(): 'searxng' | 'deepseek' {
    return (this.env.MODEL_WEB_SEARCH_EXECUTOR ?? '').trim() === 'deepseek'
      ? 'deepseek'
      : 'searxng';
  }

  private toolCtx(ctx: ExecutionContext): ToolContext {
    return { ...ctx, taskContractId: SEARCH_TASK, purpose: 'discovery' };
  }

  /**
   * 探索环的模型调用上下文：只带记账/抑制所需的字段，**不带** onDurableReceipt。
   * 探索轮次不是持久投影（无 durableResultSchema），若把父回执入口透传给网关，一旦
   * 网关为该 producer 结算出回执，它会以 auxiliary 身份进入执行事务——而
   * discovery.web_search_candidates 只能是公司血缘回执（分区互斥会拒绝）。
   */
  private modelCtx(ctx: ExecutionContext): {
    workspaceId: string;
    runId?: string;
    correlationId?: string;
    authorizeExternalAction?: () => Promise<boolean>;
  } {
    return {
      workspaceId: ctx.workspaceId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx.authorizeExternalAction
        ? { authorizeExternalAction: ctx.authorizeExternalAction }
        : {}),
    };
  }

  private emptyLineage(): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: PROVIDER_KEY,
        recordCount: 0,
        observations: [],
      }),
    };
  }

  private searcher(ctx: ExecutionContext): (q: string) => Promise<readonly WebSearchToolHit[]> {
    const broker = this.deps.broker!;
    if (this.executor() === 'deepseek') {
      return async (q) => {
        const res = await broker.invoke<{ query: string }, { results?: WebSearchToolHit[] }>(
          'deepseek.search',
          { query: q },
          this.toolCtx(ctx),
        );
        const rows = Array.isArray(res.data?.results) ? res.data.results : [];
        return rows.filter((row) => typeof row?.url === 'string' && row.url.length > 0);
      };
    }
    return async (q) => {
      const res = await broker.invoke<{ q: string }, SearxngSearchOutput>(
        'searxng.search',
        { q },
        this.toolCtx(ctx),
      );
      return res.data.results.map((row) => ({ url: row.url, title: row.title }));
    };
  }

  private icpText(query: CompanyDiscoveryQuery): string {
    const parts: string[] = [...query.keywords];
    for (const key of ['industry', 'product', 'role', 'region', 'country']) {
      const value = query.filters?.[key];
      if (typeof value === 'string' && value.trim()) parts.push(`${key}: ${value.trim()}`);
    }
    return parts.join('；') || 'B2B 潜在客户';
  }

  private marketHint(query: CompanyDiscoveryQuery): string | undefined {
    const country = query.filters?.country;
    return typeof country === 'string' && /^[A-Za-z]{2}$/u.test(country)
      ? country.toUpperCase()
      : undefined;
  }

  /**
   * 结构确认的输入：探索环的候选 + 实际检索结果的证据清单（域名 → URL/标题）。
   * 结构确认模型不能自己搜索，它的世界就是这个 prompt——证据必须原样带进来。
   */
  private confirmationPrompt(
    query: CompanyDiscoveryQuery,
    explored: readonly ModelWebSearchCandidate[],
    hits: readonly WebSearchToolHit[],
  ): string {
    const market = this.marketHint(query);
    const evidence = hits
      .filter((hit) => /^https:\/\//u.test(hit.url))
      .slice(0, 80)
      .map((hit) => `- ${hit.url}${hit.title ? ` — ${hit.title.slice(0, 120)}` : ''}`)
      .join('\n');
    return [
      `目标客户画像：${this.icpText(query)}`,
      market ? `目标市场：${market}` : '',
      '',
      '探索阶段候选（仅供参考，逐条核对后决定去留）：',
      JSON.stringify(
        explored.map((c) => ({
          companyName: c.companyName,
          domain: c.domain,
          countryCode: c.countryCode,
          evidenceUrls: c.evidenceUrls,
        })),
      ).slice(0, 4000),
      '',
      '实际检索结果证据（只允许报告出现在这里、或出现在探索候选证据里的公司）：',
      evidence,
      '',
      '只输出满足任务契约的 JSON；无法从上述证据确认的公司直接略过。',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (!this.enabled() || !this.deps.gateway || !this.deps.broker) {
      return this.emptyLineage();
    }
    const gateway = this.deps.gateway;
    const maxCandidates = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 20)));

    // ── 1. 探索环：模型规划检索词，经 ToolBroker 执行搜索（回执为 auxiliary）──
    const hits: WebSearchToolHit[] = [];
    let explored: readonly ModelWebSearchCandidate[];
    try {
      const loop = await runModelWebSearch(
        {
          generateChat: async (input): Promise<ModelWebSearchTurn> => {
            const response = await gateway.generateChatWithTools(
              {
                task: input.task,
                messages: [...input.messages],
                tools: [...input.tools],
              },
              this.modelCtx(ctx),
            );
            const data: ChatResponse = response.data;
            return {
              text: data.text,
              toolUses: data.toolUses.map((use) => ({
                id: use.id,
                name: use.name,
                input: use.input,
              })),
              stopReason: data.stopReason,
            };
          },
          search: async (q) => {
            const rows = await this.searcher(ctx)(q);
            hits.push(...rows);
            return rows;
          },
        },
        {
          icp: this.icpText(query),
          ...(this.marketHint(query) ? { market: this.marketHint(query) } : {}),
          maxCandidates,
        },
      );
      explored = loop.candidates;
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      // 探索失败、尚未发生血缘调用：诚实空结果 + 有效空血缘（单源失败不阻断其余源）。
      console.warn(`[model_web_search] explore failed: ${String(error).slice(0, 150)}`);
      return this.emptyLineage();
    }

    // ── 2. 结构确认：持久投影回执 = 本 provider 的公司血缘 ──
    const contract = getTask(SEARCH_TASK);
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: PROVIDER_KEY,
      producerId: SEARCH_TASK,
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    let confirmed: readonly ModelWebSearchCandidate[];
    try {
      const result = await executeStructuredTaskWithRuntime<{
        candidates: ModelWebSearchCandidate[];
      }>(
        gateway,
        {
          task: SEARCH_TASK,
          prompt: this.confirmationPrompt(query, explored, hits),
          ...(contract?.description ? { system: contract.description } : {}),
          ...(contract?.model ? { model: contract.model } : {}),
          schema: contract?.outputSchema ?? { required: ['candidates'] },
        },
        {
          ...ctx,
          durableResultSchema: LINEAGE_RESULT_SCHEMA,
          onDurableReceipt: collector.onDurableReceipt,
        },
        { telemetry: this.deps.runtimeTelemetry },
      );
      confirmed = Array.isArray(result.data?.candidates) ? result.data.candidates : [];
    } catch (error) {
      const settledReason = settledModelFailureReason(error);
      if (
        collector.isForwardingFailure(error) ||
        isDiscoveryCompanyLineageInvalid(error) ||
        (settledReason === undefined && isExecutionControlError(error))
      ) {
        throw error;
      }
      // 网关已结算出不可用答案（无持久结果）：记 failed，血缘仍然有效（记录数为 0）。
      // 其余失败结果未知——finish([]) 后血缘为 undefined，执行面 fail-closed。
      if (settledReason !== undefined) collector.markInvocationFailed();
      console.warn(`[model_web_search] confirm failed: ${String(error).slice(0, 150)}`);
      const observation = collector.finish([]);
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: PROVIDER_KEY,
          recordCount: 0,
          observations: [observation],
        }),
      };
    }

    // ── 3. 证据落地：只保留能在检索结果中按主机名找到出处的候选 ──
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const hitUrlsByHost = new Map<string, string[]>();
    for (const hit of hits) {
      if (!/^https:\/\//u.test(hit.url)) continue;
      const host = hostOf(hit.url);
      if (!host) continue;
      const urls = hitUrlsByHost.get(host) ?? [];
      urls.push(hit.url);
      hitUrlsByHost.set(host, urls);
    }
    const groundEvidence = (domain: string): string[] => {
      const urls: string[] = [];
      for (const [host, hostUrls] of hitUrlsByHost) {
        if (host === domain || host.endsWith(`.${domain}`)) {
          urls.push(...hostUrls);
        } else if (host.includes('.') && domain.endsWith(`.${host}`)) {
          // 反向包含只在一级/二级域名成立时允许：裸 TLD 主机（如 https://de/...）
          // 不能成为任意 .de 域名的证据。
          urls.push(...hostUrls);
        }
      }
      return [...new Set(urls)].slice(0, 3);
    };

    const now = new Date().toISOString();
    const records: ProviderCompanyRecord[] = [];
    const seen = new Set<string>();
    for (const candidate of confirmed) {
      const domain = normalizeDomain(candidate?.domain);
      // 结构输出只受长度约束，域名形态在这里再做一次落地校验（法域名 + 非空公司名）。
      if (!domain || !DOMAIN_RE.test(domain)) continue;
      if (seen.has(domain) || blocked.has(domain)) continue;
      const name = typeof candidate.companyName === 'string' ? candidate.companyName.trim() : '';
      if (!name) continue;
      const evidenceUrls = groundEvidence(domain);
      if (evidenceUrls.length === 0) continue; // 未在检索结果出现 → 不臆造
      seen.add(domain);
      const country =
        typeof candidate.countryCode === 'string' && /^[A-Z]{2}$/u.test(candidate.countryCode)
          ? candidate.countryCode
          : undefined;
      records.push({
        externalId: `${PROVIDER_KEY}:${domain}`,
        name: name.slice(0, 500),
        domain,
        ...(country ? { country } : {}),
        attributes: {
          evidenceUrls,
          searchQuery: candidate.query ?? null,
          discoveredBy: PROVIDER_KEY,
          searchExecutor: this.executor(),
        },
        provenance: {
          sourceUrl: evidenceUrls[0],
          fetchedAt: now,
          contentHash: createHash('sha256')
            .update(`${PROVIDER_KEY}:${domain}:${evidenceUrls.join(',')}`)
            .digest('hex'),
          parserVersion: 'model-web-search/v1',
        },
      });
    }

    const observation = collector.finish(records.map((_, index) => index));
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: PROVIDER_KEY,
      recordCount: records.length,
      observations: [observation],
    });
    return { records, costCents: 0, ...(lineage ? { lineage } : {}) };
  }
}

function hostOf(url: string): string | undefined {
  try {
    return normalizeDomain(new URL(url).hostname) ?? undefined;
  } catch {
    return undefined;
  }
}
