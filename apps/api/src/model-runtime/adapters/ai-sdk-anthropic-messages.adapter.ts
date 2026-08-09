import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import {
  assertSafeRequestHeaders,
  createValidatedAiSdkSchema,
  normalizeAiSdkUsage,
  normalizeAiSdkWarnings,
  readOneApiRequestId,
  throwNormalizedOutputError,
} from "./ai-sdk-adapter-result";
import type {
  AiSdkNativeAdapterSettings,
  NativeModelAdapter,
  NativeModelAdapterRequest,
  NativeModelAdapterResult,
  NativeReasoningEffort,
} from "./ai-sdk-native-adapter.contract";
import { assertNewApiGatewayBinding } from "./ai-sdk-native-adapter.contract";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh";
type AnthropicStructuredOutputMode = "outputFormat" | "jsonTool";

const MAX_SCHEMA_NODES = 4_096;

function enqueueSchemaValues(
  pending: unknown[],
  values: readonly unknown[],
  visited: number,
): void {
  for (const value of values) {
    if (visited + pending.length >= MAX_SCHEMA_NODES) {
      throw new Error("Anthropic structured-output schema is too complex");
    }
    pending.push(value);
  }
}

function structuredOutputModeFor(
  schema: Readonly<Record<string, unknown>> | undefined,
): AnthropicStructuredOutputMode {
  if (schema == null) return "outputFormat";
  const pending: unknown[] = [schema];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    if (visited > MAX_SCHEMA_NODES) {
      throw new Error("Anthropic structured-output schema is too complex");
    }
    if (Array.isArray(current)) {
      enqueueSchemaValues(pending, current, visited);
      continue;
    }
    const object = current as Readonly<Record<string, unknown>>;
    const additionalProperties = object.additionalProperties;
    if (
      additionalProperties === true ||
      (additionalProperties != null && typeof additionalProperties === "object")
    ) {
      return "jsonTool";
    }
    enqueueSchemaValues(pending, Object.values(object), visited);
  }
  return "outputFormat";
}

function toAnthropicOptions(reasoning: NativeReasoningEffort | undefined) {
  if (reasoning == null) return {};
  if (reasoning === "none") {
    return { thinking: { type: "disabled" as const } };
  }
  if (reasoning === "minimal") {
    throw new Error(
      "Anthropic Messages does not support reasoning effort 'minimal'",
    );
  }
  return {
    thinking: { type: "adaptive" as const },
    effort: reasoning as AnthropicEffort,
  };
}

export class AiSdkAnthropicMessagesAdapter implements NativeModelAdapter {
  readonly protocol = "anthropic-messages" as const;
  private readonly provider: ReturnType<typeof createAnthropic>;

  constructor(settings: AiSdkNativeAdapterSettings) {
    assertNewApiGatewayBinding(settings);
    this.provider = createAnthropic({
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      name: "new-api-anthropic-messages",
    });
  }

  async execute<OutputValue = string>(
    request: NativeModelAdapterRequest,
  ): Promise<NativeModelAdapterResult<OutputValue>> {
    if (request.abortSignal == null) {
      throw new Error("Model adapter requires a bounded AbortSignal");
    }
    assertSafeRequestHeaders(request.headers);
    const output = request.outputSchema
      ? Output.object<OutputValue>({
          schema: createValidatedAiSdkSchema<OutputValue>(request.outputSchema),
          name: request.outputSchemaName,
        })
      : Output.text();
    let result;
    try {
      result = await generateText({
        model: this.provider.messages(request.alias),
        system: request.system,
        prompt: request.prompt,
        output,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        maxRetries: 0,
        abortSignal: request.abortSignal,
        headers: request.headers,
        providerOptions: {
          anthropic: {
            structuredOutputMode: structuredOutputModeFor(request.outputSchema),
            ...toAnthropicOptions(request.reasoning?.effort),
          },
        },
      });
    } catch (error) {
      throwNormalizedOutputError({
        error,
        protocol: this.protocol,
        requestedModel: request.alias,
      });
    }

    return Object.freeze({
      protocol: this.protocol,
      requestedModel: request.alias,
      reportedModel: result.response.modelId,
      ...(readOneApiRequestId(result.response.headers) == null
        ? {}
        : { requestId: readOneApiRequestId(result.response.headers) }),
      output: result.output as OutputValue,
      usage: normalizeAiSdkUsage(result.usage),
      warnings: normalizeAiSdkWarnings(result.warnings),
    });
  }
}
