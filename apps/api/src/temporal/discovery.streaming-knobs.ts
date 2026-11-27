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

/**
 * Relay 在启动时写入的满血值（非重放契约，只影响新 run）。上面的 *_DEFAULT 是旧历史缺字段时的
 * 冻结回退值，永远不要改；新 run 由 relay 显式写入下面的值，重放只读录制值。
 */
export const STREAMING_RELAY_KNOB_DEFAULTS = Object.freeze({
  streamingL1Concurrency: 8,
  streamingTopKCap: 50,
  streamingL2Concurrency: 4,
});

/** Relay 注入时的合法区间，与 resolveStreamingWorkflowKnobs 的录制上界一致。 */
export const STREAMING_RELAY_KNOB_BOUNDS = Object.freeze({
  streamingL1Concurrency: Object.freeze({ min: 1, max: 8 }),
  streamingTopKCap: Object.freeze({ min: 1, max: 50 }),
  streamingL2Concurrency: Object.freeze({ min: 1, max: 4 }),
});

/** Relay 注入用的 env 名（部署侧调参入口）。 */
export const STREAMING_WORKFLOW_KNOB_ENV = Object.freeze({
  streamingL1Concurrency: 'DISCOVERY_STREAMING_L1_CONCURRENCY',
  streamingTopKCap: 'DISCOVERY_STREAMING_TOP_K_CAP',
  streamingL2Concurrency: 'DISCOVERY_STREAMING_L2_CONCURRENCY',
});

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
