import type { ToolContext } from "../tools/tool-contract";
import { paidOperationKey } from "../site-builder/site-build-cost-ledger";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { snapshotPlatformEgressOperation, type PlatformEgressOperation } from "./platform-egress-operation";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1, type PlatformExecutionTechnicalRowV1 } from "./platform-execution-contract";

/**
 * Splits one already-reserved operation into its sequential physical transports.
 * These counters bound this invocation only: durable budget replay admission and
 * the per-child database CAS remain the authority across processes/restarts.
 */
export function createPlatformToolWireDispatcher(
  operation: PlatformEgressOperation,
  dispatcher: NonNullable<ToolContext["platformEgress"]>,
): NonNullable<ToolContext["dispatchPhysicalWire"]> {
  const parent = snapshotPlatformEgressOperation(operation);
  const execution = parent.execution;
  if (execution.kind !== "tool") throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  const rows: readonly PlatformExecutionTechnicalRowV1[] = PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows;
  const matches = rows.filter(row => row.costMode !== "disabled_no_egress"
    && row.toolContracts.some(tool => tool.toolId === execution.toolId && tool.version === execution.toolVersion));
  if (matches.length !== 1) throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  const row = matches[0];
  // Multi-provider acquisition rows select one source tool; single-tool rows
  // include all declared transports (for example robots plus renderer dispatch).
  const contracts = row.physicalWireContracts.filter(wire => row.toolContracts.length === 1
    || wire.wireId === execution.toolId || wire.wireId.startsWith(`${execution.toolId}.`));
  if (!contracts.length) throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  const counts = new Map<string, number>();
  let inFlight = false;
  let closed = false;
  return async (wireId, execute) => {
    if (closed || inFlight) {
      closed = true;
      throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_CLOSED");
    }
    const contract = contracts.find(wire => wire.wireId === wireId);
    const ordinal = (counts.get(wireId) ?? 0) + 1;
    if (!contract || ordinal > Number(contract.maximumWiresPerOperation)) {
      closed = true;
      throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_INVALID");
    }
    counts.set(wireId, ordinal);
    inFlight = true;
    try {
      const child = snapshotPlatformEgressOperation({ ...parent,
        operationKey: paidOperationKey([parent.operationKey, "physical-wire/v1", wireId, String(ordinal)]) });
      return await dispatcher.authorizeAndDispatch(child, execute);
    } catch (error) {
      closed = true;
      if (error instanceof ExecutionControlError) throw error;
      // A transport/ACK failure must not look like a retryable provider error
      // outside the tool, nor disclose the raw response or transport exception.
      throw new ExecutionControlError("PLATFORM_EGRESS_PHYSICAL_WIRE_FAILED");
    } finally {
      inFlight = false;
    }
  };
}
