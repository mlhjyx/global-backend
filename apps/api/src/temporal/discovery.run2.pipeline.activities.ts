/**
 * M0④ 深挖流水线的单公司活动：每家公司一个子工作流，依次跑
 * profile（画像）→ fit（精判）→ signals（信号）→ contacts（联系人）。
 *
 * 与 run 级阶段活动的区别：这里**不依赖本 run 的 raw lineage**——Run 2.0 的公司来自公司池
 * （渠道/导入养出来的 canonical 公司），本来就没有本 run 的 raw 记录。每一步都按公司 id
 * 直接读写，落库路径复用既有提交函数（durable receipt / 治理 / 抑制门语义不变）。
 */
import { ApplicationFailure } from '@temporalio/activity';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import {
  BudgetExceededError,
  BudgetOperationReplayError,
  UnavailableBudgetStore,
  type BudgetStore,
} from '../tools/budget-store';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import { companyMayUseExternalProcessing } from '../discovery/company-suppression-gate';
import {
  commitCompanyEnrichmentResults,
} from '../discovery/company-enrichment-commit';
import {
  COMPANY_CONTACT_PARSER_MARKER,
  COMPANY_CONTACT_PARSER_VERSION,
  COMPANY_CONTACT_PROVIDER_KEY,
  companyContactObservation,
  persistCompanyContactPoints,
} from '../discovery/company-contact-points';
import {
  WEBSITE_PROFILE_PROVIDER_KEY,
  WebsiteProfileProvider,
  type WebsiteProfile,
} from '../discovery/providers/website-profile.provider';
import { targetCountryCodes } from '../discovery/search-localization';
import { artifactSubjectSkipReason } from '../tools/artifact-subject-denial';
import { isPublicHttpTransportFailure } from '../adapters/guarded-http';
import {
  applyDomainAckConsumerTransactions,
} from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import {
  judgeFitCompany,
  loadIcpBrief,
  persistJudgmentRecordInTransaction,
  upsertLeadFit,
  type FitJudgeCompany,
} from '../discovery/fit-judge';
import { judgeContractMode } from '../discovery/fit-judge-v2';
import {
  deepJudgeGateBlock,
  deepJudgeRunsL0,
  evaluateL0Gates,
} from '../discovery/judgment/gate-chain';
import type { SkillResolver } from '../skills/skill-runtime';
import { discoverContactsCore } from '../discovery/contact-discovery-core';
import { guessEmailsForRunCompany } from '../discovery/contact-stage-email-guess';
import { stampLawfulBasis } from '../discovery/compliance/email-verification-gate';
import { parseConfiguredLawfulBasis } from './backlog.activities';
import {
  ENRICH_COMPANY_BUDGET_CAP_MICROUSD,
  ENRICH_SOFT_DEADLINE_MS,
  MAX_RUN_EMAIL_PROBES_PER_COMPANY,
} from '../discovery/execution-envelope';
import { enrichCompanyContacts } from '../enrichment/waterfall/enrich-company-contacts';
import { CapBudget, CompositeBudget } from '../enrichment/waterfall/enrichment-budget';
import { PrismaCircuitBreakerStore } from '../enrichment/waterfall/circuit-breaker';
import {
  resolveConfiguredFinderProviders,
  resolveConfiguredTailFinderProviders,
} from '../enrichment/finders/finder-pool';
import type { ExecutionContext, EnrichmentResult } from '../discovery/provider-contract';
import {
  commitCompanySignals,
  icpProductContext,
  SIGNAL_TTL_MS,
  websiteProfileEnrichment,
  websiteProfileFreshAndCurrent,
} from './discovery.activities';
import { appendRunEvent } from '../discovery/run2/run-events';
import type { FailureStage } from '../discovery/judgment/failure-codes';
import { withClassifiedFailure } from './pipeline-failure-activity';

export interface CompanyPipelineActivityInput {
  workspaceId: string;
  runId: string;
  icpId: string;
  companyId: string;
  executionContractVersion?: number;
  executionBudget?: unknown;
}

const DEEP_JOB_CAP = 500;

export function createRun2PipelineActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  broker?: ExecutionBroker;
  runtimeTelemetry?: RuntimeTelemetry;
  budgetStore?: BudgetStore;
  websiteProfile?: Pick<WebsiteProfileProvider, 'profile'>;
  /** S0 技能运行时：生产由 worker 注入 DB resolver；缺省为内置目录直通。 */
  skills?: SkillResolver;
}) {
  const budgets =
    deps.budgetStore ?? new UnavailableBudgetStore('run2 pipeline activities require an authoritative BudgetStore');

  const ensureRunBudget = async (args: CompanyPipelineActivityInput): Promise<ExecutionBudgetBinding> => {
    let binding: ExecutionBudgetBinding;
    try {
      if (args.executionContractVersion !== 2) throw new Error('invalid version');
      binding = parseExecutionBudgetBinding(args.executionBudget, {
        scopeKey: args.workspaceId,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
      });
    } catch {
      throw ApplicationFailure.nonRetryable(
        'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
        'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
      );
    }
    await budgets.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
    return binding;
  };

  const mayUse = (workspaceId: string, companyId: string): Promise<boolean> =>
    deps.prisma.withWorkspace(workspaceId, (tx) =>
      companyMayUseExternalProcessing(tx, workspaceId, companyId),
    );

  const authorizeCompany = (workspaceId: string, companyId: string) => () =>
    mayUse(workspaceId, companyId);

  const activities = {
    /** 深挖目标：本 run 快扫判为 match/weak 的公司（上限 500，设计 Q8）。 */
    async listDeepTargets(args: { workspaceId: string; runId: string }): Promise<{ companyIds: string[] }> {
      const jobs = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.discoveryCompanyJob.findMany({
          where: {
            runId: args.runId,
            verdictQuick: { in: ['match', 'weak'] },
          },
          orderBy: { createdAt: 'asc' },
          take: DEEP_JOB_CAP,
          select: { canonicalCompanyId: true },
        }),
      );
      return { companyIds: [...new Set(jobs.map((job) => job.canonicalCompanyId))] };
    },

    /** 深挖完成度汇总（finalize 用）：done / failed / skipped / 仍在途。 */
    async deepStageSummary(args: {
      workspaceId: string;
      runId: string;
    }): Promise<{ done: number; failed: number; skipped: number; remaining: number }> {
      const rows = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.discoveryCompanyJob.groupBy({
          by: ['stage'],
          where: { runId: args.runId, verdictQuick: { in: ['match', 'weak'] } },
          _count: { _all: true },
        }),
      );
      const count = (stage: string): number =>
        rows.find((row) => row.stage === stage)?._count._all ?? 0;
      return {
        done: count('done'),
        failed: count('failed'),
        skipped: count('skipped'),
        remaining: count('profiling') + count('fitting') + count('signals') + count('contacts') + count('quick_judged'),
      };
    },

    /** 停止深挖（工作流被取消）时把未完成的公司标成 skipped（可续：下次 run 会重新排队）。 */
    async skipUnfinishedDeepJobs(args: {
      workspaceId: string;
      runId: string;
      errorCode: string;
    }): Promise<{ skipped: number }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const jobs = await tx.discoveryCompanyJob.findMany({
          where: {
            runId: args.runId,
            stage: { in: ['quick_judged', 'profiling', 'fitting', 'signals', 'contacts'] },
          },
          select: { id: true, canonicalCompanyId: true },
        });
        for (const job of jobs) {
          await tx.discoveryCompanyJob.update({
            where: { id: job.id },
            data: { stage: 'skipped', lastErrorCode: args.errorCode, finishedAt: new Date() },
          });
          await appendRunEvent(tx as never, {
            workspaceId: args.workspaceId,
            runId: args.runId,
            level: 'warn',
            type: 'company_failed',
            payload: { companyId: job.canonicalCompanyId, stage: 'skipped', error: args.errorCode },
          });
        }
        return { skipped: jobs.length };
      });
    },

    /** 单公司流水线的阶段写回（job.stage + RunEvent，同一事务）。 */
    async updateCompanyJobStage(args: {
      workspaceId: string;
      runId: string;
      companyId: string;
      stage: 'profiling' | 'fitting' | 'signals' | 'contacts' | 'done' | 'failed' | 'skipped';
      verdictDeep?: 'match' | 'weak' | 'mismatch';
      errorCode?: string;
      /** P3 J02 W1：失败分类 stage（闭集），只进 run_event payload，不落 DB 列。 */
      failureStage?: FailureStage;
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const job = await tx.discoveryCompanyJob.findUnique({
          where: {
            workspaceId_runId_canonicalCompanyId: {
              workspaceId: args.workspaceId,
              runId: args.runId,
              canonicalCompanyId: args.companyId,
            },
          },
          select: { id: true, startedAt: true },
        });
        if (!job) return;
        const finished = args.stage === 'done' || args.stage === 'failed' || args.stage === 'skipped';
        await tx.discoveryCompanyJob.update({
          where: { id: job.id },
          data: {
            stage: args.stage,
            ...(args.verdictDeep ? { verdictDeep: args.verdictDeep } : {}),
            ...(args.errorCode ? { lastErrorCode: args.errorCode } : {}),
            ...(job.startedAt ? {} : { startedAt: new Date() }),
            ...(finished ? { finishedAt: new Date() } : {}),
          },
        });
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          ...(args.stage === 'failed' ? { level: 'warn' as const } : {}),
          type:
            args.stage === 'failed'
              ? 'company_failed'
              : args.stage === 'done' || args.stage === 'skipped'
                ? 'company_done'
                : 'company_entered_stage',
          payload: {
            companyId: args.companyId,
            stage: args.stage,
            ...(args.verdictDeep ? { verdict: args.verdictDeep } : {}),
            ...(args.errorCode ? { error: args.errorCode } : {}),
            ...(args.failureStage ? { failureStage: args.failureStage } : {}),
          },
        });
      });
    },

    /** 画像：官网首页 + Impressum → website_profile 命名空间（30 天 TTL，联系路径按开关）。 */
    async profileCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      profiled: boolean;
      matched: boolean;
      unclassified: boolean;
      reason?: string;
    }> {
      const binding = await ensureRunBudget(args);
      const setup = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const source = await tx.dataProvider.findUnique({
          where: { key: WEBSITE_PROFILE_PROVIDER_KEY },
          select: { status: true },
        });
        if (source?.status !== 'ENABLED') return null;
        const contactSource = await tx.dataProvider.findUnique({
          where: { key: COMPANY_CONTACT_PROVIDER_KEY },
          select: { status: true },
        });
        const icp = await tx.icpDefinition.findUnique({
          where: { id: args.icpId },
          select: { companyAttributes: true, targetMarkets: true },
        });
        const company = await tx.canonicalCompany.findUnique({
          where: { id: args.companyId },
          select: { id: true, name: true, domain: true, country: true, attributes: true },
        });
        return { contactPaths: contactSource?.status === 'ENABLED', icp, company };
      });
      if (!setup?.company?.domain) return { profiled: false, matched: false, unclassified: false, reason: 'no_domain_or_provider' };
      const nowMs = Date.now();
      if (websiteProfileFreshAndCurrent(setup.company.attributes, setup.contactPaths, nowMs)) {
        return { profiled: false, matched: false, unclassified: false, reason: 'fresh' };
      }
      if (!(await mayUse(args.workspaceId, args.companyId))) {
        return { profiled: false, matched: false, unclassified: false, reason: 'suppressed' };
      }
      const provider =
        deps.websiteProfile ??
        (deps.broker
          ? new WebsiteProfileProvider({
              gateway: deps.gateway,
              broker: deps.broker,
              runtimeTelemetry: deps.runtimeTelemetry,
            })
          : null);
      if (!provider) return { profiled: false, matched: false, unclassified: false, reason: 'no_provider' };

      const icpHomeCountry = targetCountryCodes({ filters: { country: setup.icp?.targetMarkets } })[0] ?? '';
      const homeCountry =
        targetCountryCodes({ filters: { country: setup.company.country } })[0] ?? icpHomeCountry;
      const durableReceipts: Array<{ producerId: string; receipt: DurableExecutionReceipt }> = [];
      let profile: WebsiteProfile | null = null;
      try {
        profile = await provider.profile(
          {
            domain: setup.company.domain,
            homeCountry,
            icpContext: icpProductContext(setup.icp?.companyAttributes),
            contactPaths: setup.contactPaths,
          },
          {
            workspaceId: args.workspaceId,
            runId: binding.accountKey,
            correlationId: binding.accountKey,
            authorizeExternalAction: authorizeCompany(args.workspaceId, args.companyId),
            onDurableReceipt: (producerId, receipt) => durableReceipts.push({ producerId, receipt }),
            artifactSubject: { subjectType: 'company', subjectId: args.companyId },
          },
        );
      } catch (error) {
        if (artifactSubjectSkipReason(error)) {
          return { profiled: false, matched: false, unclassified: false, reason: 'suppressed' };
        }
        if (isExecutionControlError(error)) throw error;
        profile = null;
      }

      const fetchedAt = new Date(nowMs);
      const hits: Array<{ key: string; result: EnrichmentResult }> = profile
        ? [{ key: WEBSITE_PROFILE_PROVIDER_KEY, result: websiteProfileEnrichment(profile, fetchedAt) }]
        : [];
      const profileReceipts = durableReceipts.filter(({ producerId }) => producerId !== 'crawl4ai.render');
      const contactReceipts = durableReceipts.filter(({ producerId }) => producerId === 'crawl4ai.render');

      const committed = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const result = await applyDomainAckConsumerTransactions({
          transaction: tx,
          acknowledgements: profileReceipts.map(({ producerId, receipt }) => ({
            producerId,
            receipt,
            domainAckKey: `${args.companyId}:${receipt.operationId}:website-profile`,
            domainRevision: receipt.resultDigest,
          })),
          apply: (transaction) =>
            hits.length
              ? commitCompanyEnrichmentResults(transaction, {
                  workspaceId: args.workspaceId,
                  companyId: args.companyId,
                  hits,
                  signalTimestamp: fetchedAt,
                  ...(setup.contactPaths
                    ? { namespaceMarkers: { [COMPANY_CONTACT_PARSER_MARKER]: COMPANY_CONTACT_PARSER_VERSION } }
                    : {}),
                })
              : Promise.resolve(false),
          readback: async (transaction) => {
            const current = await transaction.canonicalCompany.findUnique({
              where: { id: args.companyId },
              select: { attributes: true },
            });
            const namespace = ((current?.attributes ?? {}) as Record<string, unknown>)[
              WEBSITE_PROFILE_PROVIDER_KEY
            ] as { _ts?: unknown } | undefined;
            return hits.length > 0 && typeof namespace?._ts === 'string';
          },
        });
        if (setup.contactPaths && (contactReceipts.length > 0 || profile?.contactPaths)) {
          await applyDomainAckConsumerTransactions({
            transaction: tx,
            acknowledgements: contactReceipts.map(({ producerId, receipt }) => ({
              producerId,
              receipt,
              domainAckKey: `${args.companyId}:${receipt.operationId}:company-contact`,
              domainRevision: receipt.resultDigest,
            })),
            apply: (transaction) =>
              profile?.contactPaths
                ? persistCompanyContactPoints(transaction, {
                    workspaceId: args.workspaceId,
                    companyId: args.companyId,
                    observation: companyContactObservation(profile.contactPaths),
                    seenAt: new Date(),
                  })
                : Promise.resolve(null),
            readback: async () => null,
          });
        }
        return result.value;
      });

      return {
        profiled: true,
        matched: committed,
        unclassified: profile !== null && profile.tradeRoleSource === null,
      };
    },

    /** 精判：单公司四门判定 → Lead（fitVerdict/fitReasons）。 */
    async fitCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      judged: boolean;
      verdict: 'match' | 'weak' | 'mismatch' | null;
      skipped?: boolean;
    }> {
      const binding = await ensureRunBudget(args);
      // P3 J07（W8）：L0 门链与 J03b 的契约模式协同——off 保持旧行为（不评估 L0）；
      // shadow 评估但只记录（v1 产出照旧）；enforce 下 FAIL 在模型调用前拦截（NOT_FIT）。
      const mode = judgeContractMode();
      const loaded = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icpBrief = await loadIcpBrief(tx, args.icpId);
        const company = await tx.canonicalCompany.findUnique({
          where: { id: args.companyId },
          select: {
            id: true,
            name: true,
            domain: true,
            country: true,
            industry: true,
            attributes: true,
          },
        });
        return { icpBrief, company };
      });
      if (!loaded.company) return { judged: false, verdict: null, skipped: true };
      if (!(await mayUse(args.workspaceId, args.companyId))) {
        return { judged: false, verdict: null, skipped: true };
      }
      const gate = deepJudgeRunsL0(mode)
        ? await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            evaluateL0Gates(tx, {
              workspaceId: args.workspaceId,
              icpId: args.icpId,
              companyId: args.companyId,
              now: new Date(),
            }),
          )
        : null;
      const blocked = gate ? deepJudgeGateBlock(mode, gate) : null;
      if (blocked) {
        // L0 FAIL（enforce）：不调用模型、不写 Lead。job 以 NOT_FIT 收尾（工作流见
        // mismatch 即结束本条流水线）；门结果（hard_gate_result）已由 evaluateGates 落库。
        return { judged: false, verdict: 'mismatch', skipped: true };
      }
      const judgment = await judgeFitCompany(
        deps.gateway,
        args.workspaceId,
        loaded.icpBrief,
        loaded.company as FitJudgeCompany,
        {
          runId: binding.accountKey,
          runtimeTelemetry: deps.runtimeTelemetry,
          authorizeExternalAction: authorizeCompany(args.workspaceId, args.companyId),
          skills: deps.skills,
          judgeContractMode: mode,
        },
      );
      if (!judgment) return { judged: false, verdict: null };
      // P3 J07：yellow/red 不拦截，只把 stale 标记注入判定结果（随 fitReasons 落 Lead）。
      if (gate?.sanctions.staleMarker) {
        judgment.sanctionsStale = gate.sanctions.staleMarker;
      }
      // P3 J03b：judgment_record（v2, shadow/enforce）与 Lead 投影同一事务。
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        await persistJudgmentRecordInTransaction(tx, args.icpId, judgment);
        await upsertLeadFit(tx, args.workspaceId, args.icpId, args.companyId, judgment);
      });
      return { judged: true, verdict: judgment.verdict };
    },

    /** 信号：单公司数字足迹/结构化收割（7 天 TTL，SUSPENDED 域名跳过）。 */
    async signalsCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      matched: number;
      provider: string | null;
      skipped?: string;
    }> {
      const binding = await ensureRunBudget(args);
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeSignalEnrichment(tx as never),
      );
      if (!enrichers.length) return { matched: 0, provider: null, skipped: 'no_provider' };
      const suspended = new Set(
        (
          await deps.prisma.sourcePolicy.findMany({
            where: { reviewStatus: 'SUSPENDED' },
            select: { domain: true },
          })
        ).map((row) => row.domain.toLowerCase()),
      );
      const company = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findUnique({
          where: { id: args.companyId },
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        }),
      );
      if (!company) return { matched: 0, provider: null, skipped: 'not_found' };
      if (company.domain && suspended.has(company.domain.toLowerCase())) {
        return { matched: 0, provider: null, skipped: 'suspended' };
      }
      const nowMs = Date.now();
      const existing = ((company.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const receipts: Map<string, Map<string, { producerId: string; receipt: DurableExecutionReceipt }>> = new Map();
      const capture = (
        enricherKey: string,
        producerId: string,
        receipt: DurableExecutionReceipt,
      ): void => {
        const owned = receipts.get(enricherKey) ?? new Map();
        if (!owned.has(receipt.operationId)) owned.set(receipt.operationId, { producerId, receipt });
        receipts.set(enricherKey, owned);
      };
      const ctx: ExecutionContext = {
        workspaceId: args.workspaceId,
        runId: binding.accountKey,
        correlationId: binding.accountKey,
        authorizeExternalAction: authorizeCompany(args.workspaceId, args.companyId),
        artifactSubject: { subjectType: 'company', subjectId: args.companyId },
      };
      const hits: Array<{ key: string; result: EnrichmentResult }> = [];
      let subjectDenied = false;
      for (const enricher of enrichers) {
        const prev = existing[enricher.key] as { _ts?: string } | undefined;
        if (prev?._ts && nowMs - Date.parse(prev._ts) < SIGNAL_TTL_MS) continue;
        if (!(await mayUse(args.workspaceId, args.companyId))) {
          subjectDenied = true;
          break;
        }
        try {
          const result = await enricher.enrichCompany(
            {
              name: company.name,
              domain: company.domain ?? undefined,
              country: company.country ?? undefined,
              region: company.region ?? undefined,
            },
            {
              ...ctx,
              onDurableReceipt: (producerId, receipt) => capture(enricher.key, producerId, receipt),
            },
          );
          if (result.matched) hits.push({ key: enricher.key, result });
        } catch (error) {
          if (artifactSubjectSkipReason(error)) {
            subjectDenied = true;
            break;
          }
          if (isExecutionControlError(error)) throw error;
          if (isPublicHttpTransportFailure(error)) {
            console.warn(
              `[run2-pipeline] signal ${enricher.key} read company ${args.companyId} failed (${String((error as { code?: unknown }).code ?? 'UNKNOWN')}); skipping this source`,
            );
            continue;
          }
          if (
            error instanceof BudgetExceededError ||
            error instanceof BudgetOperationReplayError
          ) {
            throw error;
          }
          /* 单信号源失败不影响其余 */
        }
      }
      if (!hits.length && receipts.size === 0) {
        return { matched: 0, provider: null, ...(subjectDenied ? { skipped: 'suppressed' } : {}) };
      }
      const committed = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        commitCompanySignals(tx, {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          hits: subjectDenied ? [] : hits,
          receipts,
          signalTimestamp: new Date(nowMs),
        }),
      );
      return {
        matched: committed.length,
        provider: committed.length ? committed.join('+') : null,
        ...(subjectDenied ? { skipped: 'suppressed' } : {}),
      };
    },

    /** 联系人：单公司决策人发现 + 可选邮箱补全（M3 双闸语义不变）。 */
    async contactsCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      skipped: boolean;
      reason?: string;
      people: number;
      emails: number;
      phones: number;
      emailGuess?: Record<string, number> | null;
    }> {
      const binding = await ensureRunBudget(args);
      const providerRow = await deps.prisma.dataProvider.findUnique({
        where: { key: 'decision_maker' },
        select: { config: true },
      });
      const configured = parseConfiguredLawfulBasis(providerRow?.config);
      if (!configured) {
        return { skipped: true, reason: 'no_lawful_basis_configured', people: 0, emails: 0, phones: 0 };
      }
      const lawfulBasis = stampLawfulBasis(
        configured,
        `discovery-run:${args.runId}`,
        new Date().toISOString(),
      );
      const result = await discoverContactsCore(
        { prisma: deps.prisma, providers: deps.providers, budgetStore: budgets },
        {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          lawfulBasis,
          binding: {
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
          },
          audit: {
            actorId: `discovery-run:${args.runId}`,
            actorKind: 'system',
            purpose: 'run_contact_materialization',
            correlationId: args.runId,
          },
        },
      );
      let emails = 0;
      let phones = 0;
      for (const contact of result.contacts) {
        for (const point of contact.contactPoints) {
          if (point.type === 'email') emails += 1;
          if (point.type === 'phone') phones += 1;
        }
      }

      let emailGuess: Record<string, number> | null = null;
      const company = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findUnique({ where: { id: args.companyId }, select: { domain: true } }),
      );
      const emailGuessRow = await deps.prisma.dataProvider.findUnique({
        where: { key: 'email_guess' },
        select: { status: true },
      });
      if (emailGuessRow?.status === 'ENABLED' && company?.domain) {
        const verifiers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          deps.providers.routeEmailVerification(tx as never),
        );
        const verifier = verifiers.find((entry) => entry.key === 'smtp_self');
        if (verifier) {
          const guess = await guessEmailsForRunCompany(
            { prisma: deps.prisma },
            {
              workspaceId: args.workspaceId,
              runId: args.runId,
              accountKey: binding.accountKey,
              companyId: args.companyId,
              domain: company.domain,
              contacts: result.contacts.map((contact) => ({
                id: contact.id,
                fullName: contact.fullName,
                contactPoints: contact.contactPoints.map((point) => ({
                  type: point.type,
                  value: point.value,
                  status: point.status,
                })),
              })),
              lawfulBasis,
              maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
              verifier,
            },
          );
          emailGuess = { ...guess };
          emails += guess.persisted;
        }
      }

      return {
        skipped: false,
        people: result.contacts.length,
        emails,
        phones,
        ...(emailGuess ? { emailGuess } : {}),
      };
    },

    /**
     * P1-10b：公司级邮箱富集（付费 finder 瀑布，计划 §2.3.4.7）。由子工作流在 contacts 阶段后
     * 仅对 fit=match 公司触发；本活动再做数据面守卫：
     *  - 无已配置凭据或 data_provider 全 DISABLED → 直接跳过（不触碰联系人、不写 attempt 账，
     *    避免 kill switch 期间给每个联系人刷 skipped_compliance 行）；
     *  - 无 lawful basis 配置（decision_maker.config，与联系人发现同一配置面）→ 跳过；
     *  - 预算 = min(run 预算剩余, $0.50/公司)，形状上限见 execution-envelope.ts。
     */
    async enrichContactsForCompany(args: CompanyPipelineActivityInput): Promise<{
      skipped: boolean;
      reason?: string;
      tier?: 'A' | 'B';
      attempted?: number;
      costMicrousd?: number;
    }> {
      const finders = resolveConfiguredFinderProviders();
      if (finders.length === 0) return { skipped: true, reason: 'no_configured_finder' };
      const enabled = await deps.prisma.dataProvider.findMany({
        where: { key: { in: finders.map((finder) => finder.key) }, status: 'ENABLED' },
        select: { key: true },
      });
      if (enabled.length === 0) return { skipped: true, reason: 'no_enabled_finder' };
      const providerRow = await deps.prisma.dataProvider.findUnique({
        where: { key: 'decision_maker' },
        select: { config: true },
      });
      const configured = parseConfiguredLawfulBasis(providerRow?.config);
      if (!configured) return { skipped: true, reason: 'no_lawful_basis_configured' };
      const lawfulBasis = stampLawfulBasis(
        configured,
        `discovery-run:${args.runId}`,
        new Date().toISOString(),
      );
      const binding = await ensureRunBudget(args);
      const runStatus = await budgets.status({
        workspaceId: binding.scopeKey,
        accountKey: binding.accountKey,
      });
      const budget = new CompositeBudget([
        new CapBudget(ENRICH_COMPANY_BUDGET_CAP_MICROUSD),
        new CapBudget(Number(runStatus.remainingMicrousd)),
      ]);
      const result = await enrichCompanyContacts(
        {
          prisma: deps.prisma,
          ownerPrisma: deps.prisma,
          finders,
          tailFinders: resolveConfiguredTailFinderProviders(),
          circuits: new PrismaCircuitBreakerStore(deps.prisma),
          budget,
          actorId: `discovery-run:${args.runId}`,
          // SMTP 兜底票（验证瀑布第二票）的出网闸门；worker 未装配 broker 时兜底票不参与。
          ...(deps.broker ? { verificationBroker: deps.broker } : {}),
        },
        {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          runId: args.runId,
          accountKey: binding.accountKey,
          lawfulBasis,
          deadlineAtMs: Date.now() + ENRICH_SOFT_DEADLINE_MS,
        },
      );
      return {
        skipped: false,
        tier: result.tier,
        attempted: result.attempted,
        costMicrousd: result.costMicrousd,
        ...(result.skipped ? { reason: result.skipped } : {}),
      };
    },
  };

  // P3 J02 W2：四个阶段活动在边界把异常换成带稳定 failure code 的 ApplicationFailure
  //（type 穿过 DiagnosticFailureConverter 的脱敏），workflow 据此写具体 last_error_code。
  return {
    ...activities,
    profileCompanyOnce: withClassifiedFailure(activities.profileCompanyOnce),
    fitCompanyOnce: withClassifiedFailure(activities.fitCompanyOnce),
    signalsCompanyOnce: withClassifiedFailure(activities.signalsCompanyOnce),
    contactsCompanyOnce: withClassifiedFailure(activities.contactsCompanyOnce),
    enrichContactsForCompany: withClassifiedFailure(activities.enrichContactsForCompany),
  };
}

export type Run2PipelineActivities = ReturnType<typeof createRun2PipelineActivities>;
