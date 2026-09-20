import { describe, expect, it, vi } from "vitest";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  type NewApiRequestBoundSettlement,
} from "../model-gateway/new-api-request-bound-settlement";
import {
  parseSettlementDerivationKeyring,
  settlementWireIdentities,
} from "../model-gateway/settlement-wire-identity";
import {
  NewApiSiteBuildCostReconciliationResolver,
  type SiteBuildReconciliationCandidate,
} from "./site-build-cost-reconciliation-resolver";

const OPERATION_KEY = "a".repeat(64);
const KEYRING = parseSettlementDerivationKeyring(
  Buffer.from(
    `schema=site-build-settlement-derivation-keyring/v1\n` +
      `settlement-test ACTIVE ${"A".repeat(43)}\n`,
  ),
);
const IDENTITY = settlementWireIdentities(KEYRING, OPERATION_KEY, 1)[0]!;

const CANDIDATE: SiteBuildReconciliationCandidate = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  buildRunId: "33333333-3333-4333-8333-333333333333",
  spendId: "44444444-4444-4444-8444-444444444444",
  wireAttemptId: "55555555-5555-4555-8555-555555555555",
  operationKey: OPERATION_KEY,
  physicalWireAttempt: 1,
  derivationKeyId: IDENTITY.derivationKeyId,
  settlementRequestId: IDENTITY.requestId,
  settlementNonceSha256: IDENTITY.nonceSha256,
  resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
  alias: "gpt-5.6-terra",
  protocol: "openai-responses",
  expectedChannelId: 72,
  actualMaxOutputTokens: 4_000,
  maximumQuotaPoints: 2_000_000,
  inputPriceMicrounitsPerMillionTokens: 2_000_000,
  outputPriceMicrounitsPerMillionTokens: 10_000_000,
  ledgerMicrousdPerPricingUnit: 1_000_000,
  wireState: "UNKNOWN",
  receiptRecorded: false,
  action: "RESOLVE",
};

function authority() {
  return {
    claimModelReadbackProbe: vi.fn(async () =>
      "66666666-6666-4666-8666-666666666666"
    ),
    recordModelReadbackProbe: vi.fn(async () => undefined),
    recordModelPhysicalWireReceipt: vi.fn(async () => undefined),
    finalizeModelPhysicalWire: vi.fn(async () => undefined),
    finalizeModelPhysicalWireFromReceipt: vi.fn(async () => undefined),
    completeProviderSpendReconciliation: vi.fn(async (input) => ({
      status: "RESOLVED" as const,
      resolverId: input.resolverId,
      receiptDigest: "f".repeat(64),
      costBasis: "token_pricing" as const,
      exactCostMicrousd: "540",
      inputTokens: 120,
      outputTokens: 30,
      observedAt: input.observedAt,
      meta: {
        schemaVersion: "site-build-provider-wire-reconciliation/v1",
        physicalWireCount: 1,
        resolvedWireCount: 1,
      },
    })),
  };
}

function settled(input: { requestId: string }): NewApiRequestBoundSettlement {
  return {
    status: "settled",
    requestId: input.requestId,
    resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    channelId: 72,
    quota: 1_250,
    inputTokens: 120,
    outputTokens: 30,
    upstreamIdState: "observed",
    receiptDigest: "e".repeat(64),
    physicalCallCount: 0,
    readbackProbes: [],
  };
}

describe("new v1 provider-wire reconciliation", () => {
  it("reconstructs the nonce, records one exact receipt, and returns aggregate spend truth", async () => {
    const readback = vi.fn(async (input) => settled(input));
    const wireAuthority = authority();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve: readback },
      KEYRING,
      wireAuthority,
    );

    const result = await resolver.resolve(CANDIDATE);

    expect(result).toMatchObject({
      status: "RESOLVED",
      receiptDigest: "f".repeat(64),
      exactCostMicrousd: "540",
    });
    expect(result).not.toHaveProperty("requestId");
    expect(readback).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: IDENTITY.requestId,
        nonce: IDENTITY.nonce,
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
      }),
    );
    expect(wireAuthority.recordModelPhysicalWireReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        wireAttemptId: CANDIDATE.wireAttemptId,
        receiptDigest: "e".repeat(64),
        observation: expect.objectContaining({
          status: "settled",
          costMicrousd: 540,
        }),
      }),
    );
  });

  it("closes a send-cut ACK gap from exact readback without claiming the lost payload", async () => {
    const readback = vi.fn(async (input) => settled(input));
    const wireAuthority = authority();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve: readback },
      KEYRING,
      wireAuthority,
    );

    await resolver.resolve({
      ...CANDIDATE,
      wireState: "DISPATCH_STARTED",
    });

    expect(
      wireAuthority.finalizeModelPhysicalWireFromReceipt,
    ).toHaveBeenCalledWith({
      workspaceId: CANDIDATE.workspaceId,
      wireAttemptId: CANDIDATE.wireAttemptId,
    });
    expect(
      wireAuthority.completeProviderSpendReconciliation,
    ).toHaveBeenCalledOnce();
  });

  it("uses an already-recorded receipt to recover a reserved Spend without another readback GET", async () => {
    const readback = vi.fn();
    const wireAuthority = authority();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve: readback },
      KEYRING,
      wireAuthority,
    );

    await expect(
      resolver.resolve({
        ...CANDIDATE,
        wireState: "OBSERVED",
        receiptRecorded: true,
      }),
    ).resolves.toMatchObject({ status: "RESOLVED" });

    expect(readback).not.toHaveBeenCalled();
    expect(
      wireAuthority.recordModelPhysicalWireReceipt,
    ).not.toHaveBeenCalled();
    expect(
      wireAuthority.completeProviderSpendReconciliation,
    ).toHaveBeenCalledOnce();
  });

  it("finalizes a dispatched wire UNKNOWN before recording an unresolved readback", async () => {
    const wireAuthority = authority();
    wireAuthority.completeProviderSpendReconciliation.mockResolvedValueOnce({
      status: "UNRESOLVED",
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      observedAt: new Date(),
      meta: { reason: "provider_wire_receipts_incomplete" },
    });
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      {
        resolve: vi.fn(async (input) => ({
          status: "unknown" as const,
          requestId: input.requestId,
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
          reason: "gateway_log_missing" as const,
          physicalCallCount: 0 as const,
          readbackProbes: [],
        })),
      },
      KEYRING,
      wireAuthority,
    );

    await expect(
      resolver.resolve({
        ...CANDIDATE,
        wireState: "DISPATCH_STARTED",
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "gateway_log_missing" },
    });
    expect(wireAuthority.finalizeModelPhysicalWire).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          status: "unknown",
          transportObservation: expect.objectContaining({
            finalPhase: "gateway_log_missing",
            payloadState: "unavailable",
          }),
        }),
      }),
    );
    expect(
      wireAuthority.completeProviderSpendReconciliation,
    ).toHaveBeenCalledOnce();
  });

  it("does not query readback when the immutable recovery context is invalid", async () => {
    const readback = vi.fn();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve: readback },
      KEYRING,
      authority(),
    );

    await expect(
      resolver.resolve({
        ...CANDIDATE,
        settlementNonceSha256: "0".repeat(64),
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "settlement_nonce_unavailable" },
    });
    expect(readback).not.toHaveBeenCalled();
  });

  it("never performs readback for a wire that has not crossed the send cut", async () => {
    const readback = vi.fn();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve: readback },
      KEYRING,
      authority(),
    );

    await expect(
      resolver.resolve({
        ...CANDIDATE,
        wireState: "ALLOCATED",
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "provider_wire_not_dispatched" },
    });
    expect(readback).not.toHaveBeenCalled();
  });

  it("keeps an unavailable exact receipt unresolved and persists no raw request id", async () => {
    const wireAuthority = authority();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      {
        resolve: vi.fn(async (input) => ({
          status: "unknown" as const,
          requestId: input.requestId,
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
          reason: "gateway_log_unavailable" as const,
          physicalCallCount: 0 as const,
          readbackProbes: [],
        })),
      },
      KEYRING,
      wireAuthority,
    );

    const result = await resolver.resolve(CANDIDATE);

    expect(result).toEqual(
      expect.objectContaining({
        status: "UNRESOLVED",
        meta: {
          reason: "gateway_log_unavailable",
          readbackProbes: [],
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain(IDENTITY.requestId);
    expect(
      wireAuthority.recordModelPhysicalWireReceipt,
    ).not.toHaveBeenCalled();
  });
});
