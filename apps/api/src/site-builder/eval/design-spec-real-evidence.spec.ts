import { describe, expect, it, vi } from "vitest";

import {
  createNewApiEvaluationSettlementResolver,
  createRequestIdCapturingFetch,
  designSpecCostAffectingPriceTerms,
  redactModelEvaluationRun,
} from "./design-spec-real-evidence";

const requestId = "req_12345678";

function context(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "model-evaluation:test",
    taskId: "site_builder.design_spec" as const,
    alias: "gpt-5.5",
    protocol: "openai-responses" as const,
    outcome: "completed" as const,
    callCount: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      callCount: 1,
      source: "provider_reported" as const,
      complete: true,
    },
    providerReportedCostCents: [null],
    ...overrides,
  };
}

function resolver(
  fetchImpl: typeof fetch,
  ids = new Map([["model-evaluation:test", [requestId]]]),
  pollDelaysMs: readonly number[] = [],
) {
  return createNewApiEvaluationSettlementResolver({
    gatewayOrigin: "http://127.0.0.1:3001",
    bearerToken: "limited-token",
    requestIdsByExecution: ids,
    routes: [{ alias: "gpt-5.5", protocol: "openai-responses", channelId: 17 }],
    prices: [
      {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        inputCentsPerMillionTokens: 500,
        outputCentsPerMillionTokens: 3000,
      },
    ],
    fetch: fetchImpl,
    pollDelaysMs,
  });
}

describe("design spec real evidence settlement", () => {
  it("treats catalog timestamp-only refreshes as non-price drift", () => {
    const base = {
      entries: [
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          groupName: "gpt-unified",
          status: "published",
          currency: "CNY",
          productLine: "gpt",
          groupMultiplier: "1",
          inputRate: "5",
          outputRate: "30",
          cacheReadRate: "0.5",
          cacheWriteRate: "0",
          effectiveInputRate: "5",
          effectiveOutputRate: "30",
          effectiveCacheReadRate: "0.5",
          effectiveCacheWriteRate: "0",
          modelUpdatedAt: "old",
          pricingVersion: "a".repeat(64),
        },
      ],
    } as never;
    const refreshed = structuredClone(base) as {
      entries: {
        modelUpdatedAt: string;
        pricingVersion: string;
        outputRate: string;
      }[];
    };
    refreshed.entries[0]!.modelUpdatedAt = "new";
    refreshed.entries[0]!.pricingVersion = "b".repeat(64);
    expect(designSpecCostAffectingPriceTerms(base)).toEqual(
      designSpecCostAffectingPriceTerms(refreshed as never),
    );
    refreshed.entries[0]!.outputRate = "31";
    expect(designSpecCostAffectingPriceTerms(base)).not.toEqual(
      designSpecCostAffectingPriceTerms(refreshed as never),
    );
  });

  it("captures the new-api request id without consuming the response", async () => {
    const upstream = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "x-oneapi-request-id": requestId },
        }),
    );
    const captured = createRequestIdCapturingFetch(upstream as typeof fetch);
    const response = await captured.fetch(
      "http://127.0.0.1:3001/v1/responses",
      {
        headers: {
          "x-site-builder-evaluation-execution-id": "model-evaluation:test",
        },
      },
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(captured.requestIdsByExecution.get("model-evaluation:test")).toEqual(
      [requestId],
    );
  });

  it("settles only one exact consume log row on the bound channel", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                request_id: requestId,
                type: 2,
                model_name: "gpt-5.5",
                channel: 17,
                group: "design-spec-eval",
                quota: 1000,
                prompt_tokens: 100,
                completion_tokens: 50,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await expect(
      resolver(fetchImpl as typeof fetch).resolve(context()),
    ).resolves.toEqual({
      state: "settled",
      amountCents: 0.2,
      basis: "frozen_pricing_snapshot",
      executionId: "model-evaluation:test",
    });
  });

  it("waits through a bounded late-log schedule before settling", async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                request_id: requestId,
                type: 2,
                model_name: "gpt-5.5",
                channel: 17,
                group: "design-spec-eval",
                quota: 1000,
                prompt_tokens: 100,
                completion_tokens: 50,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const settlementResolver = createNewApiEvaluationSettlementResolver({
      gatewayOrigin: "http://127.0.0.1:3001",
      bearerToken: "limited-token",
      requestIdsByExecution: new Map([["model-evaluation:test", [requestId]]]),
      routes: [
        { alias: "gpt-5.5", protocol: "openai-responses", channelId: 17 },
      ],
      prices: [
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          inputCentsPerMillionTokens: 500,
          outputCentsPerMillionTokens: 3000,
        },
      ],
      fetch: fetchImpl,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      pollDelaysMs: [250, 500],
    });

    await expect(settlementResolver.resolve(context())).resolves.toMatchObject({
      state: "settled",
      amountCents: 0.2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([250, 500]);
  });

  it.each([
    [[0]],
    [[31_000]],
    [[15_001, 15_000]],
    [[100.5]],
    [Array.from({ length: 17 }, () => 1)],
  ])(
    "rejects an invalid or unbounded settlement poll schedule: %j",
    (delays) => {
      expect(() =>
        resolver(vi.fn() as typeof fetch, undefined, delays),
      ).toThrow("settlement poll schedule must be bounded");
    },
  );

  it("settles repair attempts only when every physical call has one exact log row", async () => {
    const repairRequestId = "req_repair123";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                request_id: requestId,
                type: 2,
                model_name: "gpt-5.5",
                channel: 17,
                group: "design-spec-eval",
                quota: 1000,
                prompt_tokens: 100,
                completion_tokens: 50,
              },
              {
                request_id: repairRequestId,
                type: 2,
                model_name: "gpt-5.5",
                channel: 17,
                group: "design-spec-eval",
                quota: 1000,
                prompt_tokens: 25,
                completion_tokens: 10,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await expect(
      resolver(
        fetchImpl as typeof fetch,
        new Map([["model-evaluation:test", [requestId, repairRequestId]]]),
      ).resolve(
        context({
          callCount: 2,
          usage: {
            inputTokens: 125,
            outputTokens: 60,
            callCount: 2,
            source: "adapter_aggregated",
            complete: true,
          },
        }),
      ),
    ).resolves.toEqual({
      state: "settled",
      amountCents: 0.2425,
      basis: "frozen_pricing_snapshot",
      executionId: "model-evaluation:test",
    });
  });

  it.each([
    ["wrong channel", { channel: 8 }],
    ["wrong model", { model_name: "gpt-5.6-terra" }],
    ["wrong usage", { prompt_tokens: 99 }],
    ["wrong group", { group: "default" }],
    ["missing quota", { quota: undefined }],
    ["zero prompt tokens", { prompt_tokens: 0 }],
  ])("fails closed for %s", async (_label, changed) => {
    const row = {
      request_id: requestId,
      type: 2,
      model_name: "gpt-5.5",
      channel: 17,
      group: "design-spec-eval",
      quota: 1000,
      prompt_tokens: 100,
      completion_tokens: 50,
      ...changed,
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [row] }), {
          status: 200,
        }),
    );
    await expect(
      resolver(fetchImpl as typeof fetch).resolve(context()),
    ).resolves.toEqual({ state: "unknown", reason: "invalid_settlement" });
  });

  it("fails closed when the response request id is absent or duplicated", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        }),
    );
    await expect(
      resolver(fetchImpl as typeof fetch, new Map()).resolve(context()),
    ).resolves.toEqual({ state: "unknown", reason: "invalid_settlement" });
    await expect(
      resolver(
        fetchImpl as typeof fetch,
        new Map([["model-evaluation:test", [requestId, requestId]]]),
      ).resolve(context({ callCount: 2 })),
    ).resolves.toEqual({ state: "unknown", reason: "invalid_settlement" });
  });

  it("never retains raw model artifacts or stability text", () => {
    const redacted = redactModelEvaluationRun({
      artifact: { private: "raw response" },
      artifactSha256: "a".repeat(64),
      artifactRetention: "retained_after_route_gate",
      capabilityProbeAttestation: { attestationSha256: "b".repeat(64) },
      assessment: {
        qualityPassed: true,
        structurePassed: true,
        factualityPassed: true,
        stabilityKey: "sensitive-stability-text",
        findingCodes: ["accepted"],
      },
    } as never) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("raw response");
    expect(JSON.stringify(redacted)).not.toContain("sensitive-stability-text");
    expect(redacted).toMatchObject({
      artifactRetention: "digest_only",
      capabilityProbeAttestationSha256: "b".repeat(64),
      assessment: { findingCodes: ["accepted"] },
    });
  });
});
