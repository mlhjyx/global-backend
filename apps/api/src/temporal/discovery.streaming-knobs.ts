/**
 * Replay-safe knobs for `discoveryStreamingWorkflow` (same discipline as `discovery.workflow-knobs.ts`).
 *
 * Kept out of `*.workflow.ts` so module-level defaults cannot drift across in-flight workflow replays.
 * Relay injects explicit values at workflow start; replay reads recorded input values verbatim.
 */

export const STREAMING_L1_CONCURRENCY_DEFAULT = 4;
export const STREAMING_TOP_K_CAP_DEFAULT = 20;
export const STREAMING_QUERY_BATCH_SIZE_DEFAULT = 2;
export const STREAMING_L2_CONCURRENCY_DEFAULT = 2;

export interface StreamingWorkflowKnobsInput {
  readonly streamingL1Concurrency?: number;
  readonly streamingTopKCap?: number;
  readonly streamingQueryBatchSize?: number;
  readonly streamingL2Concurrency?: number;
}

export interface StreamingWorkflowKnobs {
  readonly l1Concurrency: number;
  readonly topKCap: number;
  readonly queryBatchSize: number;
  readonly l2Concurrency: number;
}

function recordedPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  if (truncated < 1) return fallback;
  return Math.min(truncated, max);
}

export function resolveStreamingWorkflowKnobs(
  input: StreamingWorkflowKnobsInput,
): StreamingWorkflowKnobs {
  return {
    l1Concurrency: recordedPositiveInt(input.streamingL1Concurrency, STREAMING_L1_CONCURRENCY_DEFAULT, 8),
    topKCap: recordedPositiveInt(input.streamingTopKCap, STREAMING_TOP_K_CAP_DEFAULT, 50),
    queryBatchSize: recordedPositiveInt(input.streamingQueryBatchSize, STREAMING_QUERY_BATCH_SIZE_DEFAULT, 4),
    l2Concurrency: recordedPositiveInt(input.streamingL2Concurrency, STREAMING_L2_CONCURRENCY_DEFAULT, 4),
  };
}
