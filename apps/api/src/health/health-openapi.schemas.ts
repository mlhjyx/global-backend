import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";

const COMPONENT_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok", "failed", "not_proven"] },
    code: { type: "string" },
  },
};

export const LIVE_HEALTH_RESPONSE_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "ts"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    service: { type: "string", enum: ["global-api"] },
    ts: { type: "string", format: "date-time" },
  },
};

export const BUILD_HEALTH_RESPONSE_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "build"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    service: { type: "string", enum: ["global-api"] },
    build: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "attested",
            "schema_version",
            "build_sha",
            "built_at",
            "artifact_digest",
            "artifact_manifest_digest",
            "sbom_digest",
            "source_tree_digest",
            "renderer_digest",
            "migration_revision",
            "schema_digest",
            "image_digest",
          ],
          properties: {
            attested: { type: "boolean", enum: [true] },
            schema_version: {
              type: "string",
              enum: ["global-runtime-release-identity/v1"],
            },
            build_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
            built_at: { type: "string", format: "date-time" },
            artifact_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            artifact_manifest_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            sbom_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            source_tree_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            renderer_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            image_digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
            migration_revision: { type: "string" },
            schema_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["attested", "schema_version", "code"],
          properties: {
            attested: { type: "boolean", enum: [false] },
            schema_version: {
              type: "string",
              enum: ["global-runtime-release-identity/v1"],
            },
            code: { type: "string" },
          },
        },
      ],
    },
  },
};

export const RUNTIME_READINESS_RESPONSE_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "ts", "components", "capabilities"],
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    service: { type: "string", enum: ["global-api"] },
    ts: { type: "string", format: "date-time" },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "execution_budget_jwks",
        "workspace_budget_authority",
        "platform_budget_authority",
      ],
      properties: {
        execution_budget_jwks: COMPONENT_SCHEMA,
        workspace_budget_authority: COMPONENT_SCHEMA,
        platform_budget_authority: COMPONENT_SCHEMA,
      },
    },
    components: {
      type: "object",
      additionalProperties: false,
      required: [
        "database",
        "migration",
        "temporal_control_plane",
        "worker",
        "outbox_relay",
        "api_runtime",
        "storage",
        "redis",
        "model_gateway",
        "renderer",
        "browser",
        "budget_grant_verification",
        "auth_jwks",
        "admission",
      ],
      properties: {
        database: COMPONENT_SCHEMA,
        migration: COMPONENT_SCHEMA,
        temporal_control_plane: COMPONENT_SCHEMA,
        worker: COMPONENT_SCHEMA,
        outbox_relay: COMPONENT_SCHEMA,
        api_runtime: COMPONENT_SCHEMA,
        storage: COMPONENT_SCHEMA,
        redis: COMPONENT_SCHEMA,
        model_gateway: COMPONENT_SCHEMA,
        renderer: COMPONENT_SCHEMA,
        browser: COMPONENT_SCHEMA,
        budget_grant_verification: COMPONENT_SCHEMA,
        auth_jwks: COMPONENT_SCHEMA,
        admission: COMPONENT_SCHEMA,
      },
    },
  },
};
