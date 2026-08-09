import { createHash } from "node:crypto";
import {
  APICallError,
  jsonSchema,
  NoObjectGeneratedError,
  type LanguageModelUsage,
} from "ai";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRedactedModelResponseShape } from "../types";
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
  return createRedactedModelResponseShape(body, error.cause);
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
