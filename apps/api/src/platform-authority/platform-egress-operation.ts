import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { BudgetReservation } from "../tools/budget-store";

export type PlatformEgressExecution =
  | Readonly<{ kind: "tool"; toolId: string; toolVersion: string }>
  | Readonly<{ kind: "model"; modelOp: "generateText" | "generateStructured" | "reviewVision" | "embed";
      taskId: string; providerId: string; requestedModel?: string }>;

/** Internal binding to an existing reservation, not a new budget or wire authorization. */
export interface PlatformEgressOperation {
  readonly operationKey: string;
  readonly budgetOperationId: string;
  readonly budgetOperationKey: string;
  readonly reservedMicrousd: bigint;
  readonly execution: PlatformEgressExecution;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX = 9_223_372_036_854_775_807n;
function invalid(): never { throw new ExecutionControlError("PLATFORM_EGRESS_RESERVATION_INVALID"); }
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value.trim() === value && !/\p{Cc}/u.test(value);
}
function amount(value: unknown): value is bigint { return typeof value === "bigint" && value >= 0n && value <= MAX; }

export function assertPlatformEgressPaidContext(context: { workspaceId: string; platformEgress?: unknown; paidCost?: unknown }): void {
  if ((context.workspaceId === "platform" || context.platformEgress !== undefined) && context.paidCost !== undefined) {
    throw new ExecutionControlError("PLATFORM_EGRESS_PAID_CONTEXT_INVALID");
  }
}

export function assertPlatformEgressReservation(
  reservation: BudgetReservation | undefined, workspaceId: string, accountKey: string,
): asserts reservation is BudgetReservation {
  if (!reservation || reservation.workspaceId !== workspaceId || reservation.accountKey !== accountKey
    || typeof reservation.operationId !== "string" || !UUID.test(reservation.operationId)
    || !amount(reservation.estimatedMicrousd) || typeof reservation.replay !== "boolean") invalid();
}

export function snapshotPlatformEgressOperation(operation: PlatformEgressOperation): PlatformEgressOperation {
  if (!operation || typeof operation.operationKey !== "string" || !KEY.test(operation.operationKey)
    || typeof operation.budgetOperationId !== "string" || !UUID.test(operation.budgetOperationId)
    || typeof operation.budgetOperationKey !== "string" || !SHA256.test(operation.budgetOperationKey)
    || !amount(operation.reservedMicrousd)) invalid();
  const execution = operation.execution;
  if (!execution || (execution.kind !== "tool" && execution.kind !== "model")) invalid();
  if (execution.kind === "tool") {
    if (!identifier(execution.toolId) || !identifier(execution.toolVersion)) invalid();
  } else if (!["generateText", "generateStructured", "reviewVision", "embed"].includes(execution.modelOp)
    || !identifier(execution.taskId) || !identifier(execution.providerId)
    || (execution.requestedModel !== undefined && !identifier(execution.requestedModel))) invalid();
  return Object.freeze({ operationKey: operation.operationKey, budgetOperationId: operation.budgetOperationId,
    budgetOperationKey: operation.budgetOperationKey, reservedMicrousd: operation.reservedMicrousd,
    execution: Object.freeze({ ...execution }) });
}

export function createPlatformEgressOperation(input: {
  operationKey: string; budgetOperationKey: string; reservation: BudgetReservation | undefined;
  workspaceId: string; accountKey: string; execution: PlatformEgressExecution;
}): PlatformEgressOperation {
  assertPlatformEgressReservation(input.reservation, input.workspaceId, input.accountKey);
  if (input.reservation.replay) invalid();
  return snapshotPlatformEgressOperation({ operationKey: input.operationKey,
    budgetOperationId: input.reservation.operationId, budgetOperationKey: input.budgetOperationKey,
    reservedMicrousd: input.reservation.estimatedMicrousd, execution: input.execution });
}
