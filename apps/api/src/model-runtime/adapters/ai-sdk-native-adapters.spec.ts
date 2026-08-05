import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AiSdkAnthropicMessagesAdapter } from "./ai-sdk-anthropic-messages.adapter";
import {
  NativeModelOutputError,
  type NativeModelAdapterRequest,
} from "./ai-sdk-native-adapter.contract";
import { AiSdkOpenAiResponsesAdapter } from "./ai-sdk-openai-responses.adapter";

interface ObservedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

const openServers: Array<ReturnType<typeof createServer>> = [];
const FIXTURE_API_KEY = ["fixture", "not", "a", "credential"].join("-");
const OPENAI_REQUEST_ID = ["openai", "request", "fixture"].join("-");
const ANTHROPIC_REQUEST_ID = ["anthropic", "request", "fixture"].join("-");
const INVALID_REQUEST_ID = ["invalid", "request", "fixture"].join("-");

function adapterSettings(baseUrl: string) {
  return { baseUrl, canonicalGatewayBaseUrl: baseUrl, apiKey: FIXTURE_API_KEY };
}

async function startFakeGateway(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    observed: ObservedRequest,
  ) => void | Promise<void>,
) {
  const observed: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const current = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body:
        rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
    };
    observed.push(current);
    await handler(request, response, current);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, observed };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

const companySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
} as const;

describe("AI SDK 7 native provider adapters", () => {
  it("preserves OpenAI Responses path, schema, reasoning and response metadata", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          id: "resp_test",
          created_at: 1_786_000_000,
          model: "gpt-5.6-terra-resolved",
          output: [
            {
              type: "message",
              id: "msg_test",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: '{"name":"Acme"}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 17,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens: 9,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
        { "x-oneapi-request-id": OPENAI_REQUEST_ID },
      );
    });

    const adapter = new AiSdkOpenAiResponsesAdapter(
      adapterSettings(gateway.baseUrl),
    );
    const result = await adapter.execute<{ name: string }>({
      alias: "gpt-5.6-terra",
      system: "Return only the requested object.",
      prompt: "Name the company.",
      outputSchema: companySchema,
      outputSchemaName: "company",
      reasoning: { effort: "high" },
      maxOutputTokens: 128,
      abortSignal: AbortSignal.timeout(5_000),
    });

    expect(gateway.observed).toHaveLength(1);
    const [request] = gateway.observed;
    expect(request).toMatchObject({ method: "POST", path: "/v1/responses" });
    expect(request.headers.authorization).toBe(`Bearer ${FIXTURE_API_KEY}`);
    expect(request.body).toMatchObject({
      model: "gpt-5.6-terra",
      max_output_tokens: 128,
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "company",
          strict: true,
          schema: companySchema,
        },
      },
    });
    expect(request.body).not.toHaveProperty("messages");
    expect(result).toMatchObject({
      protocol: "openai-responses",
      requestedModel: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra-resolved",
      requestId: OPENAI_REQUEST_ID,
      output: { name: "Acme" },
      usage: {
        inputTokens: 17,
        uncachedInputTokens: 12,
        outputTokens: 9,
        reasoningTokens: 3,
        cacheReadTokens: 5,
      },
    });
    expect(result.warnings).toEqual([]);
  });

  it("preserves Anthropic Messages path, native auth, schema, reasoning and warnings", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          type: "message",
          id: "msg_anthropic_test",
          model: "claude-sonnet-5-resolved",
          content: [{ type: "text", text: '{"name":"Acme"}' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 19,
            output_tokens: 11,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 4,
          },
        },
        { "x-oneapi-request-id": ANTHROPIC_REQUEST_ID },
      );
    });

    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );
    const result = await adapter.execute<{ name: string }>({
      alias: "claude-sonnet-5",
      system: "Return only the requested object.",
      prompt: "Name the company.",
      outputSchema: companySchema,
      outputSchemaName: "company",
      reasoning: { effort: "high" },
      temperature: 0.2,
      maxOutputTokens: 128,
      abortSignal: AbortSignal.timeout(5_000),
    });

    expect(gateway.observed).toHaveLength(1);
    const [request] = gateway.observed;
    expect(request).toMatchObject({ method: "POST", path: "/v1/messages" });
    expect(request.headers["x-api-key"]).toBe(FIXTURE_API_KEY);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 128,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: companySchema },
      },
    });
    expect(request.body).not.toHaveProperty("input");
    expect(request.body).not.toHaveProperty("temperature");
    expect(result).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5-resolved",
      requestId: ANTHROPIC_REQUEST_ID,
      output: { name: "Acme" },
      usage: {
        inputTokens: 30,
        uncachedInputTokens: 19,
        outputTokens: 11,
        cacheReadTokens: 4,
        cacheWriteTokens: 7,
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "unsupported",
          feature: "temperature",
        }),
      ]),
    );
  });

  it.each([
    ["openai", AiSdkOpenAiResponsesAdapter],
    ["anthropic", AiSdkAnthropicMessagesAdapter],
  ] as const)("disables SDK retries for %s", async (_name, Adapter) => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(response, 500, { error: { message: "temporary failure" } });
    });
    const adapter = new Adapter(adapterSettings(gateway.baseUrl));

    await expect(
      adapter.execute({
        alias: _name === "openai" ? "gpt-5.6-terra" : "claude-sonnet-5",
        prompt: "hello",
        maxOutputTokens: 32,
        abortSignal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow();
    expect(gateway.observed).toHaveLength(1);
  });

  it("rejects unsupported Anthropic reasoning before dispatch", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(response, 200, {});
    });
    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    await expect(
      adapter.execute({
        alias: "claude-sonnet-5",
        prompt: "hello",
        maxOutputTokens: 32,
        reasoning: { effort: "minimal" },
        abortSignal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow("does not support reasoning effort 'minimal'");
    expect(gateway.observed).toHaveLength(0);
  });

  it("rejects a missing deadline and protected header overrides before dispatch", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(response, 200, {});
    });
    const adapter = new AiSdkOpenAiResponsesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    await expect(
      adapter.execute({
        alias: "gpt-5.6-terra",
        prompt: "hello",
        maxOutputTokens: 32,
      } as NativeModelAdapterRequest),
    ).rejects.toThrow("requires a bounded AbortSignal");
    await expect(
      adapter.execute({
        alias: "gpt-5.6-terra",
        prompt: "hello",
        maxOutputTokens: 32,
        abortSignal: AbortSignal.timeout(5_000),
        headers: { Authorization: "Bearer different-token" },
      }),
    ).rejects.toThrow("cannot override protected header 'Authorization'");
    expect(gateway.observed).toHaveLength(0);
  });

  it("preserves settlement metadata when structured output validation fails", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          id: "resp_invalid",
          created_at: 1_786_000_000,
          model: "gpt-5.6-terra-resolved",
          output: [
            {
              type: "message",
              id: "msg_invalid",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: '{"name":42}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 13,
            output_tokens: 6,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
        { "x-oneapi-request-id": INVALID_REQUEST_ID },
      );
    });
    const adapter = new AiSdkOpenAiResponsesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    const error = await adapter
      .execute({
        alias: "gpt-5.6-terra",
        prompt: "Name the company.",
        outputSchema: companySchema,
        outputSchemaName: "company",
        maxOutputTokens: 64,
        abortSignal: AbortSignal.timeout(5_000),
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(NativeModelOutputError);
    expect(error).toMatchObject({
      protocol: "openai-responses",
      requestedModel: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra-resolved",
      requestId: INVALID_REQUEST_ID,
      rawOutputText: '{"name":42}',
      rawOutputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      usage: { inputTokens: 13, outputTokens: 6, reasoningTokens: 2 },
    });
    expect(gateway.observed).toHaveLength(1);
  });

  it("rejects official provider origins and canonical gateway drift before dispatch", () => {
    expect(
      () =>
        new AiSdkOpenAiResponsesAdapter({
          baseUrl: "https://api.openai.com/v1",
          canonicalGatewayBaseUrl: "https://api.openai.com/v1",
          apiKey: FIXTURE_API_KEY,
        }),
    ).toThrow(/direct provider origins/);
    expect(
      () =>
        new AiSdkAnthropicMessagesAdapter({
          baseUrl: "https://gateway.internal.example/v1",
          canonicalGatewayBaseUrl: "https://other.internal.example/v1",
          apiKey: FIXTURE_API_KEY,
        }),
    ).toThrow(/canonical new-api gateway/);
  });

  it.each([
    ["openai", AiSdkOpenAiResponsesAdapter],
    ["anthropic", AiSdkAnthropicMessagesAdapter],
  ] as const)("forwards AbortSignal for %s", async (_name, Adapter) => {
    const gateway = await startFakeGateway(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!response.destroyed) sendJson(response, 200, {});
    });
    const adapter = new Adapter(adapterSettings(gateway.baseUrl));
    const controller = new AbortController();
    const execution = adapter.execute({
      alias: _name === "openai" ? "gpt-5.6-terra" : "claude-sonnet-5",
      prompt: "hello",
      maxOutputTokens: 32,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("runtime timeout")), 20);

    await expect(execution).rejects.toThrow();
    expect(gateway.observed).toHaveLength(1);
  });
});
