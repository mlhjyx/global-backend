import {
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
} from '@temporalio/workflow';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import { DISCOVERY_QUERY_RECEIPT_MODE } from '../discovery/discovery-query-receipt-contract';
import { describeDiscoveryRunFailure, type DiscoveryRunStage } from './discovery.run-failure';
import {
  resolveStreamingWorkflowKnobs,
  type StreamingWorkflowKnobsInput,
} from './discovery.streaming-knobs';
import type { DiscoveryActivities, DiscoveryRunInput } from './discovery.activities';
import type {
  StreamingDiscoveryActivities,
  StreamingL1CompanyResult,
} from './discovery.streaming.activities';

export interface DiscoveryStreamingInput extends DiscoveryRunInput, StreamingWorkflowKnobsInput {}

const streamingActivities = proxyActivities<
  Pick<
    DiscoveryActivities,
    'loadPlanQueries' | 'executeQuery' | 'canonicalizeRun' | 'registerWatchesForRun'
  > &
    StreamingDiscoveryActivities
>({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
});

function requireStreamingAuthority(input: DiscoveryStreamingInput): ExecutionBudgetBinding {
  try {
    if (input.executionContractVersion !== 2) throw new Error('invalid contract version');
    return parseExecutionBudgetBinding(input.executionBudget, {
      scopeKey: input.workspaceId,
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
    });
  } catch {
    throw ApplicationFailure.nonRetryable(
      'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
      'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
    );
  }
}

/** Deterministic Top-K selector: match before weak, higher fitScore first, stable by companyId; mismatch excluded. */
export function selectTopKStreamingCompanies(
  results: readonly StreamingL1CompanyResult[],
  cap: number,
): StreamingL1CompanyResult[] {
  return [...results]
    .filter((item) => item.verdict === 'match' || item.verdict === 'weak')
    .sort((a, b) => {
      const rankA = a.verdict === 'match' ? 0 : 1;
      const rankB = b.verdict === 'match' ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
      if (b.score !== a.score) return b.score - a.score;
      return a.companyId.localeCompare(b.companyId);
    })
    .slice(0, Math.max(0, cap));
}

function resolveStreamingOutcome(totals: {
  l0QueriesFailed: number;
  l1Total: number;
  l1Processed: number;
  l1Failed: number;
  l2Failed: number;
}): 'DONE' | 'PARTIAL' | 'FAILED' {
  if (totals.l1Total > 0 && totals.l1Processed === 0 && totals.l1Failed > 0) {
    return 'FAILED';
  }
  if (totals.l0QueriesFailed > 0 || totals.l1Failed > 0 || totals.l2Failed > 0) {
    return 'PARTIAL';
  }
  return 'DONE';
}

/**
 * Plan B streaming three-stage discovery workflow (zero legacy patched() debt):
 * - L0 micro-batch: search queries -> canonical_company upsert FIRST (satisfies SUBJECT_BINDING_HOLD).
 * - L1 micro-batch: per-company single activity (Raw HTTP-first -> thin Crawl4AI fallback -> unified fit-v3 -> Lead upsert).
 * - L2 Top-K: bounded contact enrichment + website watch registration for highest-scoring match/weak candidates.
 * - CancellationScope.nonCancellable finalization: preserves partial counts, marks CANCELLED, always triggers QualifyRequested.
 */
export async function discoveryStreamingWorkflow(input: DiscoveryStreamingInput): Promise<void> {
  const executionBudget = requireStreamingAuthority(input);
  const authority = {
    workspaceId: input.workspaceId,
    executionContractVersion: 2 as const,
    executionBudget,
    ...(input.manufacturerNetworkExecution
      ? { manufacturerNetworkExecution: input.manufacturerNetworkExecution }
      : {}),
  };

  const { queryBatchSize, l1Concurrency, topKCap, l2Concurrency } =
    resolveStreamingWorkflowKnobs(input);

  let currentStage: DiscoveryRunStage = 'plan';
  let queriesTotal = 0;
  let queriesCompleted = 0;
  let queriesFailed = 0;
  let rawCount = 0;
  let canonicalCount = 0;
  const l1Results: StreamingL1CompanyResult[] = [];
  let l1Failed = 0;
  let l2Selected = 0;
  let l2Enriched = 0;
  let l2ContactsFound = 0;
  let l2Failed = 0;
  let watchesRegistered = 0;

  try {
    const { queries } = await streamingActivities.loadPlanQueries({
      ...authority,
      planId: input.planId,
    });
    queriesTotal = queries.length;

    await streamingActivities.initStreamingRun({
      ...authority,
      runId: input.runId,
      icpId: input.icpId,
      queriesTotal,
      topKCap,
    });

    // ── Stage L0: micro-batch recall -> immediate canonical_company upsert (SUBJECT_BINDING_HOLD safe) ──
    currentStage = 'query';
    for (let i = 0; i < queries.length; i += queryBatchSize) {
      const batch = queries.slice(i, i + queryBatchSize);
      const settled = await Promise.allSettled(
        batch.map((query, offset) =>
          streamingActivities.executeQuery({
            ...authority,
            runId: input.runId,
            planId: input.planId,
            queryReceiptMode: DISCOVERY_QUERY_RECEIPT_MODE,
            queryOrdinal: i + offset,
            query,
          }),
        ),
      );
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          queriesCompleted += 1;
          rawCount += item.value.rawCount;
        } else {
          if (isCancellation(item.reason) || isExecutionControlError(item.reason)) {
            throw item.reason;
          }
          queriesFailed += 1;
        }
      }
    }

    currentStage = 'canonicalize';
    const canonicalized = await streamingActivities.canonicalizeRun({
      ...authority,
      runId: input.runId,
    });
    canonicalCount = canonicalized.companies;

    const l0Summary = await streamingActivities.recordStreamingL0Complete({
      ...authority,
      runId: input.runId,
      icpId: input.icpId,
      queriesTotal,
      queriesCompleted,
      candidatesRecalled: rawCount,
      canonicalUpserted: canonicalCount,
    });

    // ── Stage L1: per-company single-activity Raw HTTP-first extraction + unified fit-v3 ──
    currentStage = 'fit';
    for (let i = 0; i < l0Summary.companyIds.length; i += l1Concurrency) {
      const batch = l0Summary.companyIds.slice(i, i + l1Concurrency);
      const settled = await Promise.allSettled(
        batch.map((companyId) =>
          streamingActivities.processStreamingL1Company({
            ...authority,
            runId: input.runId,
            icpId: input.icpId,
            companyId,
          }),
        ),
      );
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          l1Results.push(item.value);
        } else {
          if (isCancellation(item.reason) || isExecutionControlError(item.reason)) {
            throw item.reason;
          }
          l1Failed += 1;
        }
      }
    }

    // ── Stage L2: Top-K bounded enrichment + website watch registration ──
    const topK = selectTopKStreamingCompanies(l1Results, topKCap);
    l2Selected = topK.length;
    currentStage = 'contacts';
    await streamingActivities.startStreamingL2Stage({
      ...authority,
      runId: input.runId,
      icpId: input.icpId,
      topKCap,
      selectedCount: topK.length,
    });

    for (let i = 0; i < topK.length; i += l2Concurrency) {
      const batch = topK.slice(i, i + l2Concurrency);
      const settled = await Promise.allSettled(
        batch.map((candidate) =>
          streamingActivities.enrichStreamingTopKCompany({
            ...authority,
            runId: input.runId,
            icpId: input.icpId,
            companyId: candidate.companyId,
          }),
        ),
      );
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          l2Enriched += 1;
          l2ContactsFound += item.value.contactsCreated;
        } else {
          if (isCancellation(item.reason) || isExecutionControlError(item.reason)) {
            throw item.reason;
          }
          l2Failed += 1;
        }
      }
    }

    if (topK.length > 0) {
      currentStage = 'watches';
      try {
        const watched = await streamingActivities.registerWatchesForRun({
          ...authority,
          runId: input.runId,
          icpId: input.icpId,
        });
        watchesRegistered = watched.registered;
      } catch (watchError) {
        if (isCancellation(watchError) || isExecutionControlError(watchError)) {
          throw watchError;
        }
      }
    }

    const status = resolveStreamingOutcome({
      l0QueriesFailed: queriesFailed,
      l1Total: l0Summary.companyIds.length,
      l1Processed: l1Results.length,
      l1Failed,
      l2Failed,
    });

    await CancellationScope.nonCancellable(async () => {
      await streamingActivities.finalizeStreamingRun({
        ...authority,
        runId: input.runId,
        planId: input.planId,
        icpId: input.icpId,
        status,
        summary: {
          queriesTotal,
          queriesCompleted,
          queriesFailed,
          rawCount,
          canonicalCount,
          l1Processed: l1Results.length,
          l1Failed,
          l2Selected: topK.length,
          l2Enriched,
          l2ContactsFound,
          l2Failed,
          watchesRegistered,
        },
      });
    });
  } catch (error) {
    const cancelled = isCancellation(error);
    const failure = cancelled ? undefined : describeDiscoveryRunFailure(currentStage, error);
    await CancellationScope.nonCancellable(async () => {
      await streamingActivities.finalizeStreamingRun({
        ...authority,
        runId: input.runId,
        planId: input.planId,
        icpId: input.icpId,
        status: cancelled ? 'CANCELLED' : 'FAILED',
        ...(failure ? { failure } : {}),
        summary: {
          queriesTotal,
          queriesCompleted,
          queriesFailed,
          rawCount,
          canonicalCount,
          l1Processed: l1Results.length,
          l1Failed,
          l2Selected,
          l2Enriched,
          l2ContactsFound,
          l2Failed,
          watchesRegistered,
        },
      });
    });
    if (!cancelled) throw error;
  }
}
