/**
 * M0④ 深挖流水线的单公司活动：每家公司一个子工作流，依次跑
 * profile（画像）→ fit（精判）→ signals（信号）→ contacts（联系人）。
 *
 * 与 run 级阶段活动的区别：这里**不依赖本 run 的 raw lineage**——Run 2.0 的公司来自公司池
 * （渠道/导入养出来的 canonical 公司），本来就没有本 run 的 raw 记录。每一步都按公司 id
 * 直接读写，落库路径复用既有提交函数（durable receipt / 治理 / 抑制门语义不变）。
 */
import type { ManufacturerNetworkExecutionSnapshot } from '../discovery/manufacturer-network-execution';
import { loadManufacturerEvidence } from '../discovery/manufacturer-network-store';
import { assertManufacturerNetworkAuthority } from '../discovery/manufacturer-network-authority';
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
import { loadRunProjectPage, scopeRunProjectEvidence } from '../discovery/website-profile/run-project-page';
import { readProjectPageEvidence } from '../discovery/website-profile/project-page-evidence';
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
  MAX_RUN_EMAIL_PROBES_PER_COMPANY,
  MAX_DISCOVERY_PROFILE_COMPANIES,
} from '../discovery/execution-envelope';
import { executeContactEnrichmentSafetyActivity } from './contact-enrichment-safety.activity';
import type { ContactEnrichmentSafetyService } from '../enrichment/safety/contact-enrichment-safety.service';
import {
  resolveConfiguredFinderProviders,
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
import {
  flattenSignalReceipts,
  recordCompanyJobCostCents,
  sumReceiptMicrousd,
} from '../discovery/run2/company-job-cost';
import { corroborateCompanyBeforeFit } from '../discovery/run2/corroboration-enrichment';
import { scopeIndependentEnrichment } from '../discovery/enrichment-identity';
import type { FailureStage } from '../discovery/judgment/failure-codes';
import { withClassifiedFailure } from './pipeline-failure-activity';
import {
  isActivityCancelledError,
  startActivityHeartbeat,
  withActivityHeartbeat,
} from './activity-heartbeat';
import { revisableProvisionalLeadWhere } from '../discovery/run2/pool';

export interface CompanyPipelineActivityInput {
  manufacturerNetworkExecution?: ManufacturerNetworkExecutionSnapshot;
  workspaceId: string;
  runId: string;
  icpId: string;
  companyId: string;
  executionContractVersion?: number;
  executionBudget?: unknown;
  enrichmentSlot?: number;
}

function projectPageWithinQuotedSlots(slot: number | undefined): boolean {
  return slot !== undefined && Number.isInteger(slot) && slot >= 0 && slot < MAX_DISCOVERY_PROFILE_COMPANIES;
}

const DEEP_JOB_CAP = 500;

/**
 * 单公司活动（profile/signals）的失败边界：账本/预算/回执类失败必须上抛——同一 operation
 * 重放必撞同一行，或整个 run 的账目状态未知；其余失败（单站抓取被反爬/502/超时、模型
 * 上游不可用、单条记录持久化受挫）只是**这一家**的事实缺口，软失败继续跑其余公司。
 * 2026-11-10 run 7a616c8a：crawl4ai 对个别站点反爬的抓取失败被放大成活动失败，
 * deep 阶段 11 个目标 7 个连带失败（PARTIAL failure_rate_high）。
 */
const RUN_LEVEL_FAILURE_TOKENS =
  /EXECUTION_BUDGET_|BUDGET_|BUDGETEXCEEDED|PAIDOPERATIONUNKNOWN|DOMAIN_ACK|DOMAINACK|DURABLE_EXECUTION|DURABLEEXECUTION|ARTIFACT|REPLAY|EXECUTIONCONTROLERROR|SETTLEMENT|LEASE/iu;

function isRunLevelPipelineFailure(error: unknown): boolean {
  if (!isExecutionControlError(error)) return false;
  const record = error as { name?: unknown; code?: unknown; message?: unknown; type?: unknown };
  const evidence = [record?.name, record?.code, record?.message, record?.type]
    .filter((value): value is string => typeof value === 'string')
    .join('|');
  return RUN_LEVEL_FAILURE_TOKENS.test(evidence);
}

function describeSoftFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`;
  return String(error).slice(0, 200);
}

function shouldRethrowSignalEnricherError(error: unknown): boolean {
  return (
    isActivityCancelledError(error) ||
    isExecutionControlError(error) ||
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError
  );
}

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
  /** Frozen safety lane for contact enrichment; absence keeps the original waterfall lane. */
  contactEnrichmentSafety?: Pick<ContactEnrichmentSafetyService, 'executeRun'>;
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
    const manufacturerSnapshot = assertManufacturerNetworkAuthority(args.manufacturerNetworkExecution, binding);
    if (manufacturerSnapshot) {
      const run = await deps.prisma.withWorkspace(args.workspaceId, tx=>tx.discoveryRun.findFirst({where:{id:args.runId,workspaceId:args.workspaceId,icpId:args.icpId},select:{planId:true}}));
      if (!run || run.planId !== manufacturerSnapshot.planId) throw ApplicationFailure.nonRetryable('EXECUTION_BUDGET_REQUEST_INVALID','EXECUTION_BUDGET_REQUEST_INVALID');
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
    /** 深挖目标：match 先于 weak 分配已有补证名额，同级稳定排序；上限仍为 500（Q8）。 */
    async listDeepTargets(args: { workspaceId: string; runId: string }): Promise<{ companyIds: string[] }> {
      const jobs = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.discoveryCompanyJob.findMany({
          where: {
            runId: args.runId,
            verdictQuick: { in: ['match', 'weak'] },
          },
          orderBy: [{ verdictQuick: 'asc' }, { createdAt: 'asc' }, { canonicalCompanyId: 'asc' }],
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
      return withActivityHeartbeat(
        { stage: 'profiling', runId: args.runId, companyId: args.companyId },
        async (_activityCtx, checkpoint) => {
      const binding = await ensureRunBudget(args);
      checkpoint('corroborate');
      await corroborateCompanyBeforeFit(deps, args, binding);
      checkpoint('setup');
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
        const projectUrl = company?.domain && projectPageWithinQuotedSlots(args.enrichmentSlot) && judgeContractMode() === 'enforce'
          ? await loadRunProjectPage(tx, { ...args, domain: company.domain, now: new Date() })
          : undefined;
        return { contactPaths: contactSource?.status === 'ENABLED', icp, company, projectUrl };
      });
      if (!setup?.company?.domain) return { profiled: false, matched: false, unclassified: false, reason: 'no_domain_or_provider' };
      const nowMs = Date.now();
      const storedProfile = (setup.company.attributes as { website_profile?: { project_evidence?: unknown } } | null)?.website_profile;
      const sameProject = !setup.projectUrl ||
        readProjectPageEvidence(storedProfile?.project_evidence, setup.company.domain)?.source_url === setup.projectUrl;
      if (sameProject && websiteProfileFreshAndCurrent(setup.company.attributes, setup.contactPaths, nowMs)) {
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
      checkpoint('profile_fetch');
      const durableReceipts: Array<{ producerId: string; receipt: DurableExecutionReceipt }> = [];
      let profile: WebsiteProfile | null = null;
      try {
        profile = await provider.profile(
          {
            domain: setup.company.domain,
            homeCountry,
            icpContext: icpProductContext(setup.icp?.companyAttributes),
            contactPaths: setup.contactPaths,
            ...(setup.projectUrl ? { projectUrl: setup.projectUrl } : {}),
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
        if (isActivityCancelledError(error)) throw error;
        if (artifactSubjectSkipReason(error)) {
          return { profiled: false, matched: false, unclassified: false, reason: 'suppressed' };
        }
        // 账本/预算类失败上抛；单家公司的站点抓取/模型上游失败软失败并留日志
        // （见文件头 RUN_LEVEL_FAILURE_TOKENS 注释）。
        if (isRunLevelPipelineFailure(error)) throw error;
        console.warn(
          `[profileCompanyOnce] soft-failed ${args.companyId} at profile: ${describeSoftFailure(error)}`,
        );
        profile = null;
      }

      const fetchedAt = new Date(nowMs);
      const hits: Array<{ key: string; result: EnrichmentResult }> = profile
        ? [{ key: WEBSITE_PROFILE_PROVIDER_KEY, result: websiteProfileEnrichment(profile, fetchedAt) }]
        : [];
      const profileReceipts = durableReceipts.filter(({ producerId }) => producerId !== 'crawl4ai.render');
      const contactReceipts = durableReceipts.filter(({ producerId }) => producerId === 'crawl4ai.render');

      let committed: boolean;
      try {
        committed = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
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
        await recordCompanyJobCostCents(tx as never, args, sumReceiptMicrousd(durableReceipts.map((r) => r.receipt)));
        return result.value;
        });
      } catch (error) {
        // 单家公司档案/联系人持久化受挫不连坐其余公司；账本类失败仍上抛。
        if (isRunLevelPipelineFailure(error)) throw error;
        console.warn(
          `[profileCompanyOnce] soft-failed ${args.companyId} at commit: ${describeSoftFailure(error)}`,
        );
        return { profiled: false, matched: false, unclassified: false, reason: 'persist_failed' };
      }

      if (profile === null) {
        return {
          profiled: false,
          matched: false,
          unclassified: false,
          reason: 'profile_failed',
        };
      }
      return {
        profiled: true,
        matched: committed,
        unclassified: profile.tradeRoleSource === null,
      };
        },
      );
    },

    /** 精判：单公司四门判定 → Lead（fitVerdict/fitReasons）。 */
    async fitCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      judged: boolean;
      verdict: 'match' | 'weak' | 'mismatch' | null;
      skipped?: boolean;
    }> {
      return withActivityHeartbeat(
        { stage: 'fitting', runId: args.runId, companyId: args.companyId },
        async (_activityCtx, checkpoint) => {
      const binding = await ensureRunBudget(args);
      checkpoint('load');
      // P3 J07（W8）：L0 门链与 J03b 的契约模式协同——off 保持旧行为（不评估 L0）；
      // shadow 评估但只记录（v1 产出照旧）；enforce 下 FAIL 在模型调用前拦截（NOT_FIT）。
      const mode = judgeContractMode();
      const loaded = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icpBrief = await loadIcpBrief(tx, args.icpId, args.runId);
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
        const scene = icpBrief.procurement_scenario?.id;
        const projectUrl = company?.domain && projectPageWithinQuotedSlots(args.enrichmentSlot) && mode === 'enforce' && (scene === 'factory_direct' || scene === 'equipment_integration')
          ? await loadRunProjectPage(tx, { ...args, domain: company.domain, now: new Date() })
          : undefined;
        const attributes = scopeRunProjectEvidence(company ? scopeIndependentEnrichment(company) : undefined, projectUrl);
        const manufacturerEvidence = company && args.manufacturerNetworkExecution && mode === 'enforce' && scene === 'distribution' ? await loadManufacturerEvidence(tx,args,company) : undefined;
        return { icpBrief, company: company ? { ...company, attributes, ...(manufacturerEvidence ? { manufacturerEvidence } : {}) } : null };
      });
      if (!loaded.company) return { judged: false, verdict: null, skipped: true };
      if (!(await mayUse(args.workspaceId, args.companyId))) {
        return { judged: false, verdict: null, skipped: true };
      }
      checkpoint('l0_gates');
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
        // L0 FAIL（enforce）：不调用模型、不新建 Lead；但若此前快扫曾为本公司建过暂定 weak Lead，
        // 同步降级为 REJECTED/mismatch，避免旧暂定 Lead 滞留 needs_review 并在下轮重扫死循环。
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const leadRepo = tx.lead as { updateMany?: (input: unknown) => Promise<unknown> };
          if (typeof leadRepo?.updateMany !== 'function') return;
          await leadRepo.updateMany({
            where: {
              workspaceId: args.workspaceId,
              icpId: args.icpId,
              canonicalCompanyId: args.companyId,
              ...revisableProvisionalLeadWhere(),
            },
            data: {
              fitVerdict: 'mismatch',
              fitReasons: { source: 'l0_gate', gateId: blocked.gateId, reasonCode: blocked.reasonCode },
              queue: 'rejected',
              status: 'REJECTED',
              version: { increment: 1 },
            },
          });
        });
        return { judged: false, verdict: 'mismatch', skipped: true };
      }
      checkpoint('judge');
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
      // P3 J03b：judgment_record（v2, shadow/enforce）与 Lead 投影同一事务；透传真实 discovery_run.id 供账本/precision@k 关联。
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        await persistJudgmentRecordInTransaction(tx, args.icpId, judgment, args.runId);
        await upsertLeadFit(tx, args.workspaceId, args.icpId, args.companyId, judgment);
        await recordCompanyJobCostCents(tx as never, args, sumReceiptMicrousd([judgment.durableReceipt]));
      });
      return { judged: true, verdict: judgment.verdict };
        },
      );
    },

    /** 信号：单公司数字足迹/结构化收割（7 天 TTL，SUSPENDED 域名跳过）。 */
    async signalsCompanyOnce(args: CompanyPipelineActivityInput): Promise<{
      matched: number;
      provider: string | null;
      skipped?: string;
    }> {
      const hb = startActivityHeartbeat({ stage: 'signals', runId: args.runId, companyId: args.companyId });
      try {
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
        hb.checkpoint(`enricher:${enricher.key}`);
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
          if (shouldRethrowSignalEnricherError(error)) throw error;
          if (artifactSubjectSkipReason(error)) {
            subjectDenied = true;
            break;
          }
          if (isPublicHttpTransportFailure(error)) {
            console.warn(
              `[run2-pipeline] signal ${enricher.key} read company ${args.companyId} failed (${String((error as { code?: unknown }).code ?? 'UNKNOWN')}); skipping this source`,
            );
            continue;
          }
          /* 单信号源失败不影响其余 */
        }
      }
      if (!hits.length && receipts.size === 0) {
        return { matched: 0, provider: null, ...(subjectDenied ? { skipped: 'suppressed' } : {}) };
      }
      const committed = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const result = await commitCompanySignals(tx, {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          hits: subjectDenied ? [] : hits,
          receipts,
          signalTimestamp: new Date(nowMs),
        });
        await recordCompanyJobCostCents(tx as never, args, sumReceiptMicrousd(flattenSignalReceipts(receipts)));
        return result;
      });
      return {
        matched: committed.length,
        provider: committed.length ? committed.join('+') : null,
        ...(subjectDenied ? { skipped: 'suppressed' } : {}),
      };
      } finally {
        hb.stop();
      }
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
      return withActivityHeartbeat(
        { stage: 'contacts', runId: args.runId, companyId: args.companyId },
        async (_activityCtx, checkpoint) => {
      const binding = await ensureRunBudget(args);
      checkpoint('discover_contacts');
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
        checkpoint('email_guess');
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
      );
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
      operationRef?: string;
    }> {
      return withActivityHeartbeat(
        { stage: 'enrich_contacts', runId: args.runId, companyId: args.companyId },
        async (_activityCtx, checkpoint) => {
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
      if (deps.contactEnrichmentSafety) {
        checkpoint('safety_enrich');
        // Same shared runner as HTTP: no second grant, original binding and exact remaining micro.
        const safety = await executeContactEnrichmentSafetyActivity(deps.contactEnrichmentSafety, {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          runId: args.runId,
          binding,
          lawfulBasis,
          remainingMicrousd: runStatus.remainingMicrousd,
        });
        if (safety.skipped) return { skipped: true, ...(safety.reason ? { reason: safety.reason } : {}) };
        if (typeof safety.costMicrousd === 'number' && safety.costMicrousd > 0) {
          await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            recordCompanyJobCostCents(tx as never, args, BigInt(Math.trunc(safety.costMicrousd!))),
          );
        }
        return {
          skipped: false,
          ...(safety.tier ? { tier: safety.tier } : {}),
          ...(safety.attempted === undefined ? {} : { attempted: safety.attempted }),
          ...(safety.costMicrousd === undefined ? {} : { costMicrousd: safety.costMicrousd }),
          ...(safety.operationRef ? { operationRef: safety.operationRef } : {}),
        };
      }
      return { skipped: true, reason: 'source_control_pending' };
        },
      );
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
