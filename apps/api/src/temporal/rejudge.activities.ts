import type { Prisma } from '@prisma/client';
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
import { SkillUnavailableError, type SkillResolver } from '../skills/skill-runtime';
import { companyMayUseExternalProcessing } from '../discovery/company-suppression-gate';
import { commitCompanyEnrichmentResults } from '../discovery/company-enrichment-commit';
import {
  COMPANY_CONTACT_PARSER_MARKER,
  COMPANY_CONTACT_PARSER_VERSION,
  COMPANY_CONTACT_PROVIDER_KEY,
  companyContactObservation,
  persistCompanyContactPoints,
} from '../discovery/company-contact-points';
import {
  WEBSITE_PROFILE_PARSER_MARKER,
  WEBSITE_PROFILE_PARSER_VERSION,
  WEBSITE_PROFILE_PROVIDER_KEY,
  WebsiteProfileProvider,
  type WebsiteProfile,
} from '../discovery/providers/website-profile.provider';
import { targetCountryCodes } from '../discovery/search-localization';
import { artifactSubjectSkipReason } from '../tools/artifact-subject-denial';
import { applyDomainAckConsumerTransactions } from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import {
  judgeFitCompany,
  loadIcpBrief,
  persistJudgmentRecordInTransaction,
  upsertLeadFit,
  type FitJudgeCompany,
} from '../discovery/fit-judge';
import { judgeContractMode } from '../discovery/fit-judge-v2';
import { deepJudgeGateBlock, evaluateL0Gates } from '../discovery/judgment/gate-chain';
import { needsWebsiteProfileV2Refresh } from '../discovery/judgment/rejudge-candidates';
import {
  corroborateCompanyForRejudge,
  persistWebsiteProfileMarkerInTransaction,
} from '../discovery/run2/corroboration-enrichment';
import { scopeIndependentEnrichment } from '../discovery/enrichment-identity';
import { icpProductContext, websiteProfileEnrichment } from './discovery.activities';
import { isActivityCancelledError } from './activity-heartbeat';

export interface RejudgeCompanyActivityInput {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly rejudgeId: string;
  readonly companyId: string;
  readonly executionContractVersion: number;
  readonly budgetBinding: unknown;
  readonly refreshWebsiteProfile: boolean;
  readonly refreshCorroboration: boolean;
}

export interface RejudgeCompanyOutcome {
  readonly processed: boolean;
  readonly judged: boolean;
  readonly leadUpdated: boolean;
  readonly verdict: 'match' | 'weak' | 'mismatch' | null;
  readonly refreshedProfile: boolean;
  readonly viesMatched: boolean;
  readonly failedSoft: boolean;
  readonly fatalBudgetError: boolean;
}

export interface RejudgeQualifyInput {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly rejudgeId: string;
}

export interface RejudgeActivitiesDependencies {
  readonly prisma: PrismaService;
  readonly providers: DiscoveryProviderRegistry;
  readonly gateway: ModelGateway;
  readonly broker?: ExecutionBroker;
  readonly runtimeTelemetry?: RuntimeTelemetry;
  readonly budgetStore?: BudgetStore;
  readonly websiteProfile?: Pick<WebsiteProfileProvider, 'profile'>;
  readonly skills?: SkillResolver;
}

const HUMAN_DECIDED_LEAD_STATUSES = ['QUALIFIED', 'CONTACTED', 'CONVERTED'] as const;

function isFatalRejudgeBudgetError(error: unknown): boolean {
  return (
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError ||
    error instanceof SkillUnavailableError ||
    isExecutionControlError(error)
  );
}

function emptyOutcome(overrides: Partial<RejudgeCompanyOutcome> = {}): RejudgeCompanyOutcome {
  return {
    processed: false,
    judged: false,
    leadUpdated: false,
    verdict: null,
    refreshedProfile: false,
    viesMatched: false,
    failedSoft: false,
    fatalBudgetError: false,
    ...overrides,
  };
}

async function refreshWebsiteProfileStep(
  deps: RejudgeActivitiesDependencies,
  input: RejudgeCompanyActivityInput,
  binding: ExecutionBudgetBinding,
  authorizeCompany: () => Promise<boolean>,
): Promise<boolean> {
  const setup = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
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
      where: { id: input.icpId },
      select: { companyAttributes: true, targetMarkets: true },
    });
    const company = await tx.canonicalCompany.findUnique({
      where: { id: input.companyId },
      select: { id: true, name: true, domain: true, country: true, attributes: true },
    });
    return { contactPaths: contactSource?.status === 'ENABLED', icp, company };
  });

  if (!setup?.company?.domain || !needsWebsiteProfileV2Refresh(setup.company)) {
    return false;
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
  if (!provider) return false;

  const icpHomeCountry = targetCountryCodes({ filters: { country: setup.icp?.targetMarkets } })[0] ?? '';
  const homeCountry = targetCountryCodes({ filters: { country: setup.company.country } })[0] ?? icpHomeCountry;
  const durableReceipts: Array<{ producerId: string; receipt: DurableExecutionReceipt }> = [];

  let profile: WebsiteProfile | null = null;
  let profileFetchFailed = false;
  try {
    profile = await provider.profile(
      {
        domain: setup.company.domain,
        homeCountry,
        icpContext: icpProductContext(setup.icp?.companyAttributes),
        contactPaths: setup.contactPaths,
      },
      {
        workspaceId: input.workspaceId,
        runId: binding.accountKey,
        correlationId: `rejudge:${input.rejudgeId}:${input.companyId}`,
        authorizeExternalAction: authorizeCompany,
        onDurableReceipt: (producerId, receipt) => durableReceipts.push({ producerId, receipt }),
        artifactSubject: { subjectType: 'company', subjectId: input.companyId },
      },
    );
  } catch (error) {
    if (isActivityCancelledError(error) || isFatalRejudgeBudgetError(error)) throw error;
    profileFetchFailed = true;
    profile = null;
    if (!artifactSubjectSkipReason(error)) {
      console.warn(
        `[rejudgeCompanyOnce] soft-failed ${input.companyId} at website_profile: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const fetchedAt = new Date();
  const hits = profile
    ? [{ key: WEBSITE_PROFILE_PROVIDER_KEY, result: websiteProfileEnrichment(profile, fetchedAt) }]
    : [];
  const profileReceipts = durableReceipts.filter(({ producerId }) => producerId !== 'crawl4ai.render');
  const contactReceipts = durableReceipts.filter(({ producerId }) => producerId === 'crawl4ai.render');
  const shouldStampNullV2Marker = !profile && !profileFetchFailed;

  if (
    hits.length === 0 &&
    !shouldStampNullV2Marker &&
    profileReceipts.length === 0 &&
    contactReceipts.length === 0
  ) {
    return false;
  }

  return deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
    const committed = await applyDomainAckConsumerTransactions({
      transaction: tx,
      acknowledgements: profileReceipts.map(({ producerId, receipt }) => ({
        producerId,
        receipt,
        domainAckKey: `${input.companyId}:${receipt.operationId}:website-profile`,
        domainRevision: receipt.resultDigest,
      })),
      apply: async (transaction) => {
        if (hits.length > 0) {
          return commitCompanyEnrichmentResults(transaction, {
            workspaceId: input.workspaceId,
            companyId: input.companyId,
            hits,
            signalTimestamp: fetchedAt,
            namespaceMarkers: {
              [WEBSITE_PROFILE_PARSER_MARKER]: WEBSITE_PROFILE_PARSER_VERSION,
              ...(setup.contactPaths
                ? { [COMPANY_CONTACT_PARSER_MARKER]: COMPANY_CONTACT_PARSER_VERSION }
                : {}),
            },
          });
        }
        if (shouldStampNullV2Marker) {
          await persistWebsiteProfileMarkerInTransaction(
            transaction,
            input.workspaceId,
            input.companyId,
            WEBSITE_PROFILE_PARSER_MARKER,
            WEBSITE_PROFILE_PARSER_VERSION,
          );
        }
        return false;
      },
      readback: async (transaction) => {
        if (hits.length === 0) return false;
        const current = await transaction.canonicalCompany.findUnique({
          where: { id: input.companyId },
          select: { attributes: true },
        });
        const namespace = ((current?.attributes ?? {}) as Record<string, unknown>)[
          WEBSITE_PROFILE_PROVIDER_KEY
        ] as { _ts?: unknown } | undefined;
        return typeof namespace?._ts === 'string';
      },
    });
    if (contactReceipts.length > 0 || (setup.contactPaths && profile?.contactPaths)) {
      await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: contactReceipts.map(({ producerId, receipt }) => ({
          producerId,
          receipt,
          domainAckKey: `${input.companyId}:${receipt.operationId}:company-contact`,
          domainRevision: receipt.resultDigest,
        })),
        apply: (transaction) =>
          profile?.contactPaths
            ? persistCompanyContactPoints(transaction, {
                workspaceId: input.workspaceId,
                companyId: input.companyId,
                observation: companyContactObservation(profile.contactPaths),
                seenAt: new Date(),
              })
            : Promise.resolve(null),
        readback: async () => null,
      });
    }
    return committed.value;
  });
}

async function applyL0BlockPreservingHumanDecisions(
  prisma: PrismaService,
  input: RejudgeCompanyActivityInput,
  blocked: { gateId: string; reasonCode: string | null },
): Promise<boolean> {
  return prisma.withWorkspace(input.workspaceId, async (tx) => {
    const leadRepo = tx.lead as
      | { updateMany?: (args: unknown) => Promise<{ count?: number } | undefined> }
      | undefined;
    if (typeof leadRepo?.updateMany !== 'function') return false;
    const result = await leadRepo.updateMany({
      where: {
        workspaceId: input.workspaceId,
        icpId: input.icpId,
        canonicalCompanyId: input.companyId,
        status: { notIn: [...HUMAN_DECIDED_LEAD_STATUSES] },
      },
      data: {
        fitVerdict: 'mismatch',
        fitReasons: {
          source: 'l0_gate',
          gateId: blocked.gateId,
          reasonCode: blocked.reasonCode,
        } as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    return typeof result?.count === 'number' && result.count > 0;
  });
}

export function createRejudgeActivities(deps: RejudgeActivitiesDependencies) {
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore('rejudge activities require an authoritative BudgetStore');

  const mayUse = (workspaceId: string, companyId: string): Promise<boolean> =>
    deps.prisma.withWorkspace(workspaceId, (tx) =>
      companyMayUseExternalProcessing(tx, workspaceId, companyId),
    );

  const attestBinding = async (
    input: RejudgeCompanyActivityInput,
  ): Promise<ExecutionBudgetBinding | null> => {
    let binding: ExecutionBudgetBinding;
    try {
      if (input.executionContractVersion !== 2) return null;
      binding = parseExecutionBudgetBinding(input.budgetBinding, {
        scopeKey: input.workspaceId,
        purpose: 'icp.rejudge',
        subjectType: 'icp',
      });
      if (binding.subjectId !== input.icpId) return null;
      await budgets.attestAuthorized({
        authorityId: binding.authorityId,
        scopeKey: binding.scopeKey,
        accountKey: binding.accountKey,
      });
      return binding;
    } catch {
      return null;
    }
  };

  return {
    async rejudgeCompanyOnce(input: RejudgeCompanyActivityInput): Promise<RejudgeCompanyOutcome> {
      const binding = await attestBinding(input);
      if (!binding) return emptyOutcome({ fatalBudgetError: true });

      if (judgeContractMode() !== 'enforce') {
        return emptyOutcome({ processed: true, failedSoft: true });
      }
      if (!(await mayUse(input.workspaceId, input.companyId))) {
        return emptyOutcome();
      }

      const authorizeCompany = () => mayUse(input.workspaceId, input.companyId);
      let refreshedProfile = false;
      let viesMatched = false;

      try {
        if (input.refreshWebsiteProfile) {
          refreshedProfile = await refreshWebsiteProfileStep(deps, input, binding, authorizeCompany);
        }
        if (input.refreshCorroboration) {
          const corroboration = await corroborateCompanyForRejudge(
            { prisma: deps.prisma, providers: deps.providers },
            {
              workspaceId: input.workspaceId,
              icpId: input.icpId,
              companyId: input.companyId,
              rejudgeId: input.rejudgeId,
              correlationId: `rejudge:${input.rejudgeId}:${input.companyId}`,
            },
            binding,
          );
          viesMatched = corroboration.viesMatched;
        }

        const loaded = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
          const icpBrief = await loadIcpBrief(tx, input.icpId);
          const company = await tx.canonicalCompany.findUnique({
            where: { id: input.companyId },
            select: {
              id: true,
              name: true,
              domain: true,
              country: true,
              industry: true,
              attributes: true,
            },
          });
          if (!company) return { icpBrief, company: null };
          return {
            icpBrief,
            company: {
              ...company,
              attributes: scopeIndependentEnrichment(company),
            } satisfies FitJudgeCompany,
          };
        });
        if (!loaded.company || !(await mayUse(input.workspaceId, input.companyId))) {
          return emptyOutcome({ refreshedProfile, viesMatched });
        }

        const gate = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
          evaluateL0Gates(tx, {
            workspaceId: input.workspaceId,
            icpId: input.icpId,
            companyId: input.companyId,
            now: new Date(),
          }),
        );
        const blocked = deepJudgeGateBlock('enforce', gate);
        if (blocked) {
          const leadUpdated = await applyL0BlockPreservingHumanDecisions(deps.prisma, input, blocked);
          return emptyOutcome({
            processed: true,
            leadUpdated,
            verdict: 'mismatch',
            refreshedProfile,
            viesMatched,
          });
        }

        // Three-way runId isolation (#57 Critical #3):
        // 1) Pass binding.accountKey to judgeFitCompany for RouterModelGateway ledger & PANEL_SEEN isolation.
        const judgment = await judgeFitCompany(
          deps.gateway,
          input.workspaceId,
          loaded.icpBrief,
          loaded.company,
          {
            runId: binding.accountKey,
            runtimeTelemetry: deps.runtimeTelemetry,
            authorizeExternalAction: authorizeCompany,
            skills: deps.skills,
            judgeContractMode: 'enforce',
          },
        );
        if (!judgment) {
          return emptyOutcome({
            processed: true,
            refreshedProfile,
            viesMatched,
            failedSoft: true,
          });
        }
        if (gate.sanctions.staleMarker) {
          judgment.sanctionsStale = gate.sanctions.staleMarker;
        }

        await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
          // 2) Do NOT pass runId to persistJudgmentRecordInTransaction -> run_id = NULL (avoids discovery_run FK violation).
          await persistJudgmentRecordInTransaction(tx, input.icpId, judgment);
          // upsertLeadFit only writes fitVerdict / fitReasons / version on update, preserving human QUALIFIED/CONTACTED/CONVERTED status & queue.
          await upsertLeadFit(tx, input.workspaceId, input.icpId, input.companyId, judgment);
        });

        return emptyOutcome({
          processed: true,
          judged: true,
          leadUpdated: true,
          verdict: judgment.verdict,
          refreshedProfile,
          viesMatched,
        });
      } catch (error) {
        if (isActivityCancelledError(error)) throw error;
        if (isFatalRejudgeBudgetError(error)) {
          return emptyOutcome({
            refreshedProfile,
            viesMatched,
            fatalBudgetError: true,
          });
        }
        console.warn(
          `[rejudgeCompanyOnce] soft-failed ${input.companyId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return emptyOutcome({
          processed: true,
          refreshedProfile,
          viesMatched,
          failedSoft: true,
        });
      }
    },

    /**
     * 3) Enqueue zero-cost QualifyRequested with ONLY `{ rejudgeId }` — NEVER a `runId` key
     * so `qualifyWorkflowArgs` does not treat rejudgeId as a discoveryRunId FK.
     */
    async enqueueRejudgeQualify(input: RejudgeQualifyInput): Promise<void> {
      await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
        await tx.outboxEvent.create({
          data: {
            workspaceId: input.workspaceId,
            eventType: 'QualifyRequested',
            schemaVersion: 1,
            aggregateType: 'ICP',
            aggregateId: input.icpId,
            payload: { rejudgeId: input.rejudgeId } as unknown as Prisma.InputJsonValue,
          },
        });
      });
    },
  };
}

export type RejudgeActivities = ReturnType<typeof createRejudgeActivities>;
