import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { RequestContext } from '../auth/request-context';
import { getTask } from '../ai-tasks/task-registry';
import { mirrorExclusionRuleIndexes, qualify, RuleLike } from './rule-engine';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import {
  resolveIcpToCpv,
  buildTedQuery,
  boundedTargetCountries,
  collectIndustryTerms,
  TED_QUERY_SOURCE,
} from '../discovery/icp-to-cpv';
import { resolveIcpToFda, buildFdaQuery, FDA_QUERY_SOURCE } from '../discovery/icp-to-fda';
import { withIcpTradeRole } from '../discovery/icp-trade-role';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import {
  countLineageGatedColdPaths,
  hasPlannableSource,
  isSourceRunnable,
  plannerSourcePrompt,
  routePlannerQueries,
  scaleEstimatedVolume,
  withDroppedQueryNote,
} from '../discovery/plan-query-sources';
import { searchLanguagesForMarkets, type SearchLanguage } from '../discovery/search-localization';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { LangfuseRuntimeTelemetryService } from '../model-runtime';
import { type BudgetStore, TOOL_BUDGET_STORE, UnavailableBudgetStore } from '../tools/budget-store';
import { executeIcpBudgetedTask } from './icp-budget-execution';
import {
  assertFreshExecutionBudgetBinding,
  ExecutionBudgetAuthorityService,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-authority.service';
import { workspaceExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import {
  applyDomainAckConsumerTransaction,
  domainAggregateIdForReceipt,
} from '../durable-results/domain-ack-consumer-bindings';

interface IcpModelOutput {
  name: string;
  company_attributes: Record<string, unknown>;
  pain_points: string[];
  trigger_signals: string[];
  exclusions: string[];
  value_props: string[];
  target_markets: string[];
  personas: { title: string; goals: string[]; pain_points: string[] }[];
  buying_committee: { role: string; title: string; concerns: string[] }[];
  qualification_rules?: {
    kind: string;
    field: string;
    operator: string;
    value: unknown;
    weight?: number;
    rationale?: string;
  }[];
}

function isExecutionControlError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' &&
    (code.startsWith('BUDGET_') || code.startsWith('EXECUTION_BUDGET_'));
}

interface QueryPlanModelOutput {
  queries: {
    source_class: string;
    filters: Record<string, unknown>;
    keywords: string[];
    rationale: string;
    priority: number;
  }[];
  estimated_volume: number;
}

const RULE_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] as const;
const RULE_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'];

const json = (v: unknown): Prisma.InputJsonValue => (v ?? []) as Prisma.InputJsonValue;

const PLANNER_LANGUAGE_NAMES: Readonly<Record<SearchLanguage, string>> = Object.freeze({
  de: '德语', en: '英语', fr: '法语', it: '意大利语', es: '西班牙语', nl: '荷兰语', pl: '波兰语',
});

/**
 * Planner keywords go straight into the target market's search engine, so a
 * Chinese keyword wastes the search and every extraction behind it.
 */
function plannerKeywordLanguage(targetMarkets: unknown, companyAttributes: unknown): string {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const country = (companyAttributes as { country?: unknown } | null)?.country;
  const names = searchLanguagesForMarkets([...list(targetMarkets), ...list(country)])
    .map((code) => PLANNER_LANGUAGE_NAMES[code]);
  const rule = names.length > 1
    ? `每条查询的 keywords 必须用该查询 filters.country 所在国家的语言书写（本 ICP 涉及${names.join('、')}）`
    : `keywords 必须全部用${names[0] ?? '目标市场的当地语言'}书写`;
  const fallback = names.length ? '' : '无法确定时用英语。';
  return `keywords 会直接交给目标市场的搜索引擎。${rule}，使用当地行业的常用说法与同义词，不得出现中文。${fallback}filters 里的 industry、country 仍可用中文，供规范词表映射。`;
}

@Injectable()
export class IcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ModelGateway,
    private readonly runtimeTelemetry: LangfuseRuntimeTelemetryService,
    private readonly authority: ExecutionBudgetAuthorityService,
    private readonly providers: DiscoveryProviderRegistry,
    @Optional() @Inject(TOOL_BUDGET_STORE) private readonly budgetStore?: BudgetStore,
  ) {}

  /** AI-design an ICP from the seller company's APPROVED claims (PRD 5.4 / 7.5). */
  async generateFromCompany(
    ctx: RequestContext,
    companyId: string,
    compactJws?: string,
  ) {
    const verifiedGrant = await this.authority.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: workspaceExecutionBudgetRequestScope({
        operation: 'POST /companies/:companyId/icps',
        companyId,
      }),
    });
    const { company, claims, offerings } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const claims = await tx.claim.findMany({ where: { companyId, status: 'APPROVED' } });
      const offerings = await tx.offering.findMany({
        where: { companyId },
        orderBy: { confidence: 'desc' },
        take: 30,
      });
      return { company, claims, offerings };
    });

    if (claims.length === 0) {
      throw new BadRequestException({
        error: { code: 'NO_APPROVED_CLAIMS', message: '先审批一些企业事实(Claim)再生成 ICP' },
      });
    }

    // 前置条件不满足时不能消耗一次性 Grant：同一 company 的 request scope 固定，
    // 旧授权先占住账号后，重新取的 Grant 也会被 EXECUTION_BUDGET_GRANT_REUSED 拒绝。
    const binding = await this.authority.consumeVerifiedWorkspaceGrant(verifiedGrant);
    assertFreshExecutionBudgetBinding(binding);

    const contract = getTask('icp.design')!;
    const facts = claims.map((c) => `- [${c.type}] ${c.statement}`).join('\n');
    const products = offerings.length
      ? `\n产品/服务（官网抽取）：\n${offerings.map((o) => `- ${o.name}${o.description ? `：${o.description}` : ''}`).join('\n')}`
      : '';
    const prompt = `卖方企业：${company.name}${company.website ? ` (${company.website})` : ''}\n已确认的企业事实：\n${facts}${products}\n\n请据此设计其理想客户画像(ICP)、买家委员会与机器可评估的验证规则，输出中文。`;

    const result = await executeIcpBudgetedTask<IcpModelOutput>({
      budgetStore: this.budgetStore ?? new UnavailableBudgetStore('ICP generation requires an authoritative BudgetStore'),
      binding,
      durableResultSchema: 'icp-design/v1',
      execute: (budgetContext) => executeStructuredTaskWithRuntime<IcpModelOutput>(
        this.gateway,
        {
          task: contract.id,
          prompt,
          system: contract.description,
          model: contract.model,
          schema: contract.outputSchema,
        },
        { workspaceId: ctx.workspaceId, userId: ctx.userId, ...budgetContext },
        { telemetry: this.runtimeTelemetry },
      ),
    });
    const out = result.data;

    const icpId = result.durableReceipt
      ? domainAggregateIdForReceipt(result.durableReceipt, 'icp.design')
      : undefined;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const applied = await applyDomainAckConsumerTransaction({
        transaction: tx,
        producerId: 'icp.design',
        receipt: result.durableReceipt,
        domainAckKey: icpId ?? companyId,
        domainRevision: result.durableReceipt?.resultDigest ?? '1',
        apply: async (transaction) => {
      const icp = await transaction.icpDefinition.create({
        data: {
          ...(icpId ? { id: icpId } : {}),
          workspaceId: ctx.workspaceId,
          companyId,
          name: out.name ?? '未命名 ICP',
          status: 'HYPOTHESIS', // AI-generated, not yet backtested
          companyAttributes: json(out.company_attributes),
          painPoints: json(out.pain_points),
          triggerSignals: json(out.trigger_signals),
          exclusions: json(out.exclusions),
          valueProps: json(out.value_props),
          targetMarkets: json(out.target_markets),
        },
      });
      for (const p of out.personas ?? []) {
        await transaction.persona.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId: icp.id,
            title: p.title,
            goals: json(p.goals),
            painPoints: json(p.pain_points),
          },
        });
      }
      for (const r of out.buying_committee ?? []) {
        await transaction.buyingCommitteeRole.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId: icp.id,
            role: r.role,
            title: r.title,
            concerns: json(r.concerns),
          },
        });
      }
      // 结构化验证规则（LED-003）：AI 提议 → 落库 → 由确定性规则引擎评估。
      const proposed = (out.qualification_rules ?? []).flatMap((r) => {
        const kind = String(r.kind).toUpperCase();
        if (!RULE_KINDS.includes(kind as never) || !RULE_OPERATORS.includes(r.operator)) return []; // 丢弃不合法提议
        return [{ ...r, kind: kind as RuleLike['kind'] }];
      });
      // 评分规则 v3：拒绝与 MUST_HAVE 同 field 同 value 的镜像 EXCLUSION（否定操作符）——模型常把每条
      // MUST_HAVE 复述成 not_contains / not_in（xin ICP 22202d3c 6 条），公司属性是受控英文词表时它对每家
      // 公司都命中。MUST_HAVE 不满足本就 no_match，镜像只会把「复核」硬变成「拒绝」。
      const mirrored = new Set(mirrorExclusionRuleIndexes(proposed));
      for (const [index, r] of proposed.entries()) {
        if (mirrored.has(index)) continue;
        await transaction.qualificationRule.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId: icp.id,
            kind: r.kind as never,
            field: r.field,
            operator: r.operator,
            value: (r.value ?? null) as Prisma.InputJsonValue,
            weight: r.weight ?? 1,
            rationale: r.rationale ?? null,
          },
        });
      }
      return this.full(transaction, icp.id);
        },
      });
      return applied.value ?? this.full(tx, icpId!);
    });
  }

  list(ctx: RequestContext, companyId?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.icpDefinition.findMany({
        where: companyId ? { companyId } : {},
        orderBy: { createdAt: 'desc' },
        include: { personas: true, roles: true },
      }),
    );
  }

  get(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) => this.full(tx, icpId));
  }

  /**
   * Human Gate: promote to ACTIVE (PRD ICP state machine); emits ICPActivated.
   * Previous ACTIVE ICPs of the same company become SUPERSEDED (版本演进).
   */
  async activate(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      if (!['DRAFT', 'HYPOTHESIS', 'VALIDATING'].includes(icp.status)) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `icp is ${icp.status}; cannot activate` },
        });
      }
      await tx.icpDefinition.updateMany({
        where: { companyId: icp.companyId, status: 'ACTIVE', id: { not: icpId } },
        data: { status: 'SUPERSEDED' },
      });
      await tx.icpDefinition.update({
        where: { id: icpId },
        data: { status: 'ACTIVE', version: { increment: 1 } },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'ICPActivated',
          aggregateType: 'ICP',
          aggregateId: icpId,
          payload: { companyId: icp.companyId },
        },
      });
      return this.full(tx, icpId);
    });
  }

  /** 人工修订 ICP：AI 产出是假设，用户必须能改（乐观锁）。终态不可编辑。 */
  async update(
    ctx: RequestContext,
    icpId: string,
    patch: {
      name?: string;
      companyAttributes?: Record<string, unknown>;
      painPoints?: string[];
      triggerSignals?: string[];
      exclusions?: string[];
      valueProps?: string[];
      targetMarkets?: string[];
    },
    expectedVersion?: number,
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      if (['SUPERSEDED', 'ARCHIVED'].includes(icp.status)) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `icp is ${icp.status}; not editable` },
        });
      }
      if (expectedVersion != null && icp.version !== expectedVersion) {
        throw new ConflictException({
          error: { code: 'VERSION_CONFLICT', message: 'stale version', details: { current: icp.version } },
        });
      }
      await tx.icpDefinition.update({
        where: { id: icpId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.companyAttributes !== undefined ? { companyAttributes: json(patch.companyAttributes) } : {}),
          ...(patch.painPoints !== undefined ? { painPoints: json(patch.painPoints) } : {}),
          ...(patch.triggerSignals !== undefined ? { triggerSignals: json(patch.triggerSignals) } : {}),
          ...(patch.exclusions !== undefined ? { exclusions: json(patch.exclusions) } : {}),
          ...(patch.valueProps !== undefined ? { valueProps: json(patch.valueProps) } : {}),
          ...(patch.targetMarkets !== undefined ? { targetMarkets: json(patch.targetMarkets) } : {}),
          version: { increment: 1 },
        },
      });
      return this.full(tx, icpId);
    });
  }

  // ── QualificationRule CRUD（LED-003）──────────────────────────────────────

  async addRule(
    ctx: RequestContext,
    icpId: string,
    rule: { kind: string; field: string; operator: string; value: unknown; weight?: number; rationale?: string },
  ) {
    this.assertRuleShape(rule);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, select: { id: true } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      return tx.qualificationRule.create({
        data: {
          workspaceId: ctx.workspaceId,
          icpId,
          kind: rule.kind.toUpperCase() as never,
          field: rule.field,
          operator: rule.operator,
          value: (rule.value ?? null) as Prisma.InputJsonValue,
          weight: rule.weight ?? 1,
          rationale: rule.rationale ?? null,
        },
      });
    });
  }

  async updateRule(
    ctx: RequestContext,
    ruleId: string,
    patch: { kind?: string; field?: string; operator?: string; value?: unknown; weight?: number; rationale?: string },
  ) {
    if (patch.kind !== undefined || patch.operator !== undefined) {
      this.assertRuleShape({
        kind: patch.kind ?? 'MUST_HAVE',
        operator: patch.operator ?? 'eq',
        field: patch.field ?? 'x',
        value: patch.value,
      });
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rule = await tx.qualificationRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'rule not found' } });
      return tx.qualificationRule.update({
        where: { id: ruleId },
        data: {
          ...(patch.kind !== undefined ? { kind: patch.kind.toUpperCase() as never } : {}),
          ...(patch.field !== undefined ? { field: patch.field } : {}),
          ...(patch.operator !== undefined ? { operator: patch.operator } : {}),
          ...(patch.value !== undefined ? { value: patch.value as Prisma.InputJsonValue } : {}),
          ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
          ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
          version: { increment: 1 },
        },
      });
    });
  }

  async deleteRule(ctx: RequestContext, ruleId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rule = await tx.qualificationRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'rule not found' } });
      await tx.qualificationRule.delete({ where: { id: ruleId } });
      return { deleted: true };
    });
  }

  private assertRuleShape(rule: { kind: string; field: string; operator: string; value: unknown }) {
    if (!RULE_KINDS.includes(rule.kind.toUpperCase() as never)) {
      throw new BadRequestException({
        error: { code: 'INVALID_RULE', message: `kind must be one of ${RULE_KINDS.join('|')}` },
      });
    }
    if (!RULE_OPERATORS.includes(rule.operator)) {
      throw new BadRequestException({
        error: { code: 'INVALID_RULE', message: `operator must be one of ${RULE_OPERATORS.join('|')}` },
      });
    }
  }

  // ── 样例回测（LED-004）────────────────────────────────────────────────────

  /**
   * Deterministic backtest of the ICP's rules against known sample companies.
   * 这是 HYPOTHESIS → VALIDATING 的入口，也是 ACTIVE 决策的数据依据 —— 用
   * 真实样例检验 AI 推断（数据真实性原则对 ICP 的落法）。
   */
  async runBacktest(
    ctx: RequestContext,
    icpId: string,
    samples: { name: string; domain?: string; attributes: Record<string, unknown>; expected: 'match' | 'exclude' }[],
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, include: { rules: true } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      if (!icp.rules.length) {
        throw new BadRequestException({
          error: { code: 'NO_RULES', message: 'icp has no qualification rules to backtest' },
        });
      }
      const rules: RuleLike[] = icp.rules.map((r) => ({
        id: r.id,
        kind: r.kind as RuleLike['kind'],
        field: r.field,
        operator: r.operator,
        value: r.value,
        weight: r.weight,
      }));

      const results = samples.map((s) => {
        const q = qualify(rules, s.attributes ?? {});
        return { name: s.name, domain: s.domain ?? null, expected: s.expected, ...q };
      });

      const expMatch = results.filter((r) => r.expected === 'match');
      const expExclude = results.filter((r) => r.expected === 'exclude');
      const matchHit = expMatch.filter((r) => r.verdict === 'match').length;
      const excludeCaught = expExclude.filter((r) => ['exclude', 'no_match'].includes(r.verdict)).length;
      const evals = results.flatMap((r) => r.evaluations);
      const metrics = {
        matchHitRate: expMatch.length ? Number((matchHit / expMatch.length).toFixed(4)) : null,
        excludeCatchRate: expExclude.length ? Number((excludeCaught / expExclude.length).toFixed(4)) : null,
        unknownFieldRate: evals.length
          ? Number((evals.filter((e) => e.outcome === 'unknown').length / evals.length).toFixed(4))
          : null,
        recommendation:
          (expMatch.length === 0 || matchHit / Math.max(expMatch.length, 1) >= 0.7) &&
          (expExclude.length === 0 || excludeCaught / Math.max(expExclude.length, 1) >= 0.7)
            ? 'promote'
            : 'revise',
      };

      const backtest = await tx.icpBacktest.create({
        data: {
          workspaceId: ctx.workspaceId,
          icpId,
          samples: samples as never,
          results: results as never,
          metrics: metrics as never,
        },
      });
      // 状态机（PRD 11.9）：回测把假设推进到验证中；ACTIVE 仍需人工 Gate。
      if (['DRAFT', 'HYPOTHESIS'].includes(icp.status)) {
        await tx.icpDefinition.update({ where: { id: icpId }, data: { status: 'VALIDATING' } });
      }
      return backtest;
    });
  }

  listBacktests(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.icpBacktest.findMany({ where: { icpId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  // ── 查询计划（LED-005）────────────────────────────────────────────────────

  /** AI translates an ACTIVE ICP into an ordered multi-source query plan (Discover input). */
  async generateQueryPlan(
    ctx: RequestContext,
    icpId: string,
    compactJws?: string,
  ) {
    const verifiedGrant = await this.authority.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: workspaceExecutionBudgetRequestScope({
        operation: 'POST /icps/:icpId/query-plans',
        icpId,
      }),
    });
    // BI-30：规划时刻的数据源开关（data_provider.status）快照：提示词、查询过滤与冷路径注入都按它。
    const { icp, enabledSources } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => ({
      icp: await tx.icpDefinition.findUnique({ where: { id: icpId }, include: { rules: true } }),
      enabledSources: await this.providers.enabledCompanyDiscoverySources(tx),
    }));
    if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
    if (icp.status !== 'ACTIVE') {
      throw new ConflictException({
        error: { code: 'INVALID_STATE', message: `icp is ${icp.status}; query plans require an ACTIVE icp` },
      });
    }
    // 没有任何可规划的已启用数据源时，计划只会是空的：在调用模型之前拒绝，不花钱。
    // ted / openfda 只承载冷路径确定性生成的查询，单独启用它们不足以规划。
    if (!hasPlannableSource(enabledSources)) {
      throw new ConflictException({
        error: {
          code: 'NO_ENABLED_DISCOVERY_SOURCE',
          message: 'no ENABLED discovery data source with governed company lineage that the query planner can use',
        },
      });
    }

    // 同 generateFromCompany：只有前置状态合法才消耗一次性 Grant。
    const binding = await this.authority.consumeVerifiedWorkspaceGrant(verifiedGrant);
    assertFreshExecutionBudgetBinding(binding);

    const contract = getTask('discovery.query_plan')!;
    const icpBrief = {
      name: icp.name,
      company_attributes: icp.companyAttributes,
      target_markets: icp.targetMarkets,
      trigger_signals: icp.triggerSignals,
      exclusions: icp.exclusions,
      rules: icp.rules.map((r) => ({ kind: r.kind, field: r.field, operator: r.operator, value: r.value })),
    };
    const queryPlanPrompt = `ICP 定义：\n${JSON.stringify(icpBrief, null, 2)}\n\n请生成多源查询计划，输出中文 rationale。\n${plannerSourcePrompt(enabledSources)}\n${plannerKeywordLanguage(icp.targetMarkets, icp.companyAttributes)}`;
    const result = await executeIcpBudgetedTask<QueryPlanModelOutput>({
      budgetStore: this.budgetStore ?? new UnavailableBudgetStore('ICP query-plan generation requires an authoritative BudgetStore'),
      binding,
      durableResultSchema: 'icp-query-plan/v1',
      execute: (budgetContext) => executeStructuredTaskWithRuntime<QueryPlanModelOutput>(
        this.gateway,
        {
          task: contract.id,
          prompt: queryPlanPrompt,
          system: contract.description,
          model: contract.model,
          schema: contract.outputSchema,
        },
        { workspaceId: ctx.workspaceId, userId: ctx.userId, ...budgetContext },
        { telemetry: this.runtimeTelemetry },
      ),
    });
    const out = result.data;

    // BI-30：只保留路由得到已启用数据源的查询，每条写明唯一的源（filters.source_hint = 源键）；
    // 不可执行的查询按原因计数，记在首条规划查询的 rationale 里（与冷路径 warning 同处），人工门可见。
    const modelQueries = (out.queries ?? []) as QueryPlanModelOutput['queries'];
    const routing = routePlannerQueries(modelQueries, {
      enabled: enabledSources,
      registered: this.providers.companyDiscoverySources(),
    });
    // 血缘闸门：已启用却没有受治理血缘的冷路径源（TED/openFDA）不注入，也按 SOURCE_LINEAGE_UNAVAILABLE 记进移出说明。
    const dropped = countLineageGatedColdPaths(routing.dropped, enabledSources, [
      TED_QUERY_SOURCE,
      FDA_QUERY_SOURCE,
    ]);
    // G3 5.3：ICP 的贸易角色（分销商/制造商）确定性写进未带角色的 planner 查询，关键词搜索据此构造角色词。
    const planned = withDroppedQueryNote(
      withIcpTradeRole(routing.queries, icp.companyAttributes),
      dropped,
    );
    // §8.7 稳健：行业词仍从模型给出的全部查询采集（与数据源开关无关，只作冷路径解析的输入）。
    const industryTerms = collectIndustryTerms(icp.companyAttributes, modelQueries);
    // §2.3/§8.7 冷路径 ICP→CPV：解析 ICP 行业/产品/目标市场 → CPV + buyer-country，确定性注入一条
    // TED 中标发现查询（LLM 绝不臆造 CPV 码）。人工门（DRAFT→READY）可见解析结果 + 覆盖 warning。
    // BI-30：TED 未启用时不解析、不注入（解析本身要花词表归一的模型调用）；血缘闸门：TED 没有受治理血缘时同样不注入。
    let queries = isSourceRunnable(enabledSources, TED_QUERY_SOURCE)
      ? await this.injectTedQuery(icp, planned, industryTerms, binding)
      : planned;
    // §2.3/§8.7 冷路径 ICP→FDA：解析 ICP 行业/产品/贸易侧 → FDA product code + importer 过滤，确定性注入 openFDA 发现查询。
    // BI-30：openFDA 未启用或没有受治理血缘时同样不解析、不注入。
    queries = isSourceRunnable(enabledSources, FDA_QUERY_SOURCE)
      ? await this.injectFdaQuery(icp, queries, industryTerms, binding)
      : queries;
    if (queries.length === 0) {
      // 模型给出的查询全落在不可用的数据源上，冷路径也没有注入：不存一份执行不了的计划。
      throw new ConflictException({
        error: {
          code: 'NO_RUNNABLE_QUERIES',
          message: 'the query plan has no query for an ENABLED discovery data source',
        },
      });
    }
    // 规划查询一条不剩、只有冷路径注入的查询时，移出说明记在计划的首条查询上。
    if (planned.length === 0) queries = withDroppedQueryNote(queries, dropped);

    const queryPlanId = result.durableReceipt
      ? domainAggregateIdForReceipt(result.durableReceipt, 'discovery.query_plan')
      : undefined;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const applied = await applyDomainAckConsumerTransaction({
        transaction: tx,
        producerId: 'discovery.query_plan',
        receipt: result.durableReceipt,
        domainAckKey: queryPlanId ?? icpId,
        domainRevision: result.durableReceipt?.resultDigest ?? '1',
        apply: (transaction) => transaction.discoveryQueryPlan.create({
        data: {
          ...(queryPlanId ? { id: queryPlanId } : {}),
          workspaceId: ctx.workspaceId,
          icpId,
          status: 'DRAFT', // 人工确认（→READY）后才可被 Discover 执行
          queries: queries as never,
          // BI-30：模型的估算覆盖它写的全部查询，按留下的比例折算，只计会执行的查询。
          estimatedVolume: scaleEstimatedVolume(
            out.estimated_volume,
            modelQueries.length,
            routing.keptModelQueries,
          ),
        },
      }),
      });
      if (applied.value) return applied.value;
      return tx.discoveryQueryPlan.findUniqueOrThrow({
        where: { id: queryPlanId! },
      });
    });
  }

  /**
   * §2.3 冷路径：把 ICP→CPV 解析出的 TED 中标发现查询前置进计划（priority 1）。
   * fail-safe：解析失败/无覆盖国 → 不阻断计划（其余源照常）；覆盖 warning 附到 rationale，人工门可见。
   * CPV/国别全由确定性 crosswalk 解析注入，planner LLM 绝不臆造码。
   */
  private async injectTedQuery(
    icp: { companyAttributes: Prisma.JsonValue; targetMarkets: Prisma.JsonValue },
    planned: QueryPlanModelOutput['queries'],
    // §8.7 稳健：从 company_attributes + planner 各查询双路采集的行业词（拆逗号），防单字段缺失/合并串漏掉 TED 注入。
    industryTerms: string[],
    binding: ExecutionBudgetBinding,
  ): Promise<QueryPlanModelOutput['queries']> {
    const attrs = (icp.companyAttributes ?? {}) as Record<string, unknown>;
    const targetCountries = boundedTargetCountries(icp.targetMarkets);
    try {
      const taxonomy = new TaxonomyResolver(this.prisma, this.gateway, this.runtimeTelemetry, this.budgetStore);
      const cpv = await resolveIcpToCpv(
        taxonomy,
        { industryTerms, product: attrs.product ? String(attrs.product) : undefined, targetCountries },
        {
          workspaceId: binding.scopeKey,
          runId: binding.accountKey,
          executionBudget: binding,
        },
      );
      return buildTedQuery(cpv, planned) as QueryPlanModelOutput['queries'];
    } catch (e) {
      if (isExecutionControlError(e)) throw e;
       
      console.warn(`[icp] icp→cpv resolve failed (计划不阻断): ${String(e).slice(0, 120)}`);
      return planned;
    }
  }

  /**
   * §2.3（openFDA）冷路径：把 ICP→FDA 解析出的器械注册发现查询前置进计划（priority 1）。
   * 贸易侧从 company_attributes.trade_side 取（默认进口商）；product code 全由确定性 crosswalk + 有界 LLM 精修解析，
   * planner LLM 绝不臆造码。fail-safe：解析失败 → 不阻断计划。
   */
  private async injectFdaQuery(
    icp: { companyAttributes: Prisma.JsonValue; targetMarkets: Prisma.JsonValue },
    planned: QueryPlanModelOutput['queries'],
    industryTerms: string[],
    binding: ExecutionBudgetBinding,
  ): Promise<QueryPlanModelOutput['queries']> {
    const attrs = (icp.companyAttributes ?? {}) as Record<string, unknown>;
    try {
      const taxonomy = new TaxonomyResolver(this.prisma, this.gateway, this.runtimeTelemetry, this.budgetStore);
      const fda = await resolveIcpToFda(
        taxonomy,
        {
          industryTerms,
          product: attrs.product ? String(attrs.product) : undefined,
          tradeSide: attrs.trade_side ? String(attrs.trade_side) : undefined,
          targetCountries: boundedTargetCountries(icp.targetMarkets), // openFDA 仅美国市场门（非美国目标 → 不注入）
        },
        {
          workspaceId: binding.scopeKey,
          runId: binding.accountKey,
          executionBudget: binding,
        },
      );
      return buildFdaQuery(fda, planned) as QueryPlanModelOutput['queries'];
    } catch (e) {
      if (isExecutionControlError(e)) throw e;
       
      console.warn(`[icp] icp→fda resolve failed (计划不阻断): ${String(e).slice(0, 120)}`);
      return planned;
    }
  }

  /** Human gate: confirm a DRAFT plan → READY (Discover may execute it). */
  async confirmQueryPlan(ctx: RequestContext, planId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const plan = await tx.discoveryQueryPlan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'query plan not found' } });
      if (plan.status !== 'DRAFT') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `plan is ${plan.status}; only DRAFT can be confirmed` },
        });
      }
      return tx.discoveryQueryPlan.update({
        where: { id: planId },
        data: { status: 'READY', version: { increment: 1 } },
      });
    });
  }

  listQueryPlans(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.discoveryQueryPlan.findMany({ where: { icpId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  private async full(tx: Prisma.TransactionClient, icpId: string) {
    const icp = await tx.icpDefinition.findUnique({
      where: { id: icpId },
      include: { personas: true, roles: true, rules: true },
    });
    if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
    return icp;
  }
}
