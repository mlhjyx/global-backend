import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION } from "@global/contracts/platform-authority/target-lookup";

export const PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME =
  "platformAuthorityTargetReader" as const;
export const PLATFORM_TARGET_LOOKUP_HTTP_ERRORS = {
  invalid: {
    status: 400,
    code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID",
    message: "platform target lookup request is invalid",
  },
  denied: {
    status: 401,
    code: "PLATFORM_TARGET_READER_DENIED",
    message: "platform target reader authentication failed",
  },
  scope: {
    status: 403,
    code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_SCOPE_MISMATCH",
    message: "platform target lookup scope is forbidden",
  },
  notFound: {
    status: 404,
    code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_NOT_FOUND",
    message: "platform authority target was not found",
  },
  rateLimited: {
    status: 429,
    code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMITED",
    message: "platform target lookup rate limit exceeded",
  },
  unavailable: {
    status: 503,
    code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    message: "platform target lookup is unavailable",
  },
} as const;

const uuid: SchemaObject = {
  type: "string",
  format: "uuid",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const tuple: Record<string, SchemaObject> = {
  target_issuer: {
    type: "string",
    minLength: 1,
    maxLength: 2048,
    format: "uri",
    description:
      "Exact configured Grant issuer mapping; not a caller-selected URL to fetch.",
  },
  target_jti: uuid,
  schedule_id: {
    type: "string",
    enum: [
      "acq-sweep",
      "intent-sweep",
      "sanctions-refresh",
      "patents-cache-refresh",
    ],
  },
  workflow_run_id: uuid,
  nonce: {
    type: "string",
    pattern: "^[0-9a-f]{32}$",
    description:
      "Fresh 128-bit request nonce, echoed only for this observation.",
  },
};
export const PLATFORM_TARGET_LOOKUP_REQUEST_OPENAPI_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(tuple),
  properties: tuple,
};
export const PLATFORM_TARGET_LOOKUP_RESPONSE_OPENAPI_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", ...Object.keys(tuple), "found", "observed_at"],
  properties: {
    schema_version: {
      type: "string",
      enum: [PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION],
    },
    ...tuple,
    found: { type: "boolean", enum: [true] },
    observed_at: { type: "integer", minimum: 0, maximum: 253402300799 },
  },
  description:
    "Synchronous target locator observation only, not a signed proof, authority creation or fence ACK. NOT_FOUND is not proof of global absence.",
};
export function platformTargetLookupErrorSchema(
  kind: keyof typeof PLATFORM_TARGET_LOOKUP_HTTP_ERRORS,
): SchemaObject {
  const error = PLATFORM_TARGET_LOOKUP_HTTP_ERRORS[kind];
  return {
    type: "object",
    additionalProperties: false,
    required: ["error"],
    properties: {
      error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", enum: [error.code] },
          message: { type: "string", enum: [error.message] },
        },
      },
    },
  };
}
