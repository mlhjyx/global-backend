import type { PrismaClient } from "@prisma/client";
import { assertManufacturerNetworkAuthority } from "../discovery/manufacturer-network-authority";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { parseDiscoveryV3Dispatch } from "../runtime/discovery-v3-dispatch-contract";
import {
  DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS,
  DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
  DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS,
  DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
  DISCOVERY_QUERY_BATCH_SIZE_BOUNDS,
  DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
  DISCOVERY_WORKFLOW_KNOB_ENV,
  boundedKnob,
  type WorkflowKnobBounds,
} from "../temporal/discovery.workflow-knobs";
import {
  STREAMING_RELAY_KNOB_BOUNDS,
  STREAMING_RELAY_KNOB_DEFAULTS,
  STREAMING_WORKFLOW_KNOB_ENV,
} from "../temporal/discovery.streaming-knobs";
import {
  DISCOVERY_STREAMING_WORKFLOW,
  DISCOVERY_WORKFLOW,
} from "../temporal/understanding.constants";

/** Plan B rollout switch: DISCOVERY_STREAMING_WORKFLOW=on routes new runs to discoveryStreamingWorkflow. */
export function resolveDiscoveryWorkflowType(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return /^(1|true|on|yes)$/i.test(env.DISCOVERY_STREAMING_WORKFLOW ?? "")
    ? DISCOVERY_STREAMING_WORKFLOW
    : DISCOVERY_WORKFLOW;
}

/**
 * B1（L01）：把参与工作流控制流的可调常量显式写进启动输入（随 run 记录进历史）。
 * 流式专属旋钮仅在启动 discoveryStreamingWorkflow 时注入，保持旧 discoveryWorkflow 契约不变。
 */
export function resolveDiscoveryStartKnobs(
  workflowType: string,
  warn: (msg: string) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, number> {
  const read = (envName: string, fallback: number, bounds: WorkflowKnobBounds): number => {
    const raw = env[envName];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      warn(`${envName}='${raw}' is not an integer — using frozen default ${fallback}`);
      return fallback;
    }
    const clamped = boundedKnob(parsed, fallback, bounds);
    if (clamped !== parsed) {
      warn(`${envName}=${parsed} is outside [${bounds.min}, ${bounds.max}] — using ${clamped}`);
    }
    return clamped;
  };
  const base = {
    run2PoolSearchFallbackThreshold: read(
      DISCOVERY_WORKFLOW_KNOB_ENV.run2PoolSearchFallbackThreshold,
      DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
      DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS,
    ),
    deepCompanyConcurrency: read(
      DISCOVERY_WORKFLOW_KNOB_ENV.deepCompanyConcurrency,
      DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
      DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS,
    ),
    discoveryQueryBatchSize: read(
      DISCOVERY_WORKFLOW_KNOB_ENV.discoveryQueryBatchSize,
      DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
      DISCOVERY_QUERY_BATCH_SIZE_BOUNDS,
    ),
  };
  if (workflowType !== DISCOVERY_STREAMING_WORKFLOW) return base;
  return {
    ...base,
    streamingL1Concurrency: read(
      STREAMING_WORKFLOW_KNOB_ENV.streamingL1Concurrency,
      STREAMING_RELAY_KNOB_DEFAULTS.streamingL1Concurrency,
      STREAMING_RELAY_KNOB_BOUNDS.streamingL1Concurrency,
    ),
    streamingTopKCap: read(
      STREAMING_WORKFLOW_KNOB_ENV.streamingTopKCap,
      STREAMING_RELAY_KNOB_DEFAULTS.streamingTopKCap,
      STREAMING_RELAY_KNOB_BOUNDS.streamingTopKCap,
    ),
    streamingL2Concurrency: read(
      STREAMING_WORKFLOW_KNOB_ENV.streamingL2Concurrency,
      STREAMING_RELAY_KNOB_DEFAULTS.streamingL2Concurrency,
      STREAMING_RELAY_KNOB_BOUNDS.streamingL2Concurrency,
    ),
  };
}

export class NonRetryableOutboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableOutboxCommandError";
  }
}

/** Keep invalid snapshots on the existing parked-command path before any Workflow start. */
export function discoveryManufacturerCommandArguments(
  value: unknown,
  budget: ExecutionBudgetBinding,
  planId: string | undefined,
) {
  try {
    const snapshot = assertManufacturerNetworkAuthority(value, budget, planId);
    return snapshot ? { manufacturerNetworkExecution: snapshot } : {};
  } catch {
    throw new NonRetryableOutboxCommandError(
      "EXECUTION_BUDGET_OUTBOX_COMMAND_PARKED",
    );
  }
}

/** Bind the immutable v3 command to an admitted event before starting its Workflow. */
export async function attestDiscoveryV3OutboxCommand(
  requireDb: () => Pick<PrismaClient, "$queryRaw">,
  event: { payload: unknown; eventId: string; workspaceId: string; aggregateId: string },
): Promise<ReturnType<typeof parseDiscoveryV3Dispatch>> {
  let command: ReturnType<typeof parseDiscoveryV3Dispatch>;
  try {
    command = parseDiscoveryV3Dispatch(event.payload);
  } catch {
    throw new NonRetryableOutboxCommandError("DISCOVERY_V3_INVALID_COMMAND");
  }
  if (command.workspaceId !== event.workspaceId || command.runId !== event.aggregateId) {
    throw new NonRetryableOutboxCommandError("DISCOVERY_V3_OUTBOX_BINDING_MISMATCH");
  }
  const [proof] = await requireDb().$queryRaw<Array<{ admitted: boolean }>>`
    SELECT public.attest_discovery_v3_outbox(${event.eventId}::uuid) AS admitted
  `;
  if (!proof?.admitted) {
    throw new NonRetryableOutboxCommandError("DISCOVERY_V3_OUTBOX_BINDING_MISMATCH");
  }
  return command;
}
