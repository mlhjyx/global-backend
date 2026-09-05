import { describe, expect, it, vi } from "vitest";
import { createProviderTransportObservation } from "../model-gateway/provider-transport-observation";
import type { GatewaySettlementObservation } from "../model-gateway/paid-model-settlement";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
  SiteBuildCostLedger,
  type PaidModelWireReservationContext,
  type PaidOperationReservation,
} from "./site-build-cost-ledger";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const BUILD_RUN_ID = "33333333-3333-4333-8333-333333333333";
const SPEND_ID = "44444444-4444-4444-8444-444444444444";
const WIRE_ID = "55555555-5555-4555-8555-555555555555";
const PROBE_ID = "66666666-6666-4666-8666-666666666666";

const scope: PaidOperationReservation = {
  workspaceId: WORKSPACE_ID,
  siteId: SITE_ID,
  buildRunId: BUILD_RUN_ID,
  operationKey: "a".repeat(64),
  kind: "model",
  taskId: "site_builder.copy",
  subject: "gpt-5.6-terra@gateway",
  reservationMicrousd: 800_000,
};

const wire: PaidModelWireReservationContext = {
  wireIdentity: {
    schemaVersion: "site-build-settlement-wire-identity/v1",
    physicalWireAttempt: 1,
    derivationKeyId: "settlement-test",
    requestId: "R".repeat(43),
    nonce: "N".repeat(43),
    nonceSha256: "b".repeat(64),
  },
  protocol: "openai-responses",
  requestedAlias: "gpt-5.6-terra",
  expectedChannelId: 72,
  promptUtf8Bytes: 100,
  maximumWireCalls: 2,
  actualMaxOutputTokens: 1_000,
  catalogMaxOutputTokens: 4_000,
  maximumQuotaPoints: 2_000,
  catalogId: "catalog-v1",
  catalogSha256: "c".repeat(64),
  pricingSnapshotSha256: "d".repeat(64),
  inputPriceMicrounitsPerMillionTokens: 2_000_000,
  outputPriceMicrounitsPerMillionTokens: 10_000_000,
  ledgerMicrousdPerPricingUnit: 1_000_000,
};

function databaseWithResponses(...responses: unknown[]) {
  const queue = [...responses];
  const queryRaw = vi.fn(async () => {
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  const transaction = { $queryRaw: queryRaw };
  const database = {
    withWorkspace: vi.fn(async (_workspaceId, operation) =>
      operation(transaction),
    ),
  };
  return { database, queryRaw };
}

function ledgerWithResponses(...responses: unknown[]) {
  const harness = databaseWithResponses(...responses);
  return {
    ...harness,
    ledger: new SiteBuildCostLedger({} as never, {
      providerWireDatabase: harness.database as never,
    }),
  };
}

function settledObservation(): Extract<
  GatewaySettlementObservation,
  { status: "settled" }
> {
  return {
    status: "settled",
    physicalWireAttempt: 1,
    resolverId: "new-api-request-bound-reconciliation-v1",
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    channelId: 72,
    basis: "openox_catalog_token_pricing",
    quota: 1_250,
    costMicrousd: 2_500,
    inputTokens: 100,
    outputTokens: 20,
    upstreamIdState: "observed",
    transportObservation: createProviderTransportObservation({
      physicalWireAttempt: 1,
      finalPhase: "gateway_request_id_observed",
      gatewayIdState: "observed",
      upstreamIdState: "observed",
      payloadState: "available",
      readbackProbes: [],
    }),
  };
}

describe("provider-wire ledger database boundary", () => {
  it("persists zero-call RELEASED measurements with a NULL call_count", async () => {
    const { ledger, queryRaw } = ledgerWithResponses([{ decision: "SETTLED" }]);
    await expect(
      ledger.settleOperation({
        scope,
        status: "RELEASED",
        measurement: {
          basis: "not_incurred",
          budgetChargeMicrousd: 0,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: null,
          estimatedCostMicrousd: null,
          inputTokens: null,
          outputTokens: null,
          callCount: 0,
          meta: { reason: "provider_pre_dispatch_unavailable" },
        },
        errorCode: "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE",
      }),
    ).resolves.toBe("SETTLED");
    expect(queryRaw.mock.calls[0]?.[13]).toBeNull();
  });

  it("fails closed without the dedicated provider-wire database", async () => {
    const ledger = new SiteBuildCostLedger({} as never);
    await expect(
      ledger.reserveModelOperation({ ...scope, kind: "model", wire }),
    ).rejects.toMatchObject({
      decision: "MODEL_WIRE_DATABASE_UNAVAILABLE",
    });
  });

  it("validates model reserve decisions and replays only pre-send attempt one", async () => {
    const invalidKey = ledgerWithResponses([]).ledger.reserveModelOperation({
      ...scope,
      operationKey: "not-a-hash",
      kind: "model",
      wire,
    });
    await expect(invalidKey).rejects.toThrow(
      "paid operation key must be a lowercase SHA-256",
    );

    await expect(
      ledgerWithResponses([]).ledger.reserveModelOperation({
        ...scope,
        kind: "model",
        wire,
      }),
    ).rejects.toMatchObject({ decision: "EMPTY_MODEL_RESERVE_RESULT" });

    await expect(
      ledgerWithResponses([
        {
          decision: "EXECUTE",
          spend_id: SPEND_ID,
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 1,
        },
      ]).ledger.reserveModelOperation({ ...scope, kind: "model", wire }),
    ).resolves.toEqual({
      kind: "execute",
      spendId: SPEND_ID,
      wireAttemptId: WIRE_ID,
      physicalWireAttempt: 1,
    });

    await expect(
      ledgerWithResponses([
        {
          decision: "EXECUTE",
          spend_id: null,
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 1,
        },
      ]).ledger.reserveModelOperation({ ...scope, kind: "model", wire }),
    ).rejects.toMatchObject({
      decision: "MODEL_WIRE_RESERVE_RESULT_INVALID",
    });

    await expect(
      ledgerWithResponses([
        {
          decision: "REPLAY",
          spend_id: SPEND_ID,
          spend_status: "SUCCEEDED",
          cached_result: { ok: true },
          cached_meta: { basis: "exact" },
          cached_error_code: null,
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 1,
          wire_state: "OBSERVED",
        },
      ]).ledger.reserveModelOperation({ ...scope, kind: "model", wire }),
    ).resolves.toEqual({
      kind: "replay",
      status: "SUCCEEDED",
      result: { ok: true },
      meta: { basis: "exact" },
      errorCode: null,
    });
  });

  it.each([
    ["REPLAY", "RESERVED", null, "MODEL_WIRE_ALREADY_ALLOCATED"],
    ["REPLAY", "UNKNOWN", "recorded-unknown", "recorded-unknown"],
    ["LEGACY_MODEL_SPEND", null, null, "LEGACY_MODEL_SPEND"],
    ["UNKNOWN", null, "ack-unknown", "ack-unknown"],
  ])(
    "contains non-dispatchable reserve result %s/%s as UNKNOWN",
    async (decision, spendStatus, errorCode, expectedCode) => {
      const attempt = ledgerWithResponses([
        {
          decision,
          spend_id: SPEND_ID,
          spend_status: spendStatus,
          cached_result: null,
          cached_meta: null,
          cached_error_code: errorCode,
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 1,
          wire_state: "DISPATCH_STARTED",
        },
      ]).ledger.reserveModelOperation({ ...scope, kind: "model", wire });

      await expect(attempt).rejects.toBeInstanceOf(PaidOperationUnknownError);
      await expect(attempt).rejects.toMatchObject({ errorCode: expectedCode });
    },
  );

  it("rejects unrecognized reserve decisions", async () => {
    await expect(
      ledgerWithResponses([
        { decision: "DENIED_CAP", cached_error_code: null },
      ]).ledger.reserveModelOperation({ ...scope, kind: "model", wire }),
    ).rejects.toBeInstanceOf(PaidCallDeniedError);
  });

  it("retries an allocation ACK once and accepts only attempt-two ALLOCATED", async () => {
    const { ledger, queryRaw } = ledgerWithResponses(
      new Error("ack lost"),
      [
        {
          decision: "REPLAY",
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 2,
          wire_state: "ALLOCATED",
        },
      ],
    );
    await expect(
      ledger.allocateModelPhysicalWire({
        scope,
        spendId: SPEND_ID,
        wireIdentity: { ...wire.wireIdentity, physicalWireAttempt: 2 },
      }),
    ).resolves.toMatchObject({
      spendId: SPEND_ID,
      wireAttemptId: WIRE_ID,
      physicalWireAttempt: 2,
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);

    await expect(
      ledgerWithResponses([
        {
          decision: "EXECUTE",
          wire_attempt_id: WIRE_ID,
          physical_wire_attempt: 1,
          wire_state: "ALLOCATED",
        },
      ]).ledger.allocateModelPhysicalWire({
        scope,
        spendId: SPEND_ID,
        wireIdentity: { ...wire.wireIdentity, physicalWireAttempt: 2 },
      }),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
  });

  it.each(["DISPATCH", "READBACK_ONLY"] as const)(
    "returns the durable send-cut decision %s",
    async (decision) => {
      await expect(
        ledgerWithResponses([{ decision }]).ledger.beginModelPhysicalWire({
          workspaceId: WORKSPACE_ID,
          wireAttemptId: WIRE_ID,
        }),
      ).resolves.toBe(decision);
    },
  );

  it("fails closed on a missing send-cut decision", async () => {
    await expect(
      ledgerWithResponses([]).ledger.beginModelPhysicalWire({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
      }),
    ).rejects.toMatchObject({
      decision: "MODEL_WIRE_SEND_CUT_UNAVAILABLE",
    });
  });

  it("claims only a durable readback probe", async () => {
    await expect(
      ledgerWithResponses([
        { decision: "CLAIMED", probe_id: PROBE_ID },
      ]).ledger.claimModelReadbackProbe({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
        sequence: 1,
      }),
    ).resolves.toBe(PROBE_ID);
    await expect(
      ledgerWithResponses([
        { decision: "REPLAY", probe_id: PROBE_ID },
      ]).ledger.claimModelReadbackProbe({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
        sequence: 2,
      }),
    ).resolves.toBeNull();
  });

  it("retries probe persistence once and rejects an unknown ACK", async () => {
    const probe = {
      sequence: 1 as const,
      phase: "gateway_log_observed" as const,
      httpStatusClass: 2 as const,
    };
    const { ledger, queryRaw } = ledgerWithResponses(
      new Error("ack lost"),
      [{ decision: "REPLAY" }],
    );
    await expect(
      ledger.recordModelReadbackProbe({
        workspaceId: WORKSPACE_ID,
        probeId: PROBE_ID,
        probe,
        observedAt: new Date("2026-09-04T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(2);

    await expect(
      ledgerWithResponses([{ decision: "DENIED" }]).ledger.recordModelReadbackProbe(
        {
          workspaceId: WORKSPACE_ID,
          probeId: PROBE_ID,
          probe,
          observedAt: new Date("2026-09-04T00:00:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: "MODEL_READBACK_PROBE_ACK_UNKNOWN",
    });
  });

  it("persists both exact and UNKNOWN terminal wire observations", async () => {
    await expect(
      ledgerWithResponses([{ decision: "FINALIZED" }]).ledger.finalizeModelPhysicalWire(
        {
          workspaceId: WORKSPACE_ID,
          wireAttemptId: WIRE_ID,
          observation: settledObservation(),
          observedAt: new Date("2026-09-04T00:00:00.000Z"),
        },
      ),
    ).resolves.toBeUndefined();

    await expect(
      ledgerWithResponses([{ decision: "REPLAY" }]).ledger.finalizeModelPhysicalWire(
        {
          workspaceId: WORKSPACE_ID,
          wireAttemptId: WIRE_ID,
          observation: {
            status: "unknown",
            physicalWireAttempt: 1,
            resolverId: "new-api-request-bound-reconciliation-v1",
            reason: "gateway_log_missing",
            transportObservation: createProviderTransportObservation({
              physicalWireAttempt: 1,
              finalPhase: "gateway_log_missing",
              gatewayIdState: "not_observable",
              upstreamIdState: "unknown",
              payloadState: "unavailable",
              readbackProbes: [],
            }),
          },
          observedAt: new Date("2026-09-04T00:00:00.000Z"),
        },
      ),
    ).resolves.toBeUndefined();

    await expect(
      ledgerWithResponses([{ decision: "DENIED" }]).ledger.finalizeModelPhysicalWire(
        {
          workspaceId: WORKSPACE_ID,
          wireAttemptId: WIRE_ID,
          observation: settledObservation(),
          observedAt: new Date("2026-09-04T00:00:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: "MODEL_WIRE_OBSERVATION_ACK_UNKNOWN",
    });
  });

  it("persists exact receipts with bounded ACK recovery", async () => {
    const { ledger, queryRaw } = ledgerWithResponses(
      new Error("ack lost"),
      [{ decision: "RECORDED" }],
    );
    await expect(
      ledger.recordModelPhysicalWireReceipt({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
        observation: settledObservation(),
        receiptDigest: "e".repeat(64),
        observedAt: new Date("2026-09-04T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(2);

    await expect(
      ledgerWithResponses([{ decision: "DENIED" }]).ledger.recordModelPhysicalWireReceipt(
        {
          workspaceId: WORKSPACE_ID,
          wireAttemptId: WIRE_ID,
          observation: settledObservation(),
          receiptDigest: "e".repeat(64),
          observedAt: new Date("2026-09-04T00:00:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: "MODEL_WIRE_RECEIPT_ACK_UNKNOWN",
    });
  });

  it.each([
    ["finalizeModelPhysicalWireFromReceipt", "MODEL_WIRE_OBSERVATION_ACK_UNKNOWN"],
    ["finalizeModelPhysicalWireNotDispatched", "MODEL_WIRE_NOT_DISPATCHED_ACK_UNKNOWN"],
  ] as const)("bounds ACK recovery for %s", async (method, errorCode) => {
    const successful = ledgerWithResponses(
      new Error("ack lost"),
      [{ decision: "REPLAY" }],
    );
    await expect(
      successful.ledger[method]({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
      }),
    ).resolves.toBeUndefined();
    expect(successful.queryRaw).toHaveBeenCalledTimes(2);

    await expect(
      ledgerWithResponses([{ decision: "DENIED" }]).ledger[method]({
        workspaceId: WORKSPACE_ID,
        wireAttemptId: WIRE_ID,
      }),
    ).rejects.toMatchObject({ errorCode });
  });
});
