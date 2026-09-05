import type {
  NewApiSettlementReadbackProbe,
  NewApiSettlementReadbackProbePhase,
} from "./new-api-request-bound-settlement";

export const PROVIDER_TRANSPORT_FINAL_PHASES = [
  "gateway_unavailable",
  "gateway_request_id_observed",
  "upstream_ack_unknown",
  "payload_unavailable",
  "gateway_log_missing",
  "gateway_log_unavailable",
  "gateway_log_invalid",
  "database_ack_unknown",
] as const;

export type ProviderTransportFinalPhase =
  (typeof PROVIDER_TRANSPORT_FINAL_PHASES)[number];
export type ProviderGatewayIdState = "observed" | "missing" | "not_observable";
export type ProviderUpstreamIdState =
  "observed" | "absent" | "not_exposed" | "unknown";
export type ProviderPayloadState = "not_read" | "available" | "unavailable";

export interface SiteBuildProviderTransportObservation {
  schemaVersion: "site-build-provider-transport-observation/v1";
  physicalWireAttempt: 1 | 2;
  finalPhase: ProviderTransportFinalPhase;
  gatewayIdState: ProviderGatewayIdState;
  upstreamIdState: ProviderUpstreamIdState;
  payloadState: ProviderPayloadState;
  readbackProbes: readonly NewApiSettlementReadbackProbe[];
}

export type ModelSettlementErrorCode =
  | "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE"
  | "MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN"
  | "MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE"
  | "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING"
  | "MODEL_SETTLEMENT_GATEWAY_LOG_UNAVAILABLE"
  | "MODEL_SETTLEMENT_LOG_AMBIGUOUS"
  | "MODEL_SETTLEMENT_LOG_INVALID"
  | "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN";

const FINAL_PHASES = new Set<string>(PROVIDER_TRANSPORT_FINAL_PHASES);
const GATEWAY_STATES = new Set<string>([
  "observed",
  "missing",
  "not_observable",
]);
const UPSTREAM_STATES = new Set<string>([
  "observed",
  "absent",
  "not_exposed",
  "unknown",
]);
const PAYLOAD_STATES = new Set<string>([
  "not_read",
  "available",
  "unavailable",
]);
const PROBE_PHASES = new Set<NewApiSettlementReadbackProbePhase>([
  "gateway_log_observed",
  "gateway_log_pending",
  "gateway_log_missing",
  "gateway_log_unavailable",
  "gateway_log_invalid",
  "gateway_log_ambiguous",
]);

function invalid(): never {
  throw new Error("SITE_BUILD_PROVIDER_TRANSPORT_OBSERVATION_INVALID");
}

function snapshotProbe(
  value: NewApiSettlementReadbackProbe,
  previousSequence: 0 | 1 | 2,
): NewApiSettlementReadbackProbe {
  if (
    value === null ||
    typeof value !== "object" ||
    (value.sequence !== 1 && value.sequence !== 2) ||
    value.sequence <= previousSequence ||
    !PROBE_PHASES.has(value.phase) ||
    ![2, 4, 5, null].includes(value.httpStatusClass)
  ) {
    invalid();
  }
  return Object.freeze({
    sequence: value.sequence,
    phase: value.phase,
    httpStatusClass: value.httpStatusClass,
  });
}

export function createProviderTransportObservation(input: {
  physicalWireAttempt: number;
  finalPhase: ProviderTransportFinalPhase;
  gatewayIdState: ProviderGatewayIdState;
  upstreamIdState: ProviderUpstreamIdState;
  payloadState: ProviderPayloadState;
  readbackProbes: readonly NewApiSettlementReadbackProbe[];
}): SiteBuildProviderTransportObservation {
  if (
    !Number.isSafeInteger(input.physicalWireAttempt) ||
    (input.physicalWireAttempt !== 1 && input.physicalWireAttempt !== 2) ||
    !FINAL_PHASES.has(input.finalPhase) ||
    !GATEWAY_STATES.has(input.gatewayIdState) ||
    !UPSTREAM_STATES.has(input.upstreamIdState) ||
    !PAYLOAD_STATES.has(input.payloadState) ||
    !Array.isArray(input.readbackProbes) ||
    input.readbackProbes.length > 2
  ) {
    invalid();
  }
  let previousSequence: 0 | 1 | 2 = 0;
  const readbackProbes = Object.freeze(
    input.readbackProbes.map((probe) => {
      const snapshot = snapshotProbe(probe, previousSequence);
      previousSequence = snapshot.sequence;
      return snapshot;
    }),
  );
  return Object.freeze({
    schemaVersion: "site-build-provider-transport-observation/v1" as const,
    physicalWireAttempt: input.physicalWireAttempt,
    finalPhase: input.finalPhase,
    gatewayIdState: input.gatewayIdState,
    upstreamIdState: input.upstreamIdState,
    payloadState: input.payloadState,
    readbackProbes,
  });
}

export function modelSettlementErrorCode(
  observation: SiteBuildProviderTransportObservation,
  readbackReason?: string,
): ModelSettlementErrorCode {
  if (readbackReason === "log_ambiguous") {
    return "MODEL_SETTLEMENT_LOG_AMBIGUOUS";
  }
  switch (observation.finalPhase) {
    case "gateway_unavailable":
      return "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE";
    case "upstream_ack_unknown":
      return "MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN";
    case "payload_unavailable":
      return "MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE";
    case "gateway_log_missing":
      return "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING";
    case "gateway_log_unavailable":
    case "gateway_request_id_observed":
      return "MODEL_SETTLEMENT_GATEWAY_LOG_UNAVAILABLE";
    case "gateway_log_invalid":
      return "MODEL_SETTLEMENT_LOG_INVALID";
    case "database_ack_unknown":
      return "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN";
  }
}
