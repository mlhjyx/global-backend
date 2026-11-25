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

function asInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function resolveTerminalCurrentStage(
  runStatus: string,
  recorded: StreamingCurrentStage | undefined,
): StreamingCurrentStage {
  if (runStatus === 'CANCELLED') return 'cancelled';
  if (runStatus === 'FAILED') return 'failed';
  if (runStatus === 'DONE' || runStatus === 'PARTIAL') return 'done';
  return recorded ?? 'l1_extract_fit';
}

function projectExistingStreamingProgress(
  run: { id: string; status: string; createdAt: Date; completedAt: Date | null },
  raw: unknown,
): StreamingRunProgressSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Partial<StreamingRunProgressSnapshot>;
  if (record.pipelineMode !== 'streaming' || !record.stages) return null;
  return {
    ...record,
    runId: run.id,
    pipelineMode: 'streaming',
    runStatus: run.status,
    currentStage: resolveTerminalCurrentStage(run.status, record.currentStage),
    updatedAt: record.updatedAt ?? (run.completedAt ?? run.createdAt).toISOString(),
    recentCandidates: Array.isArray(record.recentCandidates) ? record.recentCandidates : [],
  } as StreamingRunProgressSnapshot;
}

function synthesizeLegacyStreamingProgress(
  run: { id: string; status: string; createdAt: Date; completedAt: Date | null },
  stats: Record<string, unknown>,
): StreamingRunProgressSnapshot {
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
        queriesTotal: asInt(stats.queriesTotal),
        queriesCompleted: asInt(stats.queriesSucceeded),
        candidatesRecalled: asInt(stats.rawCount),
        canonicalUpserted: asInt(stats.canonicalCount),
        startedAt,
        completedAt,
      },
      l1ExtractFit: {
        status: stageStatus,
        total: asInt(stats.canonicalCount),
        processed: asInt(stats.fitEvaluated),
        rawHttpHits: 0,
        crawl4aiFallbacks: 0,
        pdfSkipped: 0,
        wwwRetries: 0,
        fitMatch: asInt(stats.fitMatch),
        fitWeak: asInt(stats.fitWeak),
        fitMismatch: asInt(stats.fitMismatch),
        failed: asInt(stats.fitFailed),
        startedAt,
        completedAt,
      },
      l2TopKEnrich: {
        status: stageStatus,
        topKCap: 0,
        selected: asInt(stats.fitMatch),
        enriched: asInt(stats.contactsEnriched),
        contactsFound: asInt(stats.contactsCreated),
        watchesRegistered: asInt(stats.watchesRegistered),
        failed: 0,
        startedAt,
        completedAt,
      },
    },
    recentCandidates: [],
  };
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
  return (
    projectExistingStreamingProgress(run, stats.streaming) ??
    synthesizeLegacyStreamingProgress(run, stats)
  );
}
