/**
 * Plan B streaming funnel progress projection (L0 recall -> L1 extract+fit -> L2 top-K enrich).
 * Stored inside DiscoveryRun.stats.streaming (zero Prisma migration) and exposed directly via
 * GET /api/v1/discovery-runs/:runId/streaming-progress.
 */

export type StreamingStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type StreamingCurrentStage =
  | 'l0_recall'
  | 'l1_extract_fit'
  | 'l2_topk_enrich'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'failed';

export type StreamingCandidateStage =
  | 'l0_recalled'
  | 'l1_extracting'
  | 'l1_scored'
  | 'l2_enriching'
  | 'done'
  | 'failed'
  | 'skipped';

export interface StreamingCandidateSnapshot {
  readonly companyId: string;
  readonly name: string;
  readonly domain: string | null;
  readonly country: string | null;
  readonly stage: StreamingCandidateStage;
  readonly fitVerdict: 'match' | 'weak' | 'mismatch' | null;
  readonly fitScore: number | null;
  readonly fetchMethod: 'raw_http' | 'crawl4ai' | 'skipped' | null;
  readonly channelsFound: {
    readonly emails: number;
    readonly phones: number;
    readonly forms: number;
    readonly socials: number;
  };
  readonly reasonSummary: string | null;
  readonly updatedAt: string;
}

export interface StreamingL0Progress {
  readonly status: StreamingStageStatus;
  readonly queriesTotal: number;
  readonly queriesCompleted: number;
  readonly candidatesRecalled: number;
  readonly canonicalUpserted: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface StreamingL1Progress {
  readonly status: StreamingStageStatus;
  readonly total: number;
  readonly processed: number;
  readonly rawHttpHits: number;
  readonly crawl4aiFallbacks: number;
  readonly pdfSkipped: number;
  readonly wwwRetries: number;
  readonly fitMatch: number;
  readonly fitWeak: number;
  readonly fitMismatch: number;
  readonly failed: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface StreamingL2Progress {
  readonly status: StreamingStageStatus;
  readonly topKCap: number;
  readonly selected: number;
  readonly enriched: number;
  readonly contactsFound: number;
  readonly watchesRegistered: number;
  readonly failed: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface StreamingRunProgressSnapshot {
  readonly runId: string;
  readonly pipelineMode: 'streaming' | 'legacy';
  readonly runStatus: string;
  readonly currentStage: StreamingCurrentStage;
  readonly updatedAt: string;
  readonly stages: {
    readonly l0Recall: StreamingL0Progress;
    readonly l1ExtractFit: StreamingL1Progress;
    readonly l2TopKEnrich: StreamingL2Progress;
  };
  readonly recentCandidates: readonly StreamingCandidateSnapshot[];
}

export const MAX_RECENT_STREAMING_CANDIDATES = 60;

export function createInitialStreamingProgress(
  runId: string,
  opts: { queriesTotal?: number; topKCap?: number; now?: string } = {},
): StreamingRunProgressSnapshot {
  const now = opts.now ?? new Date().toISOString();
  return {
    runId,
    pipelineMode: 'streaming',
    runStatus: 'RUNNING',
    currentStage: 'l0_recall',
    updatedAt: now,
    stages: {
      l0Recall: {
        status: 'running',
        queriesTotal: opts.queriesTotal ?? 0,
        queriesCompleted: 0,
        candidatesRecalled: 0,
        canonicalUpserted: 0,
        startedAt: now,
        completedAt: null,
      },
      l1ExtractFit: {
        status: 'pending',
        total: 0,
        processed: 0,
        rawHttpHits: 0,
        crawl4aiFallbacks: 0,
        pdfSkipped: 0,
        wwwRetries: 0,
        fitMatch: 0,
        fitWeak: 0,
        fitMismatch: 0,
        failed: 0,
        startedAt: null,
        completedAt: null,
      },
      l2TopKEnrich: {
        status: 'pending',
        topKCap: opts.topKCap ?? 20,
        selected: 0,
        enriched: 0,
        contactsFound: 0,
        watchesRegistered: 0,
        failed: 0,
        startedAt: null,
        completedAt: null,
      },
    },
    recentCandidates: [],
  };
}

export function upsertStreamingCandidate(
  existing: readonly StreamingCandidateSnapshot[],
  candidate: StreamingCandidateSnapshot,
): StreamingCandidateSnapshot[] {
  const filtered = existing.filter((item) => item.companyId !== candidate.companyId);
  return [candidate, ...filtered].slice(0, MAX_RECENT_STREAMING_CANDIDATES);
}

function legacyCurrentStage(status: string): StreamingCurrentStage {
  if (status === 'DONE' || status === 'PARTIAL') return 'done';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'FAILED') return 'failed';
  return 'l1_extract_fit';
}

function legacyStageStatus(status: string): StreamingStageStatus {
  if (status === 'DONE' || status === 'PARTIAL') return 'done';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'FAILED') return 'failed';
  return 'running';
}

/**
 * Reads DiscoveryRun.stats.streaming if present, or synthesizes a clean `pipelineMode: 'legacy'`
 * projection for historical discoveryWorkflow runs so frontend pollers never break.
 */
export function readStreamingRunProgress(run: {
  id: string;
  status: string;
  stats: unknown;
  createdAt: Date;
  completedAt: Date | null;
}): StreamingRunProgressSnapshot {
  const stats =
    run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats)
      ? (run.stats as Record<string, unknown>)
      : {};
  const raw = stats.streaming;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Partial<StreamingRunProgressSnapshot>;
    if (record.pipelineMode === 'streaming' && record.stages) {
      return {
        ...record,
        runId: run.id,
        pipelineMode: 'streaming',
        runStatus: run.status,
        currentStage:
          run.status === 'CANCELLED'
            ? 'cancelled'
            : run.status === 'FAILED'
              ? 'failed'
              : run.status === 'DONE' || run.status === 'PARTIAL'
                ? 'done'
                : (record.currentStage ?? 'l1_extract_fit'),
        updatedAt: record.updatedAt ?? (run.completedAt ?? run.createdAt).toISOString(),
        recentCandidates: Array.isArray(record.recentCandidates) ? record.recentCandidates : [],
      } as StreamingRunProgressSnapshot;
    }
  }

  const stageStatus = legacyStageStatus(run.status);
  const startedAt = run.createdAt.toISOString();
  const completedAt = run.completedAt?.toISOString() ?? null;
  return {
    runId: run.id,
    pipelineMode: 'legacy',
    runStatus: run.status,
    currentStage: legacyCurrentStage(run.status),
    updatedAt: completedAt ?? startedAt,
    stages: {
      l0Recall: {
        status: stageStatus,
        queriesTotal: Number(stats.queriesTotal ?? 0) || 0,
        queriesCompleted: Number(stats.queriesSucceeded ?? 0) || 0,
        candidatesRecalled: Number(stats.rawCount ?? 0) || 0,
        canonicalUpserted: Number(stats.canonicalCount ?? 0) || 0,
        startedAt,
        completedAt,
      },
      l1ExtractFit: {
        status: stageStatus,
        total: Number(stats.canonicalCount ?? 0) || 0,
        processed: Number(stats.fitEvaluated ?? 0) || 0,
        rawHttpHits: 0,
        crawl4aiFallbacks: 0,
        pdfSkipped: 0,
        wwwRetries: 0,
        fitMatch: Number(stats.fitMatch ?? 0) || 0,
        fitWeak: Number(stats.fitWeak ?? 0) || 0,
        fitMismatch: Number(stats.fitMismatch ?? 0) || 0,
        failed: Number(stats.fitFailed ?? 0) || 0,
        startedAt,
        completedAt,
      },
      l2TopKEnrich: {
        status: stageStatus,
        topKCap: 0,
        selected: Number(stats.fitMatch ?? 0) || 0,
        enriched: Number(stats.contactsEnriched ?? 0) || 0,
        contactsFound: Number(stats.contactsCreated ?? 0) || 0,
        watchesRegistered: Number(stats.watchesRegistered ?? 0) || 0,
        failed: 0,
        startedAt,
        completedAt,
      },
    },
    recentCandidates: [],
  };
}
