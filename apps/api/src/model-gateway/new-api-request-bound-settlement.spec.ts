import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NewApiRequestBoundSettlementResolver } from "./new-api-request-bound-settlement";

const GATEWAY_ORIGIN = "http://127.0.0.1:3001";
const REQUEST_ID = "req-copy-terra-001";
const CHANNEL_ID = 72;
const FIXTURE_CREDENTIAL = createHash("sha256")
  .update(import.meta.url)
  .digest("hex");

function logRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    type: 2,
    model_name: "gpt-5.6-terra",
    channel: CHANNEL_ID,
    quota: 1_250,
    prompt_tokens: 120,
    completion_tokens: 30,
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function resolver(
  fetchImpl: typeof fetch,
  input: { maximumResponseBytes?: number } = {},
) {
  return new NewApiRequestBoundSettlementResolver(
    {
      gatewayOrigin: GATEWAY_ORIGIN,
      apiKey: FIXTURE_CREDENTIAL,
      resolverId: "copy-new-api-request-bound-v1",
      maximumPollDurationMs: 250,
    },
    {
      fetch: fetchImpl,
      wait: async () => undefined,
      maximumResponseBytes: input.maximumResponseBytes ?? 4_096,
    },
  );
}

function resolveInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    alias: "gpt-5.6-terra",
    protocol: "openai-responses" as const,
    expectedChannelId: CHANNEL_ID,
    usage: { inputTokens: 120, outputTokens: 30 },
    maxOutputTokens: 4_000,
    maximumQuotaPoints: 2_000,
    ...overrides,
  };
}

describe("NewApiRequestBoundSettlementResolver", () => {
  it("settles exactly one request-bound row and emits a deterministic receipt digest", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [logRow()] }));
    const settlement = resolver(fetchMock as typeof fetch);

    const first = await settlement.resolve(resolveInput());
    const second = await settlement.resolve(resolveInput());

    expect(first).toMatchObject({
      status: "settled",
      requestId: REQUEST_ID,
      resolverId: "copy-new-api-request-bound-v1",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      channelId: CHANNEL_ID,
      quota: 1_250,
      inputTokens: 120,
      outputTokens: 30,
    });
    if (first.status !== "settled") {
      throw new Error("expected a settled request-bound receipt");
    }
    expect(first.receiptDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as unknown as readonly [
      RequestInfo | URL,
      RequestInit?,
    ][]) {
      expect(String(url).startsWith(`${GATEWAY_ORIGIN}/`)).toBe(true);
      expect((init as RequestInit | undefined)?.headers).not.toEqual(
        expect.objectContaining({
          Authorization: expect.stringContaining("undefined"),
        }),
      );
    }
  });

  it("does not query the gateway when the request id is absent", async () => {
    const fetchMock = vi.fn();
    const settlement = resolver(fetchMock as typeof fetch);

    await expect(
      settlement.resolve(resolveInput({ requestId: null })),
    ).resolves.toMatchObject({
      status: "unknown",
      requestId: null,
      reason: "request_id_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unknown when the consume log contains duplicate request ids", async () => {
    const settlement = resolver(
      vi.fn(async () =>
        jsonResponse({ data: [logRow(), logRow({ quota: 1_251 })] }),
      ) as typeof fetch,
    );

    await expect(settlement.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
      requestId: REQUEST_ID,
      reason: "log_ambiguous",
    });
  });

  it.each([
    ["alias", { model_name: "gpt-5.6-sol" }],
    ["channel", { channel: CHANNEL_ID + 1 }],
    ["input usage", { prompt_tokens: 121 }],
    ["output usage", { completion_tokens: 31 }],
    ["quota", { quota: -1 }],
    ["quota cap", { quota: 2_001 }],
  ] as const)(
    "returns unknown for a request-bound %s mismatch",
    async (_name, rowOverride) => {
      const settlement = resolver(
        vi.fn(async () =>
          jsonResponse({ data: [logRow(rowOverride)] }),
        ) as typeof fetch,
      );

      await expect(settlement.resolve(resolveInput())).resolves.toMatchObject({
        status: "unknown",
        requestId: REQUEST_ID,
      });
    },
  );

  it("returns unknown when output usage exceeds the admitted response budget", async () => {
    const settlement = resolver(
      vi.fn(async () =>
        jsonResponse({ data: [logRow({ completion_tokens: 4_001 })] }),
      ) as typeof fetch,
    );

    await expect(
      settlement.resolve(
        resolveInput({
          usage: undefined,
          maxOutputTokens: 4_000,
        }),
      ),
    ).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it("bounds the consume-log response before parsing JSON", async () => {
    const oversized = JSON.stringify({
      data: [logRow()],
      padding: "x".repeat(4_096),
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(oversized, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(oversized)),
          },
        }),
    );
    const settlement = resolver(fetchMock as typeof fetch, {
      maximumResponseBytes: 256,
    });

    await expect(settlement.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
      requestId: REQUEST_ID,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("turns malformed, unavailable, and timed-out observations into unknown", async () => {
    const malformed = resolver(
      vi.fn(async () => jsonResponse({ data: "not-an-array" })) as typeof fetch,
    );
    await expect(malformed.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
    });

    const unavailable = resolver(
      vi.fn(
        async () => new Response("unavailable", { status: 503 }),
      ) as typeof fetch,
    );
    await expect(unavailable.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
      reason: "log_unavailable",
    });

    const stalledFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const timedOut = new NewApiRequestBoundSettlementResolver(
      {
        gatewayOrigin: GATEWAY_ORIGIN,
        apiKey: FIXTURE_CREDENTIAL,
        resolverId: "copy-new-api-request-bound-v1",
        maximumPollDurationMs: 10,
      },
      {
        fetch: stalledFetch as typeof fetch,
        wait: async () => undefined,
        maximumResponseBytes: 4_096,
      },
    );
    await expect(timedOut.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
      reason: "log_unavailable",
    });
  });

  it("does not wait beyond the poll deadline when a retry sleep is stalled", async () => {
    const bounded = new NewApiRequestBoundSettlementResolver(
      {
        gatewayOrigin: GATEWAY_ORIGIN,
        apiKey: FIXTURE_CREDENTIAL,
        resolverId: "copy-new-api-request-bound-v1",
        maximumPollDurationMs: 10,
      },
      {
        fetch: vi.fn(async () => jsonResponse({ data: [] })) as typeof fetch,
        wait: () => new Promise<void>(() => undefined),
      },
    );
    const started = Date.now();
    await expect(bounded.resolve(resolveInput())).resolves.toMatchObject({
      status: "unknown",
      reason: "log_unavailable",
    });
    expect(Date.now() - started).toBeLessThan(200);
  });
});
