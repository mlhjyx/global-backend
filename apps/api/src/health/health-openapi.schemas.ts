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
            "migration_revision",
            "schema_digest",
          ],
          properties: {
            attested: { type: "boolean", enum: [true] },
            schema_version: {
              type: "string",
              enum: ["global-runtime-build-attestation/v1"],
            },
            build_sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
            built_at: { type: "string", format: "date-time" },
            artifact_digest: {
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
          required: ["attested", "schema_version"],
          properties: {
            attested: { type: "boolean", enum: [false] },
            schema_version: {
              type: "string",
              enum: ["global-runtime-build-attestation/v1"],
            },
          },
        },
      ],
    },
  },
};

export const RUNTIME_READINESS_RESPONSE_SCHEMA: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "ts", "components"],
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    service: { type: "string", enum: ["global-api"] },
    ts: { type: "string", format: "date-time" },
    components: {
      type: "object",
      additionalProperties: false,
      required: [
        "database",
        "temporal_control_plane",
        "worker",
        "outbox_relay",
        "admission",
      ],
      properties: {
        database: COMPONENT_SCHEMA,
        temporal_control_plane: COMPONENT_SCHEMA,
        worker: COMPONENT_SCHEMA,
        outbox_relay: COMPONENT_SCHEMA,
        admission: COMPONENT_SCHEMA,
      },
    },
  },
};
