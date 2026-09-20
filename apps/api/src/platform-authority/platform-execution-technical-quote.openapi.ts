import type { PlatformAuthorityCanonicalSchemaV1 } from "@global/contracts/platform-authority";
import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
} from "@global/contracts/platform-authority";

type CanonicalField = PlatformAuthorityCanonicalSchemaV1["fields"][number];
type OpenApiSchema = Readonly<Record<string, unknown>>;

function fieldSchema(field: CanonicalField): OpenApiSchema {
  switch (field.kind) {
    case "exact":
      return Object.freeze({ type: "string", enum: [field.value] });
    case "decimal":
      return Object.freeze({
        type: "string",
        pattern: "^(?:0|[1-9][0-9]*)$",
      });
    case "sha256":
      return Object.freeze({ type: "string", pattern: "^[0-9a-f]{64}$" });
    case "lowercase-uuid":
      return Object.freeze({
        type: "string",
        format: "uuid",
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      });
    case "text":
      return Object.freeze({ type: "string" });
  }
}

function canonicalObjectSchema(
  schema: PlatformAuthorityCanonicalSchemaV1,
): OpenApiSchema {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: schema.fields.map((field) => field.name),
    properties: Object.freeze(
      Object.fromEntries(
        schema.fields.map((field) => [field.name, fieldSchema(field)]),
      ),
    ),
  });
}

export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_OPENAPI_SCHEMA =
  canonicalObjectSchema(PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1);

export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_RESPONSE_OPENAPI_SCHEMA =
  canonicalObjectSchema(PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1);

export function platformTechnicalQuoteErrorSchema(
  codes: readonly string[],
): OpenApiSchema {
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
          code: { type: "string", enum: [...codes] },
          message: { type: "string" },
        },
      },
    },
  };
}
