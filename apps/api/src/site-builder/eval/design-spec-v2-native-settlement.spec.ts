import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDesignSpecV2NativeRequestIdCapturingFetch,
  createDesignSpecV2NativeSettlementResolver,
} from "./design-spec-v2-native-settlement";
import {
  createNativeModelEvaluationCostSafetyAttestation,
  nativeModelEvaluationPricingFeeCardSha256,
  type NativeModelEvaluationCostSafetyInput,
} from "./model-evaluation-native-cost-safety";

const EXECUTION_ID = "design-spec-native-execution-0001";
const REQUEST_ID = "req_12345678";

function attestation() {
  const input: NativeModelEvaluationCostSafetyInput = {
    contractId:
      "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2",
    authorization: {
      authorizationId: "design-spec-native-authorization-20260803",
      ledgerId: "design-spec-native-ledger",
      ledgerDirectorySha256: "a".repeat(64),
      approvedAt: "2026-08-03T08:00:00.000Z",
      approvedMaximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      approvedDispatchExecutions: 73,
      approvedWireCalls: 146,
      preparedFixedCommitSha: "b".repeat(40),
      preparedManifestSha256: "c".repeat(64),
      preparedFeeCardSha256: "d".repeat(64),
      preparedSuiteId:
        "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
      preparedSourceBundleContractId:
        "design-spec-evaluation-source-bundle/v15",
      preparedSourceBundleSha256: "e".repeat(64),
    },
    credential: {
      attestationId: "design-spec-native-credential-20260803",
      observedAt: "2026-08-03T08:00:00.000Z",
      snapshotSha256: "f".repeat(64),
      bearerTokenSha256: createHash("sha256")
        .update("limited-evaluation-token")
        .digest("hex"),
      gatewayOrigin: "http://127.0.0.1:3001",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      allowedDispatches: [
        {
          mode: "target",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
        },
      ],
      gatewaySettlement: {
        purposeGroup: "design-spec-eval",
        tokenLogPath: "/api/log/token",
        routes: routes(),
      },
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: "2026-08-03T08:00:00.000Z",
      catalogResponseSha256: "2".repeat(64),
      noForeignExchangeConversion: true,
      entries: [
        {
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 2_000_000,
          outputRateMicrounitsPerMillionTokens: 12_000_000,
        },
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 5_000_000,
          outputRateMicrounitsPerMillionTokens: 30_000_000,
        },
        {
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
          inputRateMicrounitsPerMillionTokens: 2_520_000,
          outputRateMicrounitsPerMillionTokens: 12_600_000,
        },
      ],
    },
    limits: {
      maximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      maxInitialPromptUtf8Bytes: 2342,
      maxRepairPromptUtf8Bytes: 6649,
      maxInputTokensInitialWire: 6438,
      maxInputTokensRepairWire: 10745,
      maxOutputTokensPerWire: 4000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
  };
  input.authorization.preparedFeeCardSha256 =
    nativeModelEvaluationPricingFeeCardSha256(input.pricing);
  return createNativeModelEvaluationCostSafetyAttestation(input);
}

function routes() {
  return [
    {
      alias: "gpt-5.6-terra",
      protocol: "openai-responses" as const,
      channelId: 11,
    },
    {
      alias: "gpt-5.5",
      protocol: "openai-responses" as const,
      channelId: 12,
    },
    {
      alias: "claude-sonnet-5",
      protocol: "anthropic-messages" as const,
      channelId: 13,
    },
  ];
}

async function captureRequestIds(
  trustedAttestation: ReturnType<typeof attestation>,
  records: readonly {
    requestId: string;
    alias: "gpt-5.6-terra" | "gpt-5.5" | "claude-sonnet-5";
    protocol: "openai-responses" | "anthropic-messages";
  }[],
) {
  const responseRecords = [...records];
  const upstream = vi.fn(async () => {
    const record = responseRecords.shift();
    return new Response('{"ok":true}', {
      headers: record ? { "x-oneapi-request-id": record.requestId } : {},
    });
  });
  const capture = createDesignSpecV2NativeRequestIdCapturingFetch({
    attestation: trustedAttestation,
    gatewayOrigin: "http://127.0.0.1:3001",
    bearerToken: "limited-evaluation-token",
    fetch: upstream as typeof fetch,
  });
  for (const record of records) {
    await capture.fetch(
      `http://127.0.0.1:3001${
        record.protocol === "openai-responses" ? "/v1/responses" : "/v1/messages"
      }`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer limited-evaluation-token",
          "x-site-builder-evaluation-execution-id": EXECUTION_ID,
        },
        body: JSON.stringify({ model: record.alias }),
      },
    );
  }
  return capture;
}

async function resolver(
  fetchImpl: typeof fetch,
  records = [
    {
      requestId: REQUEST_ID,
      alias: "gpt-5.5" as const,
      protocol: "openai-responses" as const,
    },
  ],
) {
  const trustedAttestation = attestation();
  return createDesignSpecV2NativeSettlementResolver({
    attestation: trustedAttestation,
    bearerToken: "limited-evaluation-token",
    requestIdCapture: await captureRequestIds(trustedAttestation, records),
    fetch: fetchImpl,
    attempts: 1,
  });
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    executionId: EXECUTION_ID,
    alias: "gpt-5.5",
    protocol: "openai-responses" as const,
    wires: [
      {
        wireAttempt: "initial" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ],
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    type: 2,
    model_name: "gpt-5.5",
    channel: 12,
    group: "design-spec-eval",
    quota: 1000,
    prompt_tokens: 100,
    completion_tokens: 50,
    ...overrides,
  };
}

describe("design_spec v2 native settlement", () => {
  it("captures an exact request id without consuming the model response", async () => {
    const upstream = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: { "x-oneapi-request-id": REQUEST_ID },
        }),
    );
    const captured = createDesignSpecV2NativeRequestIdCapturingFetch({
      attestation: attestation(),
      gatewayOrigin: "http://127.0.0.1:3001",
      bearerToken: "limited-evaluation-token",
      fetch: upstream as typeof fetch,
    });

    const response = await captured.fetch(
      "http://127.0.0.1:3001/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: "Bearer limited-evaluation-token",
          "x-site-builder-evaluation-execution-id": EXECUTION_ID,
        },
        body: JSON.stringify({ model: "gpt-5.5" }),
      },
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(Object.keys(captured)).toEqual(["fetch"]);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("settles a matching token-log row in CNY pico-units without FX", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [row()] }), {
          status: 200,
        }),
    );

    await expect(
      (await resolver(fetchImpl as typeof fetch)).resolve(context()),
    ).resolves.toEqual({
      state: "settled",
      executionId: EXECUTION_ID,
      currency: "CNY",
      nativePicoUnits: "2000000000",
      basis: "frozen_openox_native_pricing@2026-08-03T08:00:00.000Z",
    });
  });

  it("captures credential, origin, and receipt lookup dependencies at construction", async () => {
    const trustedAttestation = attestation();
    const captureOptions = {
      attestation: trustedAttestation,
      gatewayOrigin: "http://127.0.0.1:3001",
      bearerToken: "limited-evaluation-token",
      fetch: vi.fn(
        async () =>
          new Response('{"ok":true}', {
            headers: { "x-oneapi-request-id": REQUEST_ID },
          }),
      ) as typeof fetch,
    };
    const capture = createDesignSpecV2NativeRequestIdCapturingFetch(
      captureOptions,
    );
    captureOptions.gatewayOrigin = "http://127.0.0.1:3999";
    captureOptions.bearerToken = "wrong-token";
    await capture.fetch("http://127.0.0.1:3001/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer limited-evaluation-token",
        "x-site-builder-evaluation-execution-id": EXECUTION_ID,
      },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });

    const receiptFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [row()] }), {
          status: 200,
        }),
    ) as typeof fetch;
    const options = {
      attestation: trustedAttestation,
      bearerToken: "limited-evaluation-token",
      requestIdCapture: capture,
      fetch: receiptFetch,
      attempts: 1,
    };
    const locked = createDesignSpecV2NativeSettlementResolver(options);
    options.bearerToken = "wrong-token";
    options.fetch = vi.fn() as typeof fetch;

    await expect(locked.resolve(context())).resolves.toMatchObject({
      state: "settled",
      currency: "CNY",
    });
    expect(receiptFetch).toHaveBeenCalledOnce();
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("requires one exact row per physical wire and aggregates a repair", async () => {
    const repairRequestId = "req_repair123";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              row(),
              row({
                request_id: repairRequestId,
                prompt_tokens: 25,
                completion_tokens: 10,
              }),
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      (await resolver(
        fetchImpl as typeof fetch,
        [
          {
            requestId: REQUEST_ID,
            alias: "gpt-5.5",
            protocol: "openai-responses",
          },
          {
            requestId: repairRequestId,
            alias: "gpt-5.5",
            protocol: "openai-responses",
          },
        ],
      )).resolve(
        context({
          wires: [
            {
              wireAttempt: "initial",
              usage: { inputTokens: 100, outputTokens: 50 },
            },
            {
              wireAttempt: "repair",
              usage: { inputTokens: 25, outputTokens: 10 },
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      state: "settled",
      executionId: EXECUTION_ID,
      currency: "CNY",
      nativePicoUnits: "2425000000",
      basis: "frozen_openox_native_pricing@2026-08-03T08:00:00.000Z",
    });
  });

  it.each([
    ["wrong model", { model_name: "gpt-5.6-terra" }],
    ["wrong channel", { channel: 99 }],
    ["wrong purpose group", { group: "default" }],
    ["wrong usage", { prompt_tokens: 99 }],
    ["missing quota", { quota: undefined }],
  ])("fails closed for %s", async (_label, changed) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [row(changed)] }), {
          status: 200,
        }),
    );

    await expect(
      (await resolver(fetchImpl as typeof fetch)).resolve(context()),
    ).resolves.toEqual({ state: "unknown", reason: "invalid_settlement" });
  });

  it("rejects forged captures, missing ids, duplicate ids, and token drift before log reads", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const trustedAttestation = attestation();
    expect(() =>
      createDesignSpecV2NativeSettlementResolver({
        attestation: trustedAttestation,
        bearerToken: "limited-evaluation-token",
        requestIdCapture: { fetch: fetchImpl },
        fetch: fetchImpl,
      }),
    ).toThrow("trusted native evaluation request-id capture is required");
    const capture = await captureRequestIds(trustedAttestation, []);
    expect(() =>
      createDesignSpecV2NativeSettlementResolver({
        attestation: trustedAttestation,
        bearerToken: "wrong-token",
        requestIdCapture: capture,
        fetch: fetchImpl,
      }),
    ).toThrow("native evaluation credential does not match attestation");

    const missing = (await resolver(fetchImpl, [])).resolve(context());
    await expect(missing).resolves.toEqual({
      state: "unknown",
      reason: "invalid_settlement",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      (await resolver(
        fetchImpl,
        [
          {
            requestId: REQUEST_ID,
            alias: "gpt-5.5",
            protocol: "openai-responses",
          },
          {
            requestId: REQUEST_ID,
            alias: "gpt-5.5",
            protocol: "openai-responses",
          },
        ],
      )).resolve(
        context({ wires: [context().wires[0], context().wires[0]!] }),
      ),
    ).resolves.toEqual({ state: "unknown", reason: "invalid_settlement" });
  });
});
