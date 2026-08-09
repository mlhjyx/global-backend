import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AiSdkAnthropicMessagesAdapter } from "./ai-sdk-anthropic-messages.adapter";
import { AiSdkOpenAiChatCompletionsAdapter } from "./ai-sdk-openai-chat-completions.adapter";
import {
  NativeModelApiError,
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
const OPENAI_CHAT_REQUEST_ID = ["openai", "chat", "request", "fixture"].join(
  "-",
);
const OPENAI_CHAT_ERROR_REQUEST_ID = [
  "openai",
  "chat",
  "error",
  "fixture",
].join("-");
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

function sendOpenAiResponsesStream(
  response: ServerResponse,
  input: {
    model: string;
    text: string;
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
  },
  headers: Record<string, string> = {},
): void {
  const messageId = "msg_stream_fixture";
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_stream_fixture",
        created_at: 1_786_000_000,
        model: input.model,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: messageId },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      delta: input.text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: messageId },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: input.inputTokens,
          input_tokens_details: {
            cached_tokens: input.cachedInputTokens ?? 0,
          },
          output_tokens: input.outputTokens,
          output_tokens_details: {
            reasoning_tokens: input.reasoningTokens ?? 0,
          },
        },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...headers,
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function sendOpenAiChatStream(
  response: ServerResponse,
  input: {
    model: string;
    text: string;
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
  },
  headers: Record<string, string> = {},
): void {
  const chunks = [
    {
      id: "chatcmpl_stream_fixture",
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_stream_fixture",
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.model,
      choices: [
        {
          index: 0,
          delta: { content: input.text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_stream_fixture",
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "chatcmpl_stream_fixture",
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.model,
      choices: [],
      usage: {
        prompt_tokens: input.inputTokens,
        completion_tokens: input.outputTokens,
        total_tokens: input.inputTokens + input.outputTokens,
        prompt_tokens_details: {
          cached_tokens: input.cachedInputTokens ?? 0,
        },
        completion_tokens_details: {
          reasoning_tokens: input.reasoningTokens ?? 0,
        },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...headers,
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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

const dynamicCopySlotsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slots"],
  properties: {
    slots: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["content", "claimRefs"],
        properties: {
          content: { type: "string" },
          claimRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

describe("AI SDK 7 native provider adapters", () => {
  it("streams OpenAI Responses while preserving schema, reasoning and response metadata", async () => {
    const gateway = await startFakeGateway((_request, response, observed) => {
      if (observed.body.stream !== true) {
        sendJson(response, 400, { error: { message: "stream required" } });
        return;
      }
      sendOpenAiResponsesStream(
        response,
        {
          model: "gpt-5.6-terra-resolved",
          text: '{"name":"Acme"}',
          inputTokens: 17,
          cachedInputTokens: 5,
          outputTokens: 9,
          reasoningTokens: 3,
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
      stream: true,
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

  it("streams native OpenAI Chat while preserving schema, reasoning, usage, warnings and response metadata", async () => {
    const gateway = await startFakeGateway((_request, response, observed) => {
      if (observed.body.stream !== true) {
        sendJson(response, 400, { error: { message: "stream required" } });
        return;
      }
      sendOpenAiChatStream(
        response,
        {
          model: "gpt-5.6-terra-resolved",
          text: '{"name":"Acme"}',
          inputTokens: 23,
          cachedInputTokens: 6,
          outputTokens: 10,
          reasoningTokens: 4,
        },
        { "x-oneapi-request-id": OPENAI_CHAT_REQUEST_ID },
      );
    });

    const adapter = new AiSdkOpenAiChatCompletionsAdapter(
      adapterSettings(gateway.baseUrl),
    );
    const result = await adapter.execute<{ name: string }>({
      alias: "gpt-5.6-terra",
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
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
    });
    expect(request.headers.authorization).toBe(`Bearer ${FIXTURE_API_KEY}`);
    expect(request.body).toMatchObject({
      model: "gpt-5.6-terra",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 128,
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "company",
          strict: true,
          schema: companySchema,
        },
      },
    });
    expect(request.body).toHaveProperty("messages");
    expect(request.body).not.toHaveProperty("input");
    expect(request.body).not.toHaveProperty("temperature");
    expect(result).toMatchObject({
      protocol: "openai-chat-completions",
      requestedModel: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra-resolved",
      requestId: OPENAI_CHAT_REQUEST_ID,
      output: { name: "Acme" },
      usage: {
        inputTokens: 23,
        uncachedInputTokens: 17,
        outputTokens: 10,
        reasoningTokens: 4,
        cacheReadTokens: 6,
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

  it("preserves a bounded native 524 Chat failure without retrying or leaking its body", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        524,
        { error: { message: "upstream timed out" } },
        { "x-oneapi-request-id": OPENAI_CHAT_ERROR_REQUEST_ID },
      );
    });
    const adapter = new AiSdkOpenAiChatCompletionsAdapter(
      adapterSettings(gateway.baseUrl),
    );

    const error = await adapter
      .execute({
        alias: "gpt-5.6-terra",
        prompt: "hello",
        maxOutputTokens: 32,
        abortSignal: AbortSignal.timeout(5_000),
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(NativeModelApiError);
    expect(error).toMatchObject({
      protocol: "openai-chat-completions",
      requestedModel: "gpt-5.6-terra",
      requestId: OPENAI_CHAT_ERROR_REQUEST_ID,
      statusCode: 524,
      retryable: true,
      responseBodyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      responseBodyBytes: expect.any(Number),
    });
    expect(error).not.toHaveProperty("responseBody");
    expect(gateway.observed).toHaveLength(1);
  });

  it("honors the AbortSignal when native Chat receives no early SSE event", async () => {
    let clientClosedBeforeServerEnd = false;
    let resolveStreamOpened: () => void = () => undefined;
    let resolveCloseObserved: () => void = () => undefined;
    const streamOpened = new Promise<void>((resolve) => {
      resolveStreamOpened = resolve;
    });
    const closeObserved = new Promise<void>((resolve) => {
      resolveCloseObserved = resolve;
    });
    const gateway = await startFakeGateway(async (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      resolveStreamOpened();
      response.on("close", () => {
        clientClosedBeforeServerEnd = !response.writableEnded;
        resolveCloseObserved();
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!response.destroyed) response.end();
    });
    const adapter = new AiSdkOpenAiChatCompletionsAdapter(
      adapterSettings(gateway.baseUrl),
    );
    const controller = new AbortController();
    const execution = adapter.execute({
      alias: "gpt-5.6-terra",
      prompt: "hello",
      maxOutputTokens: 32,
      abortSignal: controller.signal,
    });

    await streamOpened;
    controller.abort(new Error("no early SSE deadline reached"));
    await expect(execution).rejects.toThrow();

    await closeObserved;
    expect(clientClosedBeforeServerEnd).toBe(true);
    expect(gateway.observed).toHaveLength(1);
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

  it("uses the Anthropic JSON tool for schema-valued additionalProperties", async () => {
    const output = {
      slots: {
        hero_headline: { content: "Precision systems", claimRefs: [] },
      },
    };
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          type: "message",
          id: "msg_anthropic_dynamic_slots",
          model: "claude-sonnet-5",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_dynamic_slots",
              name: "json",
              input: output,
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 21,
            output_tokens: 13,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        { "x-oneapi-request-id": ANTHROPIC_REQUEST_ID },
      );
    });
    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    const result = await adapter.execute<typeof output>({
      alias: "claude-sonnet-5",
      prompt: "Write every requested copy slot.",
      outputSchema: dynamicCopySlotsSchema,
      outputSchemaName: "copy_capability_output",
      reasoning: { effort: "medium" },
      maxOutputTokens: 1_200,
      abortSignal: AbortSignal.timeout(5_000),
    });

    expect(gateway.observed).toHaveLength(1);
    const [request] = gateway.observed;
    expect(request.body).toMatchObject({
      model: "claude-sonnet-5",
      output_config: { effort: "medium" },
      tools: [
        {
          name: "json",
          description: "Respond with a JSON object.",
          input_schema: dynamicCopySlotsSchema,
        },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    expect(request.body).not.toHaveProperty("output_config.format");
    expect(result.output).toEqual(output);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an oversized Anthropic output schema before dispatch", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(response, 500, { error: "must not dispatch" });
    });
    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );
    const properties = Object.fromEntries(
      Array.from({ length: 4_096 }, (_, index) => [
        `field_${index}`,
        { type: "string" },
      ]),
    );

    await expect(
      adapter.execute({
        alias: "claude-sonnet-5",
        prompt: "Do not dispatch this oversized schema.",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties,
        },
        outputSchemaName: "oversized_output",
        maxOutputTokens: 64,
        abortSignal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow("Anthropic structured-output schema is too complex");
    expect(gateway.observed).toHaveLength(0);
  });

  it("preserves Anthropic cache-write-only usage", async () => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          type: "message",
          id: "msg_anthropic_cache_write_only",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: '{"name":"Acme"}' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 94,
            cache_creation_input_tokens: 1_199,
            cache_read_input_tokens: 0,
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
      prompt: "Name the company.",
      outputSchema: companySchema,
      outputSchemaName: "company",
      reasoning: { effort: "medium" },
      maxOutputTokens: 1_200,
      abortSignal: AbortSignal.timeout(5_000),
    });

    expect(result).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5",
      requestId: ANTHROPIC_REQUEST_ID,
      output: { name: "Acme" },
      usage: {
        inputTokens: 1_199,
        uncachedInputTokens: 0,
        outputTokens: 94,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_199,
      },
    });
  });

  it("records only a redacted response shape when a Messages HTTP 200 body is invalid", async () => {
    const sensitiveCopy = "sensitive-copy-must-not-enter-diagnostics";
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          type: "message",
          id: "msg_anthropic_invalid_200",
          model: "claude-sonnet-5",
          content: [
            {
              type: "text",
              text: { invalid: sensitiveCopy },
              private_note: sensitiveCopy,
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 94,
            cache_creation_input_tokens: 1_199,
            cache_read_input_tokens: 0,
            private_usage: sensitiveCopy,
          },
          private_note: sensitiveCopy,
        },
        { "x-oneapi-request-id": ANTHROPIC_REQUEST_ID },
      );
    });
    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    const error = await adapter
      .execute({
        alias: "claude-sonnet-5",
        prompt: "Name the company.",
        outputSchema: companySchema,
        outputSchemaName: "company",
        reasoning: { effort: "medium" },
        maxOutputTokens: 1_200,
        abortSignal: AbortSignal.timeout(5_000),
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(NativeModelApiError);
    expect(error).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      requestId: ANTHROPIC_REQUEST_ID,
      statusCode: 200,
      retryable: false,
      responseShape: {
        schemaVersion: "native-model-response-shape/2026-08-09-v1",
        topLevelKeys: [
          "content",
          "id",
          "model",
          "stop_reason",
          "stop_sequence",
          "type",
          "usage",
        ],
        contentBlockTypes: ["text"],
        usageKeys: [
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "input_tokens",
          "output_tokens",
        ],
        validationPaths: ["content[0].text"],
      },
    });
    expect(error).not.toHaveProperty("responseBody");
    expect(error).not.toHaveProperty("requestBodyValues");
    expect(JSON.stringify(error)).not.toContain(sensitiveCopy);
    expect(JSON.stringify(error)).not.toContain("private_note");
    expect(JSON.stringify(error)).not.toContain("private_usage");
    expect(gateway.observed).toHaveLength(1);
  });

  it("records only allowlisted nested paths for a v13-shaped invalid Messages response", async () => {
    const sensitiveCopy = "sensitive-v13-copy-must-not-enter-diagnostics";
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(
        response,
        200,
        {
          type: "message",
          id: "msg_anthropic_v13_shape",
          model: "claude-sonnet-5",
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: sensitiveCopy,
              signature: "fixture-signature",
            },
            { type: "text", text: '{"name":"Acme"}' },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: {
            type: "end_turn",
            category: null,
            explanation: null,
            recommended_model: { private_value: sensitiveCopy },
          },
          usage: {
            input_tokens: 0,
            output_tokens: 94,
            output_tokens_details: { thinking_tokens: sensitiveCopy },
            cache_creation_input_tokens: 1_199,
            cache_read_input_tokens: 0,
          },
          context_management: {
            applied_edits: [
              { type: "future_context_edit", private_value: sensitiveCopy },
            ],
          },
        },
        { "x-oneapi-request-id": ANTHROPIC_REQUEST_ID },
      );
    });
    const adapter = new AiSdkAnthropicMessagesAdapter(
      adapterSettings(gateway.baseUrl),
    );

    const error = await adapter
      .execute({
        alias: "claude-sonnet-5",
        prompt: "Name the company.",
        outputSchema: companySchema,
        outputSchemaName: "company",
        reasoning: { effort: "medium" },
        maxOutputTokens: 1_200,
        abortSignal: AbortSignal.timeout(5_000),
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(NativeModelApiError);
    expect(error).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      requestId: ANTHROPIC_REQUEST_ID,
      statusCode: 200,
      retryable: false,
      responseShape: {
        schemaVersion: "native-model-response-shape/2026-08-09-v1",
        topLevelKeys: [
          "content",
          "context_management",
          "id",
          "model",
          "role",
          "stop_details",
          "stop_reason",
          "stop_sequence",
          "type",
          "usage",
        ],
        contentBlockTypes: ["text", "thinking"],
        usageKeys: [
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "input_tokens",
          "output_tokens",
          "output_tokens_details",
        ],
        validationPaths: [
          "context_management.applied_edits[0]",
          "stop_details.recommended_model",
          "usage.output_tokens_details.thinking_tokens",
        ],
      },
    });
    expect(error).not.toHaveProperty("responseBody");
    expect(error).not.toHaveProperty("requestBodyValues");
    expect(JSON.stringify(error)).not.toContain(sensitiveCopy);
    expect(JSON.stringify(error)).not.toContain("private_value");
    expect(gateway.observed).toHaveLength(1);
  });

  it.each([
    ["openai-responses", AiSdkOpenAiResponsesAdapter, "gpt-5.6-terra"],
    ["openai-chat", AiSdkOpenAiChatCompletionsAdapter, "gpt-5.6-terra"],
    ["anthropic", AiSdkAnthropicMessagesAdapter, "claude-sonnet-5"],
  ] as const)("disables SDK retries for %s", async (_name, Adapter, alias) => {
    const gateway = await startFakeGateway((_request, response) => {
      sendJson(response, 500, { error: { message: "temporary failure" } });
    });
    const adapter = new Adapter(adapterSettings(gateway.baseUrl));

    await expect(
      adapter.execute({
        alias,
        prompt: "hello",
        maxOutputTokens: 32,
        abortSignal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow();
    expect(gateway.observed).toHaveLength(1);
  });

  it.each([
    [
      "openai",
      AiSdkOpenAiResponsesAdapter,
      "gpt-5.6-terra",
      "openai-responses",
    ],
    [
      "openai-chat",
      AiSdkOpenAiChatCompletionsAdapter,
      "gpt-5.6-terra",
      "openai-chat-completions",
    ],
    [
      "anthropic",
      AiSdkAnthropicMessagesAdapter,
      "claude-sonnet-5",
      "anthropic-messages",
    ],
  ] as const)(
    "preserves bounded settlement diagnostics for %s API failures",
    async (_name, Adapter, alias, protocol) => {
      const requestId = `${_name}-failed-request`;
      const gateway = await startFakeGateway((_request, response) => {
        sendJson(
          response,
          400,
          { error: { message: "unsupported request shape" } },
          { "x-oneapi-request-id": requestId },
        );
      });
      const adapter = new Adapter(adapterSettings(gateway.baseUrl));

      const error = await adapter
        .execute({
          alias,
          prompt: "hello",
          maxOutputTokens: 32,
          abortSignal: AbortSignal.timeout(5_000),
        })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      expect(error).toBeInstanceOf(NativeModelApiError);
      expect(error).toMatchObject({
        protocol,
        requestedModel: alias,
        requestId,
        statusCode: 400,
        retryable: false,
        responseBodyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        responseBodyBytes: expect.any(Number),
      });
      expect(error).not.toHaveProperty("responseBody");
      expect(error).not.toHaveProperty("requestBodyValues");
      expect(gateway.observed).toHaveLength(1);
    },
  );

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

  it("preserves settlement metadata when streamed structured output validation fails", async () => {
    const gateway = await startFakeGateway((_request, response, observed) => {
      if (observed.body.stream !== true) {
        sendJson(response, 400, { error: { message: "stream required" } });
        return;
      }
      sendOpenAiResponsesStream(
        response,
        {
          model: "gpt-5.6-terra-resolved",
          text: '{"name":42}',
          inputTokens: 13,
          outputTokens: 6,
          reasoningTokens: 2,
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
    ["openai-responses", AiSdkOpenAiResponsesAdapter, "gpt-5.6-terra"],
    ["openai-chat", AiSdkOpenAiChatCompletionsAdapter, "gpt-5.6-terra"],
    ["anthropic", AiSdkAnthropicMessagesAdapter, "claude-sonnet-5"],
  ] as const)("forwards AbortSignal for %s", async (_name, Adapter, alias) => {
    let resolveRequestObserved: () => void = () => undefined;
    const requestObserved = new Promise<void>((resolve) => {
      resolveRequestObserved = resolve;
    });
    const gateway = await startFakeGateway(async (_request, response) => {
      resolveRequestObserved();
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!response.destroyed) sendJson(response, 200, {});
    });
    const adapter = new Adapter(adapterSettings(gateway.baseUrl));
    const controller = new AbortController();
    const execution = adapter.execute({
      alias,
      prompt: "hello",
      maxOutputTokens: 32,
      abortSignal: controller.signal,
    });
    await requestObserved;
    controller.abort(new Error("runtime timeout"));

    await expect(execution).rejects.toThrow();
    expect(gateway.observed).toHaveLength(1);
  });
});
