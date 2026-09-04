import { describe, expect, it, vi } from "vitest";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  NEW_API_SETTLEMENT_READBACK_CONTRACT,
  NewApiRequestBoundSettlementResolver,
} from "./new-api-request-bound-settlement";

const REQUEST_ID = "R".repeat(43);
const NONCE = "N".repeat(43);
const CREDENTIAL = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-new-api-settlement-contract": NEW_API_SETTLEMENT_READBACK_CONTRACT,
    },
  });
}

function client(fetchImpl: typeof fetch, maximumResponseBytes = 16 * 1024) {
  return new NewApiRequestBoundSettlementResolver(
    {
      gatewayOrigin: "http://127.0.0.1:3001",
      readerCredential: CREDENTIAL,
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      maximumProbeDurationMs: 250,
    },
    {
      fetch: fetchImpl,
      wait: async () => undefined,
      maximumResponseBytes,
    },
  );
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    type: "consume",
    model_name: "claude-sonnet-5",
    channel_id: 19,
    quota: "69900",
    prompt_tokens: 77,
    completion_tokens: 7,
    usage_semantic: "anthropic",
    cache_creation_tokens: 1_424,
    cache_read_tokens: 0,
    upstream_id_state: "absent",
    ...overrides,
  };
}

function anthropicInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    nonce: NONCE,
    alias: "claude-sonnet-5",
    protocol: "anthropic-messages",
    expectedChannelId: 19,
    usage: { inputTokens: 1_501, outputTokens: 7 },
    maxOutputTokens: 1_200,
    maximumQuotaPoints: 500_000,
    ...overrides,
  };
}

describe("NewApiRequestBoundSettlementResolver receipt validation", () => {
  it("includes Anthropic cache creation and read tokens exactly once", async () => {
    const fetchMock = vi.fn(async () =>
      response([
        receipt({
          prompt_tokens: 10,
          cache_creation_tokens: 1_000,
          cache_read_tokens: 491,
        }),
      ]),
    );

    await expect(
      client(fetchMock as typeof fetch).resolve(anthropicInput()),
    ).resolves.toMatchObject({
      status: "settled",
      inputTokens: 1_501,
      outputTokens: 7,
      upstreamIdState: "absent",
    });
  });

  it("accepts all-cache Anthropic input but rejects an empty total", async () => {
    const allCache = vi.fn(async () =>
      response([
        receipt({
          prompt_tokens: 0,
          cache_creation_tokens: 1_501,
        }),
      ]),
    );
    const empty = vi.fn(async () =>
      response([
        receipt({
          prompt_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        }),
      ]),
    );

    await expect(
      client(allCache as typeof fetch).resolve(anthropicInput()),
    ).resolves.toMatchObject({ status: "settled", inputTokens: 1_501 });
    await expect(
      client(empty as typeof fetch).resolve(
        anthropicInput({ usage: { inputTokens: 0, outputTokens: 7 } }),
      ),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
  });

  it.each([
    ["model", { model_name: "different-model" }, "model_mismatch"],
    ["channel", { channel_id: 20 }, "channel_mismatch"],
    ["semantic", { usage_semantic: "openai" }, "log_invalid"],
    ["quota cap", { quota: "500001" }, "log_invalid"],
    ["output cap", { completion_tokens: 1201 }, "log_invalid"],
    ["negative cache", { cache_read_tokens: -1 }, "log_invalid"],
  ])("rejects a %s mismatch", async (_case, overrides, reason) => {
    const fetchMock = vi.fn(async () => response([receipt(overrides)]));

    await expect(
      client(fetchMock as typeof fetch).resolve(anthropicInput()),
    ).resolves.toMatchObject({ status: "unknown", reason });
  });

  it("bounds the raw response before JSON parsing", async () => {
    const fetchMock = vi.fn(async () => response([receipt()]));

    await expect(
      client(fetchMock as typeof fetch, 32).resolve(anthropicInput()),
    ).resolves.toMatchObject({ status: "unknown", reason: "log_invalid" });
  });

  it("rejects legacy dispatch credentials and non-loopback HTTP origins", () => {
    expect(
      () =>
        new NewApiRequestBoundSettlementResolver({
          gatewayOrigin: "http://127.0.0.1:3001",
          readerCredential: "sk-dispatch-token",
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
          maximumProbeDurationMs: 250,
        }),
    ).toThrow("NEW_API_SETTLEMENT_RESOLVER_INVALID");
    expect(
      () =>
        new NewApiRequestBoundSettlementResolver({
          gatewayOrigin: "http://gateway.example.test",
          readerCredential: CREDENTIAL,
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
          maximumProbeDurationMs: 250,
        }),
    ).toThrow("NEW_API_SETTLEMENT_GATEWAY_ORIGIN_INVALID");
  });
});
