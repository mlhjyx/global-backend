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
const MAX_SCHEMA_BYTES = 64 * 1024;
const DIRECT_SUBSCHEMA_KEYS = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SUBSCHEMA_ARRAY_KEYS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;
const SUBSCHEMA_MAP_KEYS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;
const OBJECT_SCHEMA_KEYS = [
  "additionalProperties",
  "dependentRequired",
  "dependentSchemas",
  "maxProperties",
  "minProperties",
  "patternProperties",
  "properties",
  "propertyNames",
  "required",
  "unevaluatedProperties",
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function schemaTypeIncludesObject(type: unknown): boolean {
  return (
    type === "object" ||
    (Array.isArray(type) && type.some((candidate) => candidate === "object"))
  );
}

function isOpenObjectSchema(
  schema: Readonly<Record<string, unknown>>,
): boolean {
  const isObjectSchema =
    schemaTypeIncludesObject(schema.type) ||
    OBJECT_SCHEMA_KEYS.some((key) => Object.hasOwn(schema, key));
  if (!isObjectSchema) return false;
  if (schema.additionalProperties !== false) return true;
  if (
    isRecord(schema.patternProperties) &&
    Object.keys(schema.patternProperties).length > 0
  ) {
    return true;
  }
  return (
    Object.hasOwn(schema, "unevaluatedProperties") &&
    schema.unevaluatedProperties !== false
  );
}

function enqueueSubschemas(
  pending: unknown[],
  schema: Readonly<Record<string, unknown>>,
): void {
  for (const key of DIRECT_SUBSCHEMA_KEYS) {
    const value = schema[key];
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value) || typeof value === "boolean") {
      pending.push(value);
    }
  }
  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const value = schema[key];
    if (Array.isArray(value)) pending.push(...value);
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const value = schema[key];
    if (isRecord(value)) pending.push(...Object.values(value));
  }
  const dependencies = schema.dependencies;
  if (isRecord(dependencies)) {
    pending.push(
      ...Object.values(dependencies).filter(
        (value) => isRecord(value) || typeof value === "boolean",
      ),
    );
  }
}

function requiresJsonToolForSchema(
  schema: Readonly<Record<string, unknown>>,
): boolean {
  const pending: unknown[] = [schema];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    if (isOpenObjectSchema(current)) return true;
    enqueueSubschemas(pending, current);
  }
  return false;
}

function prepareAnthropicSchema(
  schema: Readonly<Record<string, unknown>> | undefined,
): Readonly<{
  schema: Readonly<Record<string, unknown>> | undefined;
  structuredOutputMode: AnthropicStructuredOutputMode;
}> {
  if (schema == null) {
    return Object.freeze({
      schema: undefined,
      structuredOutputMode: "outputFormat",
    });
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error(
      "Anthropic structured-output schema must be JSON serializable",
    );
  }
  if (serialized == null) {
    throw new Error(
      "Anthropic structured-output schema must be JSON serializable",
    );
  }
  const normalized = JSON.parse(serialized) as unknown;
  if (!isRecord(normalized)) {
    throw new Error("Anthropic structured-output schema must be a JSON object");
  }
  const structuredOutputMode = structuredOutputModeFor(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(
      "Anthropic structured-output schema exceeds the byte limit",
    );
  }
  return Object.freeze({ schema: normalized, structuredOutputMode });
}

function enqueueSchemaValues(
  pending: unknown[],
  values: readonly unknown[],
  visitedValues: number,
): void {
  for (const value of values) {
    if (visitedValues + pending.length >= MAX_SCHEMA_NODES) {
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
  let visitedValues = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visitedValues += 1;
    if (visitedValues > MAX_SCHEMA_NODES) {
      throw new Error("Anthropic structured-output schema is too complex");
    }
    if (current == null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      enqueueSchemaValues(pending, current, visitedValues);
      continue;
    }
    enqueueSchemaValues(
      pending,
      Object.values(current as Readonly<Record<string, unknown>>),
      visitedValues,
    );
  }
  return requiresJsonToolForSchema(schema) ? "jsonTool" : "outputFormat";
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
    const preparedSchema = prepareAnthropicSchema(request.outputSchema);
    const output = preparedSchema.schema
      ? Output.object<OutputValue>({
          schema: createValidatedAiSdkSchema<OutputValue>(
            preparedSchema.schema,
          ),
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
            structuredOutputMode: preparedSchema.structuredOutputMode,
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
