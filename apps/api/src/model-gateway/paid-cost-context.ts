import type {
  PaidModelPhysicalWireRuntime,
  PaidModelPreflightEvidence,
} from "./paid-model-settlement";
import type { SettlementWireIdentity } from "./settlement-wire-identity";

/** Stable logical namespace threaded through ModelGateway and ToolBroker. */
export interface PaidCostContext {
  siteId: string;
  scopeKey: string;
  taskAttemptId?: string;
  fenceToken?: string;
  /** Installed by RouterModelGateway only after the paid preflight succeeds. */
  settlementPreflight?: PaidModelPreflightEvidence;
  /** Preallocated before reserve; plaintext nonces remain transient. */
  settlementWireIdentities?: readonly SettlementWireIdentity[];
  /** Exactly one identity selected by the caller for the next physical send. */
  settlementPhysicalWire?: PaidModelPhysicalWireRuntime;
  /** Allocates attempt 2 only after attempt 1 was durably finalized exact. */
  allocateSettlementRepairWire?: () => Promise<PaidModelPhysicalWireRuntime>;
  /**
   * Explicit domain persistence gate for model replay. The gateway never
   * stores a raw provider result when this projection is absent.
   */
  durableReplayResult?: (
    result: Record<string, unknown>,
  ) => Record<string, unknown>;
}
