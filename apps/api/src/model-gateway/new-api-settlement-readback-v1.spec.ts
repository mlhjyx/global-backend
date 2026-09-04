import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  NEW_API_SETTLEMENT_READBACK_CONTRACT,
  NewApiRequestBoundSettlementResolver,
} from "./new-api-request-bound-settlement";

const GATEWAY_ORIGIN = "http://127.0.0.1:3001";
const REQUEST_ID = "A".repeat(43);
const NONCE = "B".repeat(43);
const CHANNEL_ID = 72;
const READER_CREDENTIAL = `srb1.${"C".repeat(16)}.${"D".repeat(43)}`;

function exactReceipt(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    type: "consume",
    model_name: "gpt-5.6-terra",
    channel_id: CHANNEL_ID,
    quota: "1250",
    prompt_tokens: 120,
    completion_tokens: 30,
    usage_semantic: "openai",
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    upstream_id_state: "observed",
    ...overrides,
  };
}

function exactResponse(
  body: string | Record<string, unknown>,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-new-api-settlement-contract": NEW_API_SETTLEMENT_READBACK_CONTRACT,
      ...init.headers,
    },
  });
}

function resolver(fetchImpl: typeof fetch) {
  return new NewApiRequestBoundSettlementResolver(
    {
      gatewayOrigin: GATEWAY_ORIGIN,
      readerCredential: READER_CREDENTIAL,
      resolverId: "new-api-request-bound-reconciliation-v1",
      maximumProbeDurationMs: 250,
    },
    {
      fetch: fetchImpl,
      wait: async () => undefined,
    },
  );
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    nonce: NONCE,
    alias: "gpt-5.6-terra",
    protocol: "openai-responses" as const,
    expectedChannelId: CHANNEL_ID,
    usage: { inputTokens: 120, outputTokens: 30 },
    maxOutputTokens: 4_000,
    maximumQuotaPoints: 2_000,
    ...overrides,
  };
}

describe("New API exact settlement readback v1", () => {
  it("reads one request-bound receipt with the dedicated reader and nonce", async () => {
    const fetchMock = vi.fn(async () =>
      exactResponse({ data: [exactReceipt()] }),
    );

    const result = await resolver(fetchMock as typeof fetch).resolve(input());

    expect(result).toMatchObject({
      status: "settled",
      requestId: REQUEST_ID,
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      channelId: CHANNEL_ID,
      quota: 1_250,
      inputTokens: 120,
      outputTokens: 30,
      upstreamIdState: "observed",
      readbackProbes: [
        {
          sequence: 1,
          phase: "gateway_log_observed",
          httpStatusClass: 2,
        },
      ],
    });
    expect(result).not.toHaveProperty("nonce");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}/api/settlement-readback/v1?request_id=${REQUEST_ID}`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${READER_CREDENTIAL}`,
          "X-New-API-Settlement-Nonce": NONCE,
        },
      }),
    );
  });

  it("performs no more than two read-only probes and never increments a physical call", async () => {
    const fetchMock = vi.fn(async () => exactResponse({ data: [] }));

    const result = await resolver(fetchMock as typeof fetch).resolve(input());

    expect(result).toMatchObject({
      status: "unknown",
      reason: "gateway_log_missing",
      physicalCallCount: 0,
      readbackProbes: [
        { sequence: 1, phase: "gateway_log_pending", httpStatusClass: 2 },
        { sequence: 2, phase: "gateway_log_pending", httpStatusClass: 2 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies bounded network and 5xx failures without exposing causes", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret network detail"))
      .mockResolvedValueOnce(exactResponse("", { status: 503 }));

    const result = await resolver(fetchMock as typeof fetch).resolve(input());

    expect(result).toEqual({
      status: "unknown",
      requestId: REQUEST_ID,
      resolverId: "new-api-request-bound-reconciliation-v1",
      reason: "gateway_log_unavailable",
      physicalCallCount: 0,
      readbackProbes: [
        {
          sequence: 1,
          phase: "gateway_log_unavailable",
          httpStatusClass: null,
        },
        {
          sequence: 2,
          phase: "gateway_log_unavailable",
          httpStatusClass: 5,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret network detail");
  });

  it.each([
    ["contract header", { "x-new-api-settlement-contract": "wrong/v1" }],
    ["content type", { "content-type": "text/plain" }],
    ["cache policy", { "cache-control": "public" }],
  ])(
    "rejects a drifted %s before trusting the body",
    async (_case, headers) => {
      const fetchMock = vi.fn(async () =>
        exactResponse({ data: [exactReceipt()] }, { headers }),
      );

      await expect(
        resolver(fetchMock as typeof fetch).resolve(input()),
      ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["extra top-level key", '{"data":[],"meta":{}}'],
    ["duplicate top-level key", '{"data":[],"data":[]}'],
    [
      "duplicate receipt key",
      `{"data":[{"request_id":"${REQUEST_ID}","request_id":"${REQUEST_ID}"}]}`,
    ],
    ["alternate wrapper", '{"success":true,"data":[]}'],
  ])("rejects %s in the closed JSON contract", async (_case, body) => {
    const fetchMock = vi.fn(async () => exactResponse(body));

    await expect(
      resolver(fetchMock as typeof fetch).resolve(input()),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
  });

  it("rejects invalid UTF-8 and bodies larger than 16 KiB", async () => {
    const invalidUtf8 = vi.fn(
      async () =>
        new Response(Uint8Array.from([0xc3, 0x28]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-new-api-settlement-contract":
              NEW_API_SETTLEMENT_READBACK_CONTRACT,
          },
        }),
    );
    const oversized = vi.fn(async () =>
      exactResponse(`{"data":[],"padding":"${"x".repeat(16 * 1024)}"}`),
    );

    await expect(
      resolver(invalidUtf8 as typeof fetch).resolve(input()),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
    await expect(
      resolver(oversized as typeof fetch).resolve(input()),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
  });

  it.each([
    ["request id mismatch", { request_id: "Z".repeat(43) }],
    ["unknown receipt key", { debug: "forbidden" }],
    ["quota exponent", { quota: "1e3" }],
    ["unsafe prompt tokens", { prompt_tokens: 9_007_199_254_740_992 }],
    ["usage semantic drift", { usage_semantic: "other" }],
    ["upstream state drift", { upstream_id_state: "unknown" }],
  ])("fails closed for %s", async (_case, overrides) => {
    const fetchMock = vi.fn(async () =>
      exactResponse({ data: [exactReceipt(overrides)] }),
    );

    await expect(
      resolver(fetchMock as typeof fetch).resolve(input()),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
  });

  it("does not access the gateway without both exact opaque values", async () => {
    const fetchMock = vi.fn();
    const client = resolver(fetchMock as typeof fetch);

    await expect(
      client.resolve(input({ requestId: null })),
    ).resolves.toMatchObject({ reason: "request_id_missing" });
    await expect(client.resolve(input({ nonce: null }))).resolves.toMatchObject(
      { reason: "nonce_missing" },
    );
    await expect(
      client.resolve(input({ requestId: "short", nonce: "also-short" })),
    ).resolves.toMatchObject({ reason: "request_id_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the exact zero-generation capability surface", async () => {
    const fetchMock = vi.fn(async () =>
      exactResponse({
        schema_version: "new-api-settlement-readback-capability/v1",
        status: "ready",
      }),
    );

    await expect(
      resolver(fetchMock as typeof fetch).checkCapability(),
    ).resolves.toEqual({
      ready: true,
      resolverId: "new-api-request-bound-reconciliation-v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_ORIGIN}/api/settlement-readback/v1/capability`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${READER_CREDENTIAL}`,
        },
      }),
    );
  });

  it("contains no legacy broad-log fallback", () => {
    const source = readFileSync(
      new URL("./new-api-request-bound-settlement.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("/api/log/token");
    expect(source).not.toContain("MODEL_GATEWAY_KEY");
  });

  it("keeps receipt digests deterministic and free of credentials", async () => {
    const fetchMock = vi.fn(async () =>
      exactResponse({ data: [exactReceipt()] }),
    );
    const first = await resolver(fetchMock as typeof fetch).resolve(input());
    const second = await resolver(fetchMock as typeof fetch).resolve(input());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(READER_CREDENTIAL);
    expect(JSON.stringify(first)).not.toContain(NONCE);
  });
});
