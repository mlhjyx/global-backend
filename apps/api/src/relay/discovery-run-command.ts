import type { PrismaClient } from "@prisma/client";
import { assertManufacturerNetworkAuthority } from "../discovery/manufacturer-network-authority";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { parseDiscoveryV3Dispatch } from "../runtime/discovery-v3-dispatch-contract";
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
