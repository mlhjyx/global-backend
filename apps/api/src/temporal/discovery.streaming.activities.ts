import { createHash } from 'node:crypto';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { ExecutionBroker } from '../tools/tool-contract';
import { UnavailableBudgetStore, type BudgetStore } from '../tools/budget-store';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { companyMayUseExternalProcessing, loadCompanyForSuppressionSafeWrite } from '../discovery/company-suppression-gate';
import {
  companyContactObservation,
  persistCompanyContactPoints,
} from '../discovery/company-contact-points';
import { discoverContactsCore } from '../discovery/contact-discovery-core';
import { stampLawfulBasis } from '../discovery/compliance/email-verification-gate';
import { upsertLeadFit } from '../discovery/fit-judge';
import { appendRunEvent } from '../discovery/run2/run-events';
import {
  extractCompanyWebsiteStreaming,
  type StreamingCompanyExtraction,
} from '../discovery/streaming/raw-http-extractor';
import { judgeCompanyFitV3 } from '../discovery/streaming/fit-v3';
import {
  createInitialStreamingProgress,
  readStreamingRunProgress,
  upsertStreamingCandidate,
  type StreamingRunProgressSnapshot,
} from '../discovery/streaming/streaming-progress';
import type { DiscoveryRunFailure } from './discovery.run-failure';
import { startActivityHeartbeat } from './activity-heartbeat';
import { parseConfiguredLawfulBasis } from './backlog.activities';

export interface StreamingAuthorityInput {
  readonly workspaceId: string;
  readonly executionContractVersion?: number;
  readonly executionBudget?: unknown;
}

export interface StreamingL1CompanyResult {
  readonly companyId: string;
  readonly verdict: 'match' | 'weak' | 'mismatch';
  readonly score: number;
  readonly fetchMethod: 'raw_http' | 'crawl4ai' | 'skipped';
  readonly usedCrawl4aiFallback: boolean;
  readonly usedWwwRetry: boolean;
  readonly pdfSkipped: boolean;
  readonly channelsCount: number;
}

export interface StreamingFinalizeSummary {
  readonly queriesTotal: number;
  readonly queriesCompleted: number;
  readonly queriesFailed: number;
  readonly rawCount: number;
  readonly canonicalCount: number;
  readonly l1Processed: number;
  readonly l1Failed: number;
  readonly l2Selected: number;
  readonly l2Enriched: number;
  readonly l2ContactsFound: number;
  readonly l2Failed: number;
  readonly watchesRegistered: number;
}

const MAX_STREAMING_L1_COMPANIES = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCurrentActivityCancelled(): boolean {
  try {
    return Boolean(Context.current().cancellationSignal?.aborted);
  } catch {
    return false;
  }
}

function throwIfActivityCancelled(): void {
  if (isCurrentActivityCancelled()) {
    throw ApplicationFailure.nonRetryable('ACTIVITY_CANCELLED', 'CancelledFailure');
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildChannelsSummary(extraction: StreamingCompanyExtraction | null): string {
  if (!extraction) return 'no_website_extracted';
  const c = extraction.channels;
  return [
    `fetch=${extraction.fetchMethod}`,
    `roleEmails=${c.roleEmails.length}`,
    `phones=${c.phones.length}`,
    `inquiryForm=${c.hasInquiryForm}`,
    `socials=${c.socialLinks.length}`,
    `careers=${Boolean(c.careersPageUrl)}`,
  ].join(', ');
}

function mergeStreamingProgress(
  existingStats: unknown,
  runMeta: { id: string; status: string; createdAt: Date; completedAt: Date | null },
  mutator: (current: StreamingRunProgressSnapshot, now: string) => StreamingRunProgressSnapshot,
): { nextStats: Record<string, unknown>; nextProgress: StreamingRunProgressSnapshot } {
  const now = new Date().toISOString();
  const baseStats = isPlainRecord(existingStats) ? { ...existingStats } : {};
  const current = readStreamingRunProgress({
    id: runMeta.id,
    status: runMeta.status,
    stats: baseStats,
    createdAt: runMeta.createdAt,
    completedAt: runMeta.completedAt,
  });
  const nextProgress = mutator(current, now);
  return {
    nextStats: { ...baseStats, streaming: nextProgress },
    nextProgress,
  };
}

/** Row-level lock on discovery_run so concurrent L1/L2 activities never clobber stats.streaming. */
async function lockDiscoveryRunRow(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "discovery_run"
    WHERE "id" = ${runId}::uuid AND "workspace_id" = ${workspaceId}::uuid
    FOR UPDATE
  `;
}

async function persistExtractionFacts(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
  extraction: StreamingCompanyExtraction,
): Promise<void> {
  const company = await loadCompanyForSuppressionSafeWrite(tx, workspaceId, companyId);
  if (!company) return;
  const currentAttrs = isPlainRecord(company.attributes) ? { ...company.attributes } : {};
  const nextAttrs: Record<string, unknown> = {
    ...currentAttrs,
    streaming_extraction: {
      extractedAt: new Date().toISOString(),
      homepageUrl: extraction.homepageUrl,
      fetchMethod: extraction.fetchMethod,
      usedCrawl4aiFallback: extraction.usedCrawl4aiFallback,
      usedWwwRetry: extraction.usedWwwRetry,
      title: extraction.title,
      metaDescription: extraction.metaDescription,
      roleEmailCount: extraction.channels.roleEmails.length,
      phoneCount: extraction.channels.phones.length,
      hasInquiryForm: extraction.channels.hasInquiryForm,
      contactFormUrl: extraction.channels.contactFormUrl,
      contactPageUrl: extraction.channels.contactPageUrl,
      careersPageUrl: extraction.channels.careersPageUrl,
      socialLinks: extraction.channels.socialLinks.slice(0, 6),
    },
  };
  await tx.canonicalCompany.updateMany({
    where: { id: companyId, status: { not: 'SUPPRESSED' } },
    data: { attributes: nextAttrs as Prisma.InputJsonValue, version: { increment: 1 } },
  });

  const linkedin = extraction.channels.socialLinks.find((u) => /linkedin\.com\/company\//iu.test(u)) ?? null;
  const xAccount = extraction.channels.socialLinks.find((u) => /(?:x|twitter)\.com\//iu.test(u)) ?? null;
  const observation = companyContactObservation({
    contactPage: extraction.channels.contactPageUrl,
    impressumPage: extraction.channels.impressumUrl,
    supplierPage: null,
    linkedinCompanyPage: linkedin,
    xCompanyAccount: xAccount,
    linksChecked: extraction.pagesFetched.length > 0,
    contactForm: extraction.channels.contactFormUrl,
    contactFormChecked: extraction.pagesFetched.length > 0,
  });
  if (observation.points.length > 0) {
    await persistCompanyContactPoints(tx, {
      workspaceId,
      companyId,
      observation,
      seenAt: new Date(),
    });
  }

  const now = new Date();
  const signals: Array<{
    workspaceId: string;
    companyId: string;
    providerKey: string;
    signalKind: string;
    sourceUrl: string;
    title: string;
    excerpt: string | null;
    observedAt: Date;
    fingerprint: string;
    ingestKey: string;
  }> = [];
  if (extraction.channels.careersPageUrl) {
    const fp = sha256Hex(`${companyId}|careers|${extraction.channels.careersPageUrl}`);
    signals.push({
      workspaceId,
      companyId,
      providerKey: 'streaming_website',
      signalKind: 'hiring_page',
      sourceUrl: extraction.channels.careersPageUrl,
      title: 'Careers / Hiring Page Detected',
      excerpt: extraction.title,
      observedAt: now,
      fingerprint: fp,
      ingestKey: `streaming:${companyId}:careers:${fp.slice(0, 16)}`,
    });
  }
  for (const job of extraction.jsonLd.jobPostings.slice(0, 3)) {
    const fp = sha256Hex(`${companyId}|job|${job.title}|${job.location ?? ''}`);
    signals.push({
      workspaceId,
      companyId,
      providerKey: 'streaming_website',
      signalKind: 'job_posting',
      sourceUrl: extraction.homepageUrl,
      title: job.title.slice(0, 200),
      excerpt: job.location,
      observedAt: now,
      fingerprint: fp,
      ingestKey: `streaming:${companyId}:job:${fp.slice(0, 16)}`,
    });
  }
  if (signals.length > 0) {
    await tx.companySignal.createMany({ data: signals, skipDuplicates: true });
  }
}

export function createStreamingDiscoveryActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  broker: ExecutionBroker;
  runtimeTelemetry?: RuntimeTelemetry;
  budgetStore?: BudgetStore;
}) {
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore('streaming discovery activities require an authoritative BudgetStore');

  const ensureRunBudget = async (args: StreamingAuthorityInput): Promise<ExecutionBudgetBinding> => {
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

  const activities = {
    async initStreamingRun(
      args: StreamingAuthorityInput & {
        runId: string;
        icpId: string;
        queriesTotal: number;
        topKCap: number;
      },
    ): Promise<void> {
      await ensureRunBudget(args);
      const now = new Date().toISOString();
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
        if (!run) return;
        const baseStats = isPlainRecord(run.stats) ? { ...run.stats } : {};
        const initial = createInitialStreamingProgress(args.runId, {
          queriesTotal: args.queriesTotal,
          topKCap: args.topKCap,
          now,
        });
        await tx.discoveryRun.update({
          where: { id: args.runId },
          data: {
            status: 'RUNNING',
            stats: { ...baseStats, streaming: initial } as unknown as Prisma.InputJsonValue,
            phases: { l0StartedAt: now } as unknown as Prisma.InputJsonValue,
          },
        });
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_started',
          payload: { phase: 'l0_recall', queriesTotal: args.queriesTotal },
        });
      });
    },

    async recordStreamingL0Complete(
      args: StreamingAuthorityInput & {
        runId: string;
        icpId: string;
        queriesTotal: number;
        queriesCompleted: number;
        candidatesRecalled: number;
        canonicalUpserted: number;
      },
    ): Promise<{ companyIds: string[] }> {
      await ensureRunBudget(args);
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const rawRecords = await tx.rawSourceRecord.findMany({
          where: { runId: args.runId, ingestStatus: 'ACCEPTED', ingestVersion: 'raw-source/v2' },
          select: { id: true },
        });
        const links =
          rawRecords.length > 0
            ? await tx.identityLink.findMany({
                where: { rawRecordId: { in: rawRecords.map((r) => r.id) }, canonicalType: 'company' },
                select: { canonicalId: true },
              })
            : [];
        const uniqueIds = [...new Set(links.map((l) => l.canonicalId))].slice(
          0,
          MAX_STREAMING_L1_COMPANIES,
        );
        const companies =
          uniqueIds.length > 0
            ? await tx.canonicalCompany.findMany({
                where: { id: { in: uniqueIds }, status: { not: 'SUPPRESSED' } },
                select: { id: true, name: true, domain: true, country: true },
              })
            : [];
        const companyIds = companies.map((c) => c.id);
        if (companyIds.length > 0) {
          await tx.discoveryCompanyJob.createMany({
            data: companyIds.map((companyId) => ({
              workspaceId: args.workspaceId,
              runId: args.runId,
              canonicalCompanyId: companyId,
              stage: 'queued',
            })),
            skipDuplicates: true,
          });
        }
        await lockDiscoveryRunRow(tx, args.workspaceId, args.runId);
        const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
        if (run) {
          const now = new Date().toISOString();
          const { nextStats } = mergeStreamingProgress(run.stats, run, (current) => ({
            ...current,
            currentStage: companyIds.length > 0 ? 'l1_extract_fit' : 'l2_topk_enrich',
            updatedAt: now,
            stages: {
              ...current.stages,
              l0Recall: {
                ...current.stages.l0Recall,
                status: 'done',
                queriesTotal: args.queriesTotal,
                queriesCompleted: args.queriesCompleted,
                candidatesRecalled: args.candidatesRecalled,
                canonicalUpserted: companyIds.length,
                completedAt: now,
              },
              l1ExtractFit: {
                ...current.stages.l1ExtractFit,
                status: companyIds.length > 0 ? 'running' : 'done',
                total: companyIds.length,
                startedAt: now,
                completedAt: companyIds.length > 0 ? null : now,
              },
            },
            recentCandidates: companies.slice(0, 20).map((company) => ({
              companyId: company.id,
              name: company.name,
              domain: company.domain,
              country: company.country,
              stage: 'l0_recalled' as const,
              fitVerdict: null,
              fitScore: null,
              fetchMethod: null,
              channelsFound: { emails: 0, phones: 0, forms: 0, socials: 0 },
              reasonSummary: null,
              updatedAt: now,
            })),
          }));
          const phases = isPlainRecord(run.phases) ? { ...run.phases } : {};
          await tx.discoveryRun.update({
            where: { id: args.runId },
            data: {
              stats: nextStats as unknown as Prisma.InputJsonValue,
              phases: { ...phases, l0DoneAt: now, l1StartedAt: now } as unknown as Prisma.InputJsonValue,
            },
          });
          await appendRunEvent(tx as never, {
            workspaceId: args.workspaceId,
            runId: args.runId,
            type: 'phase_completed',
            payload: { phase: 'l0_recall', canonicalUpserted: companyIds.length },
          });
          await appendRunEvent(tx as never, {
            workspaceId: args.workspaceId,
            runId: args.runId,
            type: 'phase_started',
            payload: { phase: 'l1_extract_fit', total: companyIds.length },
          });
        }
        return { companyIds };
      });
    },

    async processStreamingL1Company(
      args: StreamingAuthorityInput & {
        runId: string;
        icpId: string;
        companyId: string;
      },
    ): Promise<StreamingL1CompanyResult> {
      const heartbeat = startActivityHeartbeat({ stage: 'l1', companyId: args.companyId }, 15_000);
      try {
        throwIfActivityCancelled();
        const binding = await ensureRunBudget(args);
        const loaded = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const allowed = await companyMayUseExternalProcessing(tx, args.workspaceId, args.companyId);
          const company = await tx.canonicalCompany.findUnique({ where: { id: args.companyId } });
          const icp = await tx.icpDefinition.findUnique({ where: { id: args.icpId } });
          await tx.discoveryCompanyJob.updateMany({
            where: { runId: args.runId, canonicalCompanyId: args.companyId },
            data: { stage: 'profiling', startedAt: new Date() },
          });
          return { allowed, company, icp };
        });

        if (!loaded.company || !loaded.icp || !loaded.allowed) {
          return {
            companyId: args.companyId,
            verdict: 'mismatch',
            score: 0,
            fetchMethod: 'skipped',
            usedCrawl4aiFallback: false,
            usedWwwRetry: false,
            pdfSkipped: false,
            channelsCount: 0,
          };
        }

        throwIfActivityCancelled();
        let extraction: StreamingCompanyExtraction | null = null;
        if (loaded.company.domain) {
          extraction = await extractCompanyWebsiteStreaming({
            broker: deps.broker,
            workspaceId: args.workspaceId,
            companyId: args.companyId,
            runId: binding.accountKey,
            domain: loaded.company.domain,
            authorizeExternalAction: () =>
              deps.prisma.withWorkspace(args.workspaceId, (tx) =>
                companyMayUseExternalProcessing(tx, args.workspaceId, args.companyId),
              ),
          });
        }

        throwIfActivityCancelled();
        const fit = await judgeCompanyFitV3({
          gateway: deps.gateway,
          runtimeTelemetry: deps.runtimeTelemetry,
          workspaceId: args.workspaceId,
          runId: binding.accountKey,
          icp: {
            name: loaded.icp.name,
            targetMarkets: loaded.icp.targetMarkets,
            exclusions: loaded.icp.exclusions,
            companyAttributes: loaded.icp.companyAttributes,
          },
          company: {
            id: loaded.company.id,
            name: loaded.company.name,
            domain: loaded.company.domain,
            country: loaded.company.country,
            industry: loaded.company.industry,
            title: extraction?.title ?? null,
            metaDescription: extraction?.metaDescription ?? null,
            visibleText: extraction?.visibleText ?? '',
            channelsSummary: buildChannelsSummary(extraction),
            jsonLdSummary: extraction?.jsonLd.descriptions.join(' ') || null,
          },
        });

        const channelsFound = {
          emails: extraction ? extraction.channels.roleEmails.length + extraction.channels.otherEmails.length : 0,
          phones: extraction ? extraction.channels.phones.length : 0,
          forms: extraction?.channels.hasInquiryForm ? 1 : 0,
          socials: extraction ? extraction.channels.socialLinks.length : 0,
        };
        const channelsCount =
          channelsFound.emails + channelsFound.phones + channelsFound.forms + channelsFound.socials;
        const fetchMethod = extraction?.fetchMethod ?? 'skipped';

        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          if (extraction && extraction.pagesFetched.length > 0) {
            await persistExtractionFacts(tx, args.workspaceId, args.companyId, extraction);
          }
          await upsertLeadFit(tx, args.workspaceId, args.icpId, args.companyId, fit);
          await tx.discoveryCompanyJob.updateMany({
            where: { runId: args.runId, canonicalCompanyId: args.companyId },
            data: { stage: 'done', verdictDeep: fit.verdict, finishedAt: new Date() },
          });
          await lockDiscoveryRunRow(tx, args.workspaceId, args.runId);
          const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
          if (run) {
            const { nextStats } = mergeStreamingProgress(run.stats, run, (current, now) => {
              const l1 = current.stages.l1ExtractFit;
              return {
                ...current,
                updatedAt: now,
                stages: {
                  ...current.stages,
                  l1ExtractFit: {
                    ...l1,
                    processed: l1.processed + 1,
                    rawHttpHits: l1.rawHttpHits + (fetchMethod === 'raw_http' ? 1 : 0),
                    crawl4aiFallbacks: l1.crawl4aiFallbacks + (extraction?.usedCrawl4aiFallback ? 1 : 0),
                    pdfSkipped: l1.pdfSkipped + (extraction?.pdfSkipped ? 1 : 0),
                    wwwRetries: l1.wwwRetries + (extraction?.usedWwwRetry ? 1 : 0),
                    fitMatch: l1.fitMatch + (fit.verdict === 'match' ? 1 : 0),
                    fitWeak: l1.fitWeak + (fit.verdict === 'weak' ? 1 : 0),
                    fitMismatch: l1.fitMismatch + (fit.verdict === 'mismatch' ? 1 : 0),
                  },
                },
                recentCandidates: upsertStreamingCandidate(current.recentCandidates, {
                  companyId: loaded.company!.id,
                  name: loaded.company!.name,
                  domain: loaded.company!.domain,
                  country: loaded.company!.country,
                  stage: 'l1_scored',
                  fitVerdict: fit.verdict,
                  fitScore: fit.score,
                  fetchMethod,
                  channelsFound,
                  reasonSummary: fit.fitReasons.reasons[0]?.slice(0, 180) ?? null,
                  updatedAt: now,
                }),
              };
            });
            await tx.discoveryRun.update({
              where: { id: args.runId },
              data: { stats: nextStats as unknown as Prisma.InputJsonValue },
            });
          }
          await appendRunEvent(tx as never, {
            workspaceId: args.workspaceId,
            runId: args.runId,
            type: 'company_done',
            payload: {
              companyId: args.companyId,
              stage: 'l1_extract_fit',
              verdict: fit.verdict,
              score: fit.score,
              fetchMethod,
            },
          });
        });

        return {
          companyId: args.companyId,
          verdict: fit.verdict,
          score: fit.score,
          fetchMethod,
          usedCrawl4aiFallback: extraction?.usedCrawl4aiFallback ?? false,
          usedWwwRetry: extraction?.usedWwwRetry ?? false,
          pdfSkipped: extraction?.pdfSkipped ?? false,
          channelsCount,
        };
      } finally {
        heartbeat.stop();
      }
    },

    async startStreamingL2Stage(
      args: StreamingAuthorityInput & {
        runId: string;
        icpId: string;
        topKCap: number;
        selectedCount: number;
      },
    ): Promise<void> {
      await ensureRunBudget(args);
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        await lockDiscoveryRunRow(tx, args.workspaceId, args.runId);
        const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
        if (!run) return;
        const now = new Date().toISOString();
        const { nextStats } = mergeStreamingProgress(run.stats, run, (current) => ({
          ...current,
          currentStage: args.selectedCount > 0 ? 'l2_topk_enrich' : 'finalizing',
          updatedAt: now,
          stages: {
            ...current.stages,
            l1ExtractFit: { ...current.stages.l1ExtractFit, status: 'done', completedAt: now },
            l2TopKEnrich: {
              ...current.stages.l2TopKEnrich,
              status: args.selectedCount > 0 ? 'running' : 'skipped',
              topKCap: args.topKCap,
              selected: args.selectedCount,
              startedAt: now,
              completedAt: args.selectedCount > 0 ? null : now,
            },
          },
        }));
        const phases = isPlainRecord(run.phases) ? { ...run.phases } : {};
        await tx.discoveryRun.update({
          where: { id: args.runId },
          data: {
            stats: nextStats as unknown as Prisma.InputJsonValue,
            phases: { ...phases, l1DoneAt: now, l2StartedAt: now } as unknown as Prisma.InputJsonValue,
          },
        });
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_completed',
          payload: { phase: 'l1_extract_fit' },
        });
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_started',
          payload: { phase: 'l2_topk_enrich', selected: args.selectedCount, topKCap: args.topKCap },
        });
      });
    },

    async enrichStreamingTopKCompany(
      args: StreamingAuthorityInput & {
        runId: string;
        icpId: string;
        companyId: string;
      },
    ): Promise<{ companyId: string; contactsCreated: number }> {
      const heartbeat = startActivityHeartbeat({ stage: 'l2', companyId: args.companyId }, 15_000);
      try {
        throwIfActivityCancelled();
        const binding = await ensureRunBudget(args);
        const allowed = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          companyMayUseExternalProcessing(tx, args.workspaceId, args.companyId),
        );
        if (!allowed) return { companyId: args.companyId, contactsCreated: 0 };

        let contactsCreated = 0;
        const lawfulBasis = parseConfiguredLawfulBasis(process.env.CONTACT_DISCOVERY_RUN_LAWFUL_BASIS);
        if (lawfulBasis) {
          const stamped = stampLawfulBasis(lawfulBasis, 'streaming-worker', new Date().toISOString());
          const discovered = await discoverContactsCore(
            { prisma: deps.prisma, providers: deps.providers, budgetStore: budgets },
            {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              lawfulBasis: stamped,
              binding,
              audit: {
                actorId: 'streaming-worker',
                actorKind: 'system',
                purpose: 'contact_discovery',
                correlationId: args.runId,
              },
            },
          );
          contactsCreated = discovered.contacts.length;
        }

        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          await lockDiscoveryRunRow(tx, args.workspaceId, args.runId);
          const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
          if (!run) return;
          const { nextStats } = mergeStreamingProgress(run.stats, run, (current, now) => ({
            ...current,
            updatedAt: now,
            stages: {
              ...current.stages,
              l2TopKEnrich: {
                ...current.stages.l2TopKEnrich,
                enriched: current.stages.l2TopKEnrich.enriched + 1,
                contactsFound: current.stages.l2TopKEnrich.contactsFound + contactsCreated,
              },
            },
            recentCandidates: current.recentCandidates.map((item) =>
              item.companyId === args.companyId ? { ...item, stage: 'done' as const, updatedAt: now } : item,
            ),
          }));
          await tx.discoveryRun.update({
            where: { id: args.runId },
            data: { stats: nextStats as unknown as Prisma.InputJsonValue },
          });
        });

        return { companyId: args.companyId, contactsCreated };
      } finally {
        heartbeat.stop();
      }
    },

    async finalizeStreamingRun(
      args: StreamingAuthorityInput & {
        runId: string;
        planId: string;
        icpId: string;
        status: 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
        failure?: DiscoveryRunFailure;
        summary: StreamingFinalizeSummary;
      },
    ): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const nowDate = new Date();
        const nowIso = nowDate.toISOString();
        if (args.status === 'CANCELLED') {
          await tx.discoveryCompanyJob.updateMany({
            where: {
              runId: args.runId,
              stage: { in: ['queued', 'profiling', 'fitting', 'signals', 'contacts'] },
            },
            data: { stage: 'skipped', lastErrorCode: 'STREAMING_STOPPED', finishedAt: nowDate },
          });
        }
        await lockDiscoveryRunRow(tx, args.workspaceId, args.runId);
        const run = await tx.discoveryRun.findUnique({ where: { id: args.runId } });
        if (!run) return;
        const stageOutcome =
          args.status === 'CANCELLED' ? 'cancelled' : args.status === 'FAILED' ? 'failed' : 'done';
        const { nextStats } = mergeStreamingProgress(run.stats, run, (current) => ({
          ...current,
          runStatus: args.status,
          currentStage: stageOutcome,
          updatedAt: nowIso,
          stages: {
            l0Recall: {
              ...current.stages.l0Recall,
              status: current.stages.l0Recall.status === 'running' ? stageOutcome : current.stages.l0Recall.status,
              queriesTotal: args.summary.queriesTotal,
              queriesCompleted: args.summary.queriesCompleted,
              candidatesRecalled: args.summary.rawCount,
              canonicalUpserted: args.summary.canonicalCount,
              completedAt: current.stages.l0Recall.completedAt ?? nowIso,
            },
            l1ExtractFit: {
              ...current.stages.l1ExtractFit,
              status:
                current.stages.l1ExtractFit.status === 'running' ? stageOutcome : current.stages.l1ExtractFit.status,
              processed: Math.max(current.stages.l1ExtractFit.processed, args.summary.l1Processed),
              failed: args.summary.l1Failed,
              completedAt: current.stages.l1ExtractFit.completedAt ?? nowIso,
            },
            l2TopKEnrich: {
              ...current.stages.l2TopKEnrich,
              status:
                current.stages.l2TopKEnrich.status === 'running' ? stageOutcome : current.stages.l2TopKEnrich.status,
              selected: Math.max(current.stages.l2TopKEnrich.selected, args.summary.l2Selected),
              enriched: Math.max(current.stages.l2TopKEnrich.enriched, args.summary.l2Enriched),
              contactsFound: Math.max(current.stages.l2TopKEnrich.contactsFound, args.summary.l2ContactsFound),
              watchesRegistered: args.summary.watchesRegistered,
              failed: args.summary.l2Failed,
              completedAt: current.stages.l2TopKEnrich.completedAt ?? nowIso,
            },
          },
        }));
        const finalStats: Record<string, unknown> = {
          ...nextStats,
          pipelineMode: 'streaming',
          queriesTotal: args.summary.queriesTotal,
          queriesSucceeded: args.summary.queriesCompleted,
          queriesFailed: args.summary.queriesFailed,
          rawCount: args.summary.rawCount,
          canonicalCount: args.summary.canonicalCount,
          fitEvaluated: args.summary.l1Processed,
          fitFailed: args.summary.l1Failed,
          contactsEnriched: args.summary.l2Enriched,
          contactsCreated: args.summary.l2ContactsFound,
          watchesRegistered: args.summary.watchesRegistered,
          ...(args.failure ? { failure: args.failure } : {}),
        };
        const phases = isPlainRecord(run.phases) ? { ...run.phases } : {};
        await tx.discoveryRun.update({
          where: { id: args.runId },
          data: {
            status: args.status,
            completedAt: nowDate,
            stats: finalStats as unknown as Prisma.InputJsonValue,
            phases: { ...phases, l2DoneAt: nowIso } as unknown as Prisma.InputJsonValue,
          },
        });
        if (args.status === 'DONE' || args.status === 'PARTIAL') {
          await tx.discoveryQueryPlan.updateMany({
            where: { id: args.planId, status: 'READY' },
            data: { status: 'EXECUTED', version: { increment: 1 } },
          });
        }
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'run_finished',
          payload: { status: args.status, pipelineMode: 'streaming', ...args.summary },
        });
        if (args.summary.l1Processed > 0) {
          await tx.outboxEvent.create({
            data: {
              workspaceId: args.workspaceId,
              eventType: 'QualifyRequested',
              aggregateType: 'ICP',
              aggregateId: args.icpId,
              payload: { runId: args.runId, source: 'discovery_streaming' },
            },
          });
        }
      });
    },
  };

  return activities;
}

export type StreamingDiscoveryActivities = ReturnType<typeof createStreamingDiscoveryActivities>;
