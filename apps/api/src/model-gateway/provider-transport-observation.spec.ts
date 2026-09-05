import { describe, expect, it } from "vitest";
import {
  createProviderTransportObservation,
  modelSettlementErrorCode,
} from "./provider-transport-observation";

describe("provider transport observation", () => {
  it("creates a closed, immutable, redacted physical-wire fact", () => {
    const observation = createProviderTransportObservation({
      physicalWireAttempt: 1,
      finalPhase: "gateway_log_unavailable",
      gatewayIdState: "observed",
      upstreamIdState: "unknown",
      payloadState: "available",
      readbackProbes: [
        {
          sequence: 1,
          phase: "gateway_log_pending",
          httpStatusClass: 2,
        },
        {
          sequence: 2,
          phase: "gateway_log_unavailable",
          httpStatusClass: 5,
        },
      ],
    });

    expect(observation).toEqual({
      schemaVersion: "site-build-provider-transport-observation/v1",
      physicalWireAttempt: 1,
      finalPhase: "gateway_log_unavailable",
      gatewayIdState: "observed",
      upstreamIdState: "unknown",
      payloadState: "available",
      readbackProbes: [
        {
          sequence: 1,
          phase: "gateway_log_pending",
          httpStatusClass: 2,
        },
        {
          sequence: 2,
          phase: "gateway_log_unavailable",
          httpStatusClass: 5,
        },
      ],
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.readbackProbes)).toBe(true);
    expect(Object.isFrozen(observation.readbackProbes[0])).toBe(true);
    expect(JSON.stringify(observation)).not.toMatch(
      /requestId|nonce|credential|response|prompt|cause|error/iu,
    );
  });

  it.each([
    ["gateway_unavailable", "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE"],
    ["upstream_ack_unknown", "MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN"],
    ["payload_unavailable", "MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE"],
    ["gateway_log_missing", "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING"],
    ["gateway_log_unavailable", "MODEL_SETTLEMENT_GATEWAY_LOG_UNAVAILABLE"],
    ["gateway_log_invalid", "MODEL_SETTLEMENT_LOG_INVALID"],
    ["database_ack_unknown", "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN"],
  ] as const)("maps %s to stable error %s", (finalPhase, expected) => {
    const observation = createProviderTransportObservation({
      physicalWireAttempt: 1,
      finalPhase,
      gatewayIdState: "not_observable",
      upstreamIdState: "unknown",
      payloadState: "not_read",
      readbackProbes: [],
    });

    expect(modelSettlementErrorCode(observation)).toBe(expected);
  });

  it("uses the explicit ambiguity code without changing the closed final phase", () => {
    const observation = createProviderTransportObservation({
      physicalWireAttempt: 1,
      finalPhase: "gateway_log_invalid",
      gatewayIdState: "observed",
      upstreamIdState: "unknown",
      payloadState: "available",
      readbackProbes: [
        {
          sequence: 1,
          phase: "gateway_log_ambiguous",
          httpStatusClass: 4,
        },
      ],
    });

    expect(modelSettlementErrorCode(observation, "log_ambiguous")).toBe(
      "MODEL_SETTLEMENT_LOG_AMBIGUOUS",
    );
  });

  it("accepts a lone second probe when a prior process already consumed sequence one", () => {
    expect(
      createProviderTransportObservation({
        physicalWireAttempt: 1,
        finalPhase: "gateway_request_id_observed",
        gatewayIdState: "not_observable",
        upstreamIdState: "observed",
        payloadState: "unavailable",
        readbackProbes: [
          { sequence: 2, phase: "gateway_log_observed", httpStatusClass: 2 },
        ],
      }).readbackProbes,
    ).toEqual([
      { sequence: 2, phase: "gateway_log_observed", httpStatusClass: 2 },
    ]);
  });

  it.each([
    ["wire zero", { physicalWireAttempt: 0 }],
    ["wire overflow", { physicalWireAttempt: 3 }],
    [
      "three probes",
      {
        readbackProbes: [
          { sequence: 1, phase: "gateway_log_pending", httpStatusClass: 2 },
          { sequence: 2, phase: "gateway_log_pending", httpStatusClass: 2 },
          { sequence: 2, phase: "gateway_log_pending", httpStatusClass: 2 },
        ],
      },
    ],
    [
      "descending probe order",
      {
        readbackProbes: [
          { sequence: 2, phase: "gateway_log_pending", httpStatusClass: 2 },
          { sequence: 1, phase: "gateway_log_pending", httpStatusClass: 2 },
        ],
      },
    ],
    ["unknown phase", { finalPhase: "other" }],
    ["unknown state", { gatewayIdState: "secret-id" }],
  ])("rejects %s", (_case, override) => {
    expect(() =>
      createProviderTransportObservation({
        physicalWireAttempt: 1,
        finalPhase: "gateway_log_unavailable",
        gatewayIdState: "missing",
        upstreamIdState: "unknown",
        payloadState: "not_read",
        readbackProbes: [],
        ...override,
      } as never),
    ).toThrow("SITE_BUILD_PROVIDER_TRANSPORT_OBSERVATION_INVALID");
  });
});
