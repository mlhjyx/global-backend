import { createHash } from "node:crypto";
import {
  APICallError,
  jsonSchema,
  NoObjectGeneratedError,
  type LanguageModelUsage,
} from "ai";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type {
  NativeAdapterUsage,
  NativeAdapterWarning,
  NativeModelProtocol,
  NativeModelResponseShape,
} from "./ai-sdk-native-adapter.contract";
import {
  NativeModelApiError,
  NativeModelOutputError,
} from "./ai-sdk-native-adapter.contract";

const schemaValidator = addFormats(new Ajv({ allErrors: true, strict: true }));
const MAX_INVALID_OUTPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_SHAPE_BYTES = 64 * 1024;
const MAX_RESPONSE_SHAPE_ITEMS = 32;

const SAFE_TOP_LEVEL_KEYS = new Set([
  "background",
  "choices",
  "container",
  "content",
  "context_management",
  "created",
  "created_at",
  "error",
  "id",
  "incomplete_details",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "object",
  "output",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "role",
  "safety_identifier",
  "service_tier",
  "status",
  "stop_details",
  "stop_reason",
  "stop_sequence",
  "store",
  "system_fingerprint",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
  "type",
  "usage",
  "user",
]);
const SAFE_CONTENT_BLOCK_TYPES = new Set([
  "advisor_tool_result",
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "compaction",
  "fallback",
  "function_call",
  "mcp_tool_result",
  "mcp_tool_use",
  "message",
  "output_text",
  "reasoning",
  "redacted_thinking",
  "server_tool_use",
  "text",
  "text_editor_code_execution_tool_result",
  "thinking",
  "tool_call",
  "tool_search_tool_result",
  "tool_use",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);
const SAFE_USAGE_KEYS = new Set([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "completion_tokens",
  "completion_tokens_details",
  "input_tokens",
  "input_tokens_details",
  "iterations",
  "output_tokens",
  "output_tokens_details",
  "prompt_tokens",
  "prompt_tokens_details",
  "total_tokens",
]);
const SAFE_VALIDATION_PATH_SEGMENTS = new Set([
  ...SAFE_TOP_LEVEL_KEYS,
  ...SAFE_USAGE_KEYS,
  "caller",
  "citations",
  "data",
  "input",
  "name",
  "signature",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeKeys(
  value: Record<string, unknown> | undefined,
  allowlist: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(
    Object.keys(value ?? {})
      .filter((key) => allowlist.has(key))
      .sort()
      .slice(0, MAX_RESPONSE_SHAPE_ITEMS),
  );
}

function validationIssues(error: unknown): readonly unknown[] {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const currentRecord = record(current);
    if (Array.isArray(currentRecord?.issues)) return currentRecord.issues;
    current = currentRecord?.cause;
  }
  return [];
}

function safeValidationPath(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return undefined;
  }
  let path = "";
  for (const segment of value) {
    if (Number.isSafeInteger(segment) && Number(segment) >= 0) {
      path += `[${segment}]`;
      continue;
    }
    if (
      typeof segment !== "string" ||
      !SAFE_VALIDATION_PATH_SEGMENTS.has(segment)
    ) {
      return undefined;
    }
    path += path.length === 0 ? segment : `.${segment}`;
  }
  return path.length <= 128 ? path : undefined;
}

function redactedResponseShape(
  error: APICallError,
): NativeModelResponseShape | undefined {
  if (
    error.statusCode == null ||
    error.statusCode < 200 ||
    error.statusCode >= 300 ||
    error.responseBody == null ||
    Buffer.byteLength(error.responseBody, "utf8") > MAX_RESPONSE_SHAPE_BYTES
  ) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(error.responseBody) as unknown;
  } catch {
    return undefined;
  }
  const topLevel = record(body);
  if (topLevel == null) return undefined;
  const content = Array.isArray(topLevel.content) ? topLevel.content : [];
  const contentBlockTypes = Object.freeze(
    [
      ...new Set(
        content
          .map((block) => record(block)?.type)
          .filter(
            (type): type is string =>
              typeof type === "string" && SAFE_CONTENT_BLOCK_TYPES.has(type),
          ),
      ),
    ]
      .sort()
      .slice(0, MAX_RESPONSE_SHAPE_ITEMS),
  );
  const validationPaths = Object.freeze(
    [
      ...new Set(
        validationIssues(error.cause)
          .map((issue) => safeValidationPath(record(issue)?.path))
          .filter((path): path is string => path != null),
      ),
    ]
      .sort()
      .slice(0, MAX_RESPONSE_SHAPE_ITEMS),
  );
  return Object.freeze({
    schemaVersion: "native-model-response-shape/2026-08-09-v1" as const,
    topLevelKeys: safeKeys(topLevel, SAFE_TOP_LEVEL_KEYS),
    contentBlockTypes,
    usageKeys: safeKeys(record(topLevel.usage), SAFE_USAGE_KEYS),
    validationPaths,
  });
}

export function createValidatedAiSdkSchema<OutputValue>(
  schema: Readonly<Record<string, unknown>>,
) {
  const validate = schemaValidator.compile(schema);
  return jsonSchema<OutputValue>(schema, {
    validate: (value) =>
      validate(value)
        ? { success: true, value: value as OutputValue }
        : {
            success: false,
            error: new Error(
              `JSON Schema validation failed: ${schemaValidator.errorsText(validate.errors)}`,
            ),
          },
  });
}

export function normalizeAiSdkWarnings(
  warnings: readonly unknown[] | undefined,
): readonly NativeAdapterWarning[] {
  return Object.freeze(
    (warnings ?? []).map((warning) => {
      const value =
        warning != null && typeof warning === "object"
          ? (warning as Readonly<Record<string, unknown>>)
          : {};
      return Object.freeze({
        type: typeof value.type === "string" ? value.type : "provider-warning",
        ...(typeof value.feature === "string"
          ? { feature: value.feature }
          : {}),
        ...(typeof value.details === "string"
          ? { details: value.details }
          : {}),
      });
    }),
  );
}

export function normalizeAiSdkUsage(
  usage: LanguageModelUsage,
): NativeAdapterUsage {
  return Object.freeze({
    ...(usage.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.inputTokenDetails.noCacheTokens == null
      ? {}
      : { uncachedInputTokens: usage.inputTokenDetails.noCacheTokens }),
    ...(usage.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.outputTokenDetails.reasoningTokens == null
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens == null
      ? {}
      : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails.cacheWriteTokens == null
      ? {}
      : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.totalTokens == null ? {} : { totalTokens: usage.totalTokens }),
  });
}

export function readOneApiRequestId(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (headers == null) return undefined;
  return Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-oneapi-request-id",
  )?.[1];
}

const PROTECTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-type",
]);

export function assertSafeRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): void {
  const overriddenHeader = Object.keys(headers ?? {}).find((name) =>
    PROTECTED_HEADERS.has(name.toLowerCase()),
  );
  if (overriddenHeader != null) {
    throw new Error(
      `Model adapter request cannot override protected header '${overriddenHeader}'`,
    );
  }
}

export function throwNormalizedOutputError(input: {
  error: unknown;
  protocol: NativeModelProtocol;
  requestedModel: string;
}): never {
  if (APICallError.isInstance(input.error)) {
    const responseBody = input.error.responseBody;
    const responseShape = redactedResponseShape(input.error);
    throw new NativeModelApiError({
      protocol: input.protocol,
      requestedModel: input.requestedModel,
      requestId: readOneApiRequestId(input.error.responseHeaders),
      statusCode: input.error.statusCode,
      retryable: input.error.isRetryable,
      ...(responseBody == null
        ? {}
        : {
            responseBodyDigest: createHash("sha256")
              .update(responseBody)
              .digest("hex"),
            responseBodyBytes: Buffer.byteLength(responseBody, "utf8"),
          }),
      ...(responseShape == null ? {} : { responseShape }),
    });
  }
  if (!NoObjectGeneratedError.isInstance(input.error)) throw input.error;
  const rawOutputText =
    typeof input.error.text === "string" ? input.error.text : undefined;
  const rawOutputBytes =
    rawOutputText == null
      ? undefined
      : Buffer.byteLength(rawOutputText, "utf8");
  throw new NativeModelOutputError({
    protocol: input.protocol,
    requestedModel: input.requestedModel,
    reportedModel: input.error.response?.modelId,
    requestId: readOneApiRequestId(input.error.response?.headers),
    usage:
      input.error.usage == null
        ? undefined
        : normalizeAiSdkUsage(input.error.usage),
    ...(rawOutputText == null
      ? {}
      : {
          rawOutputDigest: createHash("sha256")
            .update(rawOutputText)
            .digest("hex"),
        }),
    ...(rawOutputBytes != null && rawOutputBytes <= MAX_INVALID_OUTPUT_BYTES
      ? { rawOutputText }
      : {}),
  });
}
