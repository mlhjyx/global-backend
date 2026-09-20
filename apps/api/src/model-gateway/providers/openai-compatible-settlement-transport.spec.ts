import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createProviderTransportObservation } from "../provider-transport-observation";
import type { GatewaySettlementObservation } from "../paid-model-settlement";
import type { AiContext, ReviewVisionInput } from "../types";
import {
  ProviderSettlementError,
  ProviderWireInFlightError,
} from "./provider-output-error";
import {
  OpenAICompatibleProvider,
  type GatewayVisionTransport,
} from "./openai-compatible.provider";

const REQUEST_ID = "R".repeat(43);
const NONCE = "N".repeat(43);

function transport(
  finalPhase: "gateway_request_id_observed" | "upstream_ack_unknown",
) {
  return createProviderTransportObservation({
    physicalWireAttempt: 1,
    finalPhase,
    gatewayIdState:
      finalPhase === "gateway_request_id_observed"
        ? "observed"
        : "not_observable",
    upstreamIdState:
      finalPhase === "gateway_request_id_observed" ? "observed" : "unknown",
    payloadState:
      finalPhase === "gateway_request_id_observed" ? "available" : "not_read",
    readbackProbes: [],
  });
}

function settled(): GatewaySettlementObservation {
  return {
    status: "settled",
    physicalWireAttempt: 1,
    resolverId: "new-api-request-bound-reconciliation-v1",
    alias: "gpt-5.6-terra",
    protocol: "openai-chat-completions",
    channelId: 72,
    basis: "openox_catalog_token_pricing",
    quota: 1_250,
    costMicrousd: 540,
    inputTokens: 120,
    outputTokens: 30,
    upstreamIdState: "observed",
    transportObservation: transport("gateway_request_id_observed"),
  };
}

function unknown(): GatewaySettlementObservation {
  return {
    status: "unknown",
    physicalWireAttempt: 1,
    resolverId: "new-api-request-bound-reconciliation-v1",
    reason: "upstream_ack_unknown",
    transportObservation: transport("upstream_ack_unknown"),
  };
}

function provider() {
  return new OpenAICompatibleProvider({
    id: "gateway",
    baseUrl: "http://127.0.0.1:3001/v1",
    apiKey: "k",
    model: "gpt-5.6-terra",
    modelTransports: {
      "gpt-5.6-terra": "openai-chat-completions",
    },
  });
}

function providerFor(
  alias: string,
  protocol:
    | "openai-chat-completions"
    | "openai-responses"
    | "anthropic-messages",
) {
  return new OpenAICompatibleProvider({
    id: "gateway",
    baseUrl: "http://127.0.0.1:3001/v1",
    apiKey: "k",
    model: alias,
    modelTransports: { [alias]: protocol },
  });
}

function context(
  resolve: (input: {
    usage?: { inputTokens?: number; outputTokens?: number };
    payloadState: "not_read" | "available" | "unavailable";
    gatewayIdState: "observed" | "missing" | "not_observable";
    upstreamAckUnknown: boolean;
  }) => Promise<GatewaySettlementObservation>,
  begin: () => Promise<"DISPATCH" | "READBACK_ONLY"> = async () => "DISPATCH",
): AiContext {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    paidCost: {
      siteId: "33333333-3333-4333-8333-333333333333",
      scopeKey: "copy:en",
      settlementPhysicalWire: {
        identity: {
          schemaVersion: "site-build-settlement-wire-identity/v1",
          physicalWireAttempt: 1,
          derivationKeyId: "settlement-test",
          requestId: REQUEST_ID,
          nonce: NONCE,
          nonceSha256: "a".repeat(64),
        },
        begin,
        resolve,
      },
    },
  };
}

function visionInput(model: string): ReviewVisionInput {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
  return {
    task: "site_builder.aesthetic_review.eval",
    prompt: "Review the controlled screenshot.",
    system: "Return JSON only.",
    model,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    maxTokens: 1_000,
    maxCostCents: 20,
    images: [
      {
        materialClass: "model_eval_fixture",
        artifactId: "case-home-375",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/png",
        bytes,
        target: { locale: "en", pageId: "home", breakpoint: 375 },
      },
    ],
  };
}

function visionProviderFor(model: string, transport: GatewayVisionTransport) {
  const input = visionInput(model);
  return new OpenAICompatibleProvider({
    id: "gateway",
    baseUrl: "http://127.0.0.1:3001/v1",
    apiKey: "k",
    model,
    visionModelTransports: { [model]: transport },
    visionEvalFixtureDigests: {
      [input.images[0]!.artifactId]: input.images[0]!.sha256,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI-compatible paid settlement transport", () => {
  it.each([
    ["vision-chat", "openai-chat-completions"],
    ["gpt-5.6-sol", "openai-responses"],
    ["claude-sonnet-5", "anthropic-messages"],
  ] as const)(
    "keeps READBACK_ONLY vision %s replay before fetch and resolution",
    async (model, transport) => {
      const fetchMock = vi.fn();
      const resolve = vi.fn(async () => unknown());
      const begin = vi.fn(async () => "READBACK_ONLY" as const);
      vi.stubGlobal("fetch", fetchMock);

      const error = await visionProviderFor(model, transport)
        .reviewVision(visionInput(model), context(resolve, begin))
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ProviderWireInFlightError);
      expect(begin).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "vision-chat",
      "openai-chat-completions",
      {
        model: "vision-chat",
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      },
    ],
    [
      "gpt-5.6-sol",
      "openai-responses",
      {
        model: "gpt-5.6-sol",
        status: "completed",
        output: [
          { content: [{ type: "output_text", text: '{"ok":true}' }] },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    ],
    [
      "claude-sonnet-5",
      "anthropic-messages",
      {
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"ok":true}' }],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    ],
  ] as const)(
    "sends vision %s only after CAS with bound headers and redirect denial",
    async (model, transport, body) => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-new-api-settlement-request-id")).toBe(REQUEST_ID);
        expect(headers.get("x-new-api-settlement-nonce")).toBe(NONCE);
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "x-oneapi-request-id": "gateway-observed" },
        });
      });
      const resolve = vi.fn(async () => settled());
      const begin = vi.fn(async () => "DISPATCH" as const);
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        visionProviderFor(model, transport).reviewVision(
          visionInput(model),
          context(resolve, begin),
        ),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(begin).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledOnce();
    },
  );

  it("rejects paid Google vision before CAS, fetch, or settlement resolution", async () => {
    const model = "gemini-3.5-flash";
    const fetchMock = vi.fn();
    const resolve = vi.fn(async () => unknown());
    const begin = vi.fn(async () => "DISPATCH" as const);
    vi.stubGlobal("fetch", fetchMock);

    const error = await visionProviderFor(model, "google-generate-content")
      .reviewVision(visionInput(model), context(resolve, begin))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "ProviderSettlementError",
      callCount: 0,
      usage: undefined,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    [
      "openai-chat-completions",
      "/chat/completions",
      {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
        model: "paid-alias",
      },
    ],
    [
      "openai-responses",
      "/responses",
      {
        output: [
          { content: [{ type: "output_text", text: "ok" }] },
        ],
        status: "completed",
        usage: { input_tokens: 120, output_tokens: 30 },
        model: "paid-alias",
      },
    ],
    [
      "anthropic-messages",
      "/messages",
      {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 30 },
        model: "paid-alias",
      },
    ],
  ] as const)(
    "uses the shared preallocated send boundary for %s",
    async (protocol, path, body) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(`http://127.0.0.1:3001/v1${path}`);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-new-api-settlement-request-id")).toBe(
          REQUEST_ID,
        );
        expect(headers.get("x-new-api-settlement-nonce")).toBe(NONCE);
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "x-oneapi-request-id": "gateway-observed" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const resolve = vi.fn(async () => unknown());

      const result = await providerFor("paid-alias", protocol).generateText(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          maxTokens: 100,
        },
        context(resolve),
      );

      expect(result.data).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ] as const)("never fetches on a READBACK_ONLY %s replay", async (protocol) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolve = vi.fn(async () => unknown());

    const error = await providerFor("paid-alias", protocol)
      .generateText(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          maxTokens: 100,
        },
        context(resolve, async () => "READBACK_ONLY"),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderWireInFlightError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("sends the preallocated identity on the physical gateway request", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer k",
      );
      expect(
        new Headers(init?.headers).get("x-new-api-settlement-request-id"),
      ).toBe(REQUEST_ID);
      expect(
        new Headers(init?.headers).get("x-new-api-settlement-nonce"),
      ).toBe(NONCE);
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
          model: "gpt-5.6-terra",
        }),
        {
          status: 200,
          headers: { "x-oneapi-request-id": "gateway-observed" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = vi.fn(async () => settled());

    const result = await provider().generateText(
      { task: "site_builder.copy", prompt: "bounded", maxTokens: 100 },
      context(resolve),
    );

    expect(result.usage?.gatewaySettlements).toEqual([settled()]);
    expect(resolve).toHaveBeenCalledWith({
      usage: { inputTokens: 120, outputTokens: 30 },
      payloadState: "available",
      gatewayIdState: "observed",
      upstreamAckUnknown: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records ACK uncertainty without dispatching a second physical request", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("socket state is intentionally not exposed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolve = vi.fn(async () => unknown());

    const error = await provider()
      .generateText(
        { task: "site_builder.copy", prompt: "bounded", maxTokens: 100 },
        context(resolve),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderSettlementError);
    expect(error).toMatchObject({
      errorCode: "MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN",
      callCount: 1,
      usage: { gatewaySettlements: [unknown()] },
    });
    expect(String(error)).not.toContain("socket state");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("fails before fetch when a paid context has no preallocated wire", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx: AiContext = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      paidCost: {
        siteId: "33333333-3333-4333-8333-333333333333",
        scopeKey: "copy:en",
      },
    };

    const error = await provider()
      .generateText(
        { task: "site_builder.copy", prompt: "bounded", maxTokens: 100 },
        ctx,
      )
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      errorCode: "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE",
      callCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns an unreadable paid payload into a stable redacted failure", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not-json-secret-body", {
        status: 200,
        headers: { "x-oneapi-request-id": "gateway-observed" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const recovered = unknown();
    const resolve = vi.fn(async () => ({
      ...recovered,
      reason: "payload_unavailable" as const,
      transportObservation: createProviderTransportObservation({
        physicalWireAttempt: 1,
        finalPhase: "payload_unavailable",
        gatewayIdState: "observed",
        upstreamIdState: "unknown",
        payloadState: "unavailable",
        readbackProbes: [],
      }),
    }));

    const error = await provider()
      .generateText(
        { task: "site_builder.copy", prompt: "bounded", maxTokens: 100 },
        context(resolve),
      )
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      errorCode: "MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE",
      callCount: 1,
    });
    expect(String(error)).not.toContain("not-json-secret-body");
    expect(resolve).toHaveBeenCalledWith({
      payloadState: "unavailable",
      gatewayIdState: "observed",
      upstreamAckUnknown: false,
    });
  });
});
