/**
 * Pure contract constants and types for opt-in `new-api` request-bound
 * settlement readback.
 *
 * Kept free of any HTTP/probe implementation so standard model gateway,
 * readiness, and worker startup paths do not eagerly load
 * `new-api-request-bound-settlement.ts` when settlement readback is disabled
 * or unconfigured.
 */

export const NEW_API_SETTLEMENT_READBACK_CONTRACT =
  "new-api-settlement-readback/v1" as const;
export const NEW_API_SETTLEMENT_READBACK_CAPABILITY_SCHEMA =
  "new-api-settlement-readback-capability/v1" as const;

/** One exact identity is shared by provider observations and reconciliation. */
export const NEW_API_REQUEST_BOUND_RESOLVER_ID =
  "new-api-request-bound-reconciliation-v1";

export interface NewApiRequestBoundSettlementResolverSettings {
  gatewayOrigin: string;
  readerCredential: string;
  resolverId: typeof NEW_API_REQUEST_BOUND_RESOLVER_ID;
  maximumProbeDurationMs: number;
}

export type NewApiSettlementReadbackProbePhase =
  | "gateway_log_observed"
  | "gateway_log_pending"
  | "gateway_log_missing"
  | "gateway_log_unavailable"
  | "gateway_log_invalid"
  | "gateway_log_ambiguous";

export interface NewApiSettlementReadbackProbe {
  sequence: 1 | 2;
  phase: NewApiSettlementReadbackProbePhase;
  httpStatusClass: 2 | 4 | 5 | null;
}

interface NewApiRequestBoundSettlementRequest {
  requestId: string | null;
  nonce: string | null;
  alias: string;
  protocol: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  maxOutputTokens: number;
  maximumQuotaPoints: number;
  maximumProbeCount: 1 | 2;
  probeAuthority: {
    claim(sequence: 1 | 2): Promise<string | null>;
    record(input: {
      probeId: string;
      probe: NewApiSettlementReadbackProbe;
      observedAt: Date;
      receipt?: NewApiRequestBoundSettlementReceipt;
    }): Promise<void>;
  };
  signal?: AbortSignal;
}

export type NewApiRequestBoundSettlementInput = NewApiRequestBoundSettlementRequest & (
  | { profile?: never; expectedChannelId: number }
  | { profile: "discovery-v3"; expectedChannelId?: never }
);

/** A trusted gateway reader may supply a monetary charge for this consume row. */
export interface NewApiReportedMonetaryCharge {
  currency: string;
  amountMicros: number;
}

export type NewApiRequestBoundSettlementUnknownReason =
  | "request_id_missing"
  | "nonce_missing"
  | "gateway_log_missing"
  | "gateway_log_unavailable"
  | "log_ambiguous"
  | "log_invalid"
  | "model_mismatch"
  | "channel_mismatch";

interface SettlementBase {
  requestId: string | null;
  resolverId: typeof NEW_API_REQUEST_BOUND_RESOLVER_ID;
  physicalCallCount: 0;
  readbackProbes: readonly NewApiSettlementReadbackProbe[];
}

export interface NewApiRequestBoundSettlementReceipt extends SettlementBase {
  status: "settled";
  requestId: string;
  alias: string;
  protocol: string;
  channelId: number;
  quota: number;
  inputTokens: number;
  outputTokens: number;
  upstreamIdState: "observed" | "absent";
  receiptDigest: string;
  actualCharge?: NewApiReportedMonetaryCharge;
}

export type NewApiRequestBoundSettlement =
  | NewApiRequestBoundSettlementReceipt
  | (SettlementBase & {
      status: "unknown";
      reason: NewApiRequestBoundSettlementUnknownReason;
    });

export type NewApiSettlementReadbackCapability =
  | {
      ready: true;
      resolverId: typeof NEW_API_REQUEST_BOUND_RESOLVER_ID;
    }
  | {
      ready: false;
      resolverId: typeof NEW_API_REQUEST_BOUND_RESOLVER_ID;
      reason: "gateway_unavailable" | "contract_invalid";
    };

export interface NewApiRequestBoundSettlementResolverPort {
  checkCapability(input?: {
    signal?: AbortSignal;
  }): Promise<NewApiSettlementReadbackCapability>;
  resolve(
    input: NewApiRequestBoundSettlementInput,
  ): Promise<NewApiRequestBoundSettlement>;
}
