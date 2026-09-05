import { describe, expect, it } from "vitest";
import { inspectRuntimeAdmission } from "./runtime-admission";

const attestedBuild = {
  attested: true as const,
  schema_version: "global-runtime-release-identity/v1" as const,
  build_sha: "a".repeat(40),
  built_at: "2026-08-10T00:00:00.000Z",
  image_digest: `sha256:${"d".repeat(64)}`,
  artifact_digest: `sha256:${"b".repeat(64)}`,
  artifact_manifest_digest: `sha256:${"d".repeat(64)}`,
  sbom_digest: `sha256:${"e".repeat(64)}`,
  source_tree_digest: `sha256:${"f".repeat(64)}`,
  renderer_digest: `sha256:${"1".repeat(64)}`,
  migration_revision: "20260809010101_runtime_receipts",
  schema_digest: `sha256:${"c".repeat(64)}`,
};

const SETTLEMENT_ENV = {
  MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: `srb1.${"L".repeat(16)}.${"S".repeat(43)}`,
  SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE:
    "/run/secrets/site-build-settlement-keyring",
  SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: '{"schemaVersion":"fixture"}',
};
const PROVIDER_WIRE_ENV = {
  SITE_BUILD_PROVIDER_WIRE_DATABASE_URL:
    "postgresql://site_build_provider_wire_writer:secret@127.0.0.1:5432/global_dev",
};

describe("inspectRuntimeAdmission", () => {
  it("keeps managed development on the same attested auth and gateway path", () => {
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {},
      {
        attested: false,
        schema_version: "global-runtime-release-identity/v1",
        code: "BUILD_ATTESTATION_REQUIRED",
      },
    );
    expect(result.admitted).toBe(false);
    expect(result.checks).toMatchObject({
      build: { status: "failed", code: "BUILD_ATTESTATION_REQUIRED" },
      environment: { status: "failed", code: "MANAGED_NODE_ENV_REQUIRED" },
      auth: { status: "failed", code: "AUTH_CONFIG_INCOMPLETE" },
      gateway: { status: "failed", code: "GATEWAY_CONFIG_INCOMPLETE" },
    });
  });

  it("uses the same verifier and provider checks in development with loopback endpoints", () => {
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "present-but-never-returned",
      },
      attestedBuild,
    );
    expect(result.admitted).toBe(true);
    expect(result.checks).toMatchObject({
      build: { status: "ok" },
      auth: { status: "ok" },
      gateway: { status: "ok" },
    });
  });

  it("requires the dedicated provider-wire login for the Worker but not the API", () => {
    const env = {
      ...SETTLEMENT_ENV,
      ...PROVIDER_WIRE_ENV,
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      PII_ENCRYPTION_KEY: "a".repeat(64),
      APP_DATABASE_URL:
        "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    const withoutWriter = {
      ...env,
      SITE_BUILD_PROVIDER_WIRE_DATABASE_URL: undefined,
    };

    expect(
      inspectRuntimeAdmission(
        { mode: "development", bindHost: "127.0.0.1", port: 3000 },
        withoutWriter,
        attestedBuild,
        "API",
      ).checks.gateway,
    ).toEqual({ status: "ok" });
    expect(
      inspectRuntimeAdmission(
        { mode: "development", bindHost: "127.0.0.1", port: 3000 },
        withoutWriter,
        attestedBuild,
        "WORKER",
      ).checks.gateway,
    ).toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONFIG_REQUIRED",
    });
  });

  it("rejects a provider-wire writer pointed at a different application database", () => {
    const env = {
      ...SETTLEMENT_ENV,
      ...PROVIDER_WIRE_ENV,
      SITE_BUILD_PROVIDER_WIRE_DATABASE_URL:
        "postgresql://site_build_provider_wire_writer:secret@127.0.0.1:5432/other_db",
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      PII_ENCRYPTION_KEY: "a".repeat(64),
      APP_DATABASE_URL:
        "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    expect(
      inspectRuntimeAdmission(
        { mode: "development", bindHost: "127.0.0.1", port: 3000 },
        env,
        attestedBuild,
        "WORKER",
      ).checks.gateway,
    ).toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_TARGET_MISMATCH",
    });
  });

  it("rejects reuse of the model dispatch credential as the readback credential", () => {
    const reused = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        ...PROVIDER_WIRE_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: reused,
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: reused,
      },
      attestedBuild,
      "WORKER",
    );
    expect(result.checks.gateway).toEqual({
      status: "failed",
      code: "GATEWAY_SETTLEMENT_CREDENTIAL_SCOPE_INVALID",
    });
  });

  it("rejects whitespace-padded credential reuse before Header normalization", () => {
    const reused = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        ...PROVIDER_WIRE_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: ` ${reused} `,
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: reused,
      },
      attestedBuild,
      "WORKER",
    );
    expect(result.checks.gateway.status).toBe("failed");
  });

  it("rejects a provider timeout beyond the durable wire-owner window", () => {
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        ...PROVIDER_WIRE_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "secret",
        MODEL_TIMEOUT_MS: "300001",
      },
      attestedBuild,
      "WORKER",
    );
    expect(result.checks.gateway).toEqual({
      status: "failed",
      code: "GATEWAY_TIMEOUT_INVALID",
    });
  });

  it("rejects the Worker-only provider-wire URL in an API runtime", () => {
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        ...PROVIDER_WIRE_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "secret",
      },
      attestedBuild,
      "API",
    );
    expect(result.checks.gateway).toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_SCOPE_INVALID",
    });
  });

  it("rejects the Worker-only provider-wire URL in an Outbox Relay runtime", () => {
    const result = inspectRuntimeAdmission(
      { mode: "development", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        ...PROVIDER_WIRE_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "http://127.0.0.1:3100/.well-known/jwks.json",
        AUTH_ISSUER: "http://127.0.0.1:3100/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "secret",
      },
      attestedBuild,
      "OUTBOX_RELAY",
    );
    expect(result.checks.gateway).toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_SCOPE_INVALID",
    });
  });

  it("admits the controlled pilot only with attested build, JWKS contract, and loopback gateway", () => {
    const result = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        PII_ENCRYPTION_KEY: "a".repeat(64),
        APP_DATABASE_URL:
          "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
        AUTH_JWKS_URI: "https://identity.example.test/.well-known/jwks.json",
        AUTH_ISSUER: "https://identity.example.test/",
        AUTH_AUDIENCE: "global-api",
        AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "present-but-never-returned",
      },
      attestedBuild,
    );
    expect(result).toMatchObject({
      admitted: true,
      checks: {
        build: { status: "ok" },
        auth: { status: "ok" },
        gateway: { status: "ok" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("present-but-never-returned");
  });

  it("fails every managed runtime when the production dependency graph is not active", () => {
    const baseEnv = {
      ...SETTLEMENT_ENV,
      APP_DATABASE_URL:
        "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
      AUTH_JWKS_URI: "https://identity.example.test/.well-known/jwks.json",
      AUTH_ISSUER: "https://identity.example.test/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
      DATA_PROCESSOR_JURISDICTION: "EU",
      PII_ENCRYPTION_KEY: "a".repeat(64),
    };
    const settings = {
      mode: "pilot" as const,
      bindHost: "127.0.0.1",
      port: 3000,
    };

    const wrongNodeEnvironment = inspectRuntimeAdmission(
      settings,
      { ...baseEnv, NODE_ENV: "development" },
      attestedBuild,
    );
    expect(wrongNodeEnvironment.admitted).toBe(false);
    expect(wrongNodeEnvironment.checks.environment).toMatchObject({
      status: "failed",
      code: "MANAGED_NODE_ENV_REQUIRED",
    });

    const missingJurisdiction = inspectRuntimeAdmission(
      settings,
      { ...baseEnv, NODE_ENV: "production", DATA_PROCESSOR_JURISDICTION: "" },
      attestedBuild,
    );
    expect(missingJurisdiction.admitted).toBe(false);
    expect(missingJurisdiction.checks.environment).toEqual({
      status: "failed",
      code: "DATA_PROCESSOR_JURISDICTION_INVALID",
    });

    const invalidJurisdiction = inspectRuntimeAdmission(
      settings,
      {
        ...SETTLEMENT_ENV,
        ...baseEnv,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "CHINA",
      },
      attestedBuild,
    );
    expect(invalidJurisdiction.checks.environment).toEqual({
      status: "failed",
      code: "DATA_PROCESSOR_JURISDICTION_INVALID",
    });
  });

  it("keeps managed admission closed when the PII key is missing or does not decode to AES-256 key material", () => {
    const settings = {
      mode: "development" as const,
      bindHost: "127.0.0.1",
      port: 3000,
    };
    const base = {
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      APP_DATABASE_URL: "postgresql://app_user:secret@127.0.0.1/global_dev",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/jwks",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    for (const value of [undefined, "not-a-32-byte-key"]) {
      const result = inspectRuntimeAdmission(
        settings,
        value === undefined ? base : { ...base, PII_ENCRYPTION_KEY: value },
        attestedBuild,
      );
      expect(result.admitted).toBe(false);
      expect(result.checks).toMatchObject({
        pii: { status: "failed", code: "PII_ENCRYPTION_KEY_INVALID" },
      });
      expect(JSON.stringify(result)).not.toContain("not-a-32-byte-key");
    }
  });

  it("requires the tenant app role URL and never admits an owner-role fallback", () => {
    const settings = {
      mode: "development" as const,
      bindHost: "127.0.0.1",
      port: 3000,
    };
    const base = {
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/jwks",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    expect(
      inspectRuntimeAdmission(settings, base, attestedBuild).checks.database,
    ).toEqual({
      status: "failed",
      code: "APP_DATABASE_URL_REQUIRED",
    });
    expect(
      inspectRuntimeAdmission(
        settings,
        {
          ...base,
          APP_DATABASE_URL: "postgresql://global:owner@127.0.0.1/global_dev",
        },
        attestedBuild,
      ).checks.database,
    ).toEqual({ status: "failed", code: "APP_DATABASE_ROLE_INVALID" });
  });

  it("validates the same bounded role-to-scope policy used by the token verifier", () => {
    const settings = {
      mode: "development" as const,
      bindHost: "127.0.0.1",
      port: 3000,
    };
    const base = {
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      APP_DATABASE_URL: "postgresql://app_user:secret@127.0.0.1/global_dev",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/jwks",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    expect(
      inspectRuntimeAdmission(settings, base, attestedBuild).checks.auth,
    ).toEqual({
      status: "failed",
      code: "AUTH_ROLE_SCOPE_POLICY_INCOMPLETE",
    });
    expect(
      inspectRuntimeAdmission(
        settings,
        { ...base, AUTH_ROLE_SCOPE_MAP_JSON: '{"operator":["unknown:scope"]}' },
        attestedBuild,
      ).checks.auth,
    ).toEqual({ status: "failed", code: "AUTH_ROLE_SCOPE_POLICY_INVALID" });
  });

  it("fails admission when the JWKS verifier itself would be unavailable", () => {
    const settings = {
      mode: "development" as const,
      bindHost: "127.0.0.1",
      port: 3000,
    };
    const base = {
      NODE_ENV: "production",
      DATA_PROCESSOR_JURISDICTION: "EU",
      APP_DATABASE_URL: "postgresql://app_user:secret@127.0.0.1/global_dev",
      AUTH_JWKS_URI: "http://127.0.0.1:3100/jwks",
      AUTH_ISSUER: "http://127.0.0.1:3100/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
    };
    for (const invalidVerifierConfiguration of [
      { AUTH_CLOCK_SKEW_S: "-1" },
      { AUTH_AUDIENCE: " global-api" },
      {
        AUTH_WORKSPACE_CLAIM: "tenant_context",
        AUTH_ROLES_CLAIM: "tenant_context",
      },
    ]) {
      const result = inspectRuntimeAdmission(
        settings,
        { ...base, ...invalidVerifierConfiguration },
        attestedBuild,
      );
      expect(result.admitted).toBe(false);
      expect(result.checks.auth).toEqual({
        status: "failed",
        code: "AUTH_CONFIG_INVALID",
      });
    }
  });

  it("fails the pilot closed for missing audience or a non-loopback gateway", () => {
    const missingAudience = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        AUTH_JWKS_URI: "https://identity.example.test/jwks",
        AUTH_ISSUER: "https://identity.example.test/",
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "secret",
      },
      attestedBuild,
    );
    expect(missingAudience.admitted).toBe(false);
    expect(missingAudience.checks.auth).toMatchObject({
      status: "failed",
      code: "AUTH_CONFIG_INCOMPLETE",
    });

    const blankConfiguration = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        AUTH_JWKS_URI: "https://identity.example.test/jwks",
        AUTH_ISSUER: "https://identity.example.test/",
        AUTH_AUDIENCE: "   ",
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "   ",
      },
      attestedBuild,
    );
    expect(blankConfiguration.admitted).toBe(false);
    expect(blankConfiguration.checks.auth).toMatchObject({
      status: "failed",
      code: "AUTH_CONFIG_INCOMPLETE",
    });
    expect(blankConfiguration.checks.gateway).toMatchObject({
      status: "failed",
      code: "GATEWAY_CONFIG_INCOMPLETE",
    });

    const authUrlWithAmbientCredentials = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        AUTH_JWKS_URI:
          "https://user:password@identity.example.test/jwks?tenant=hidden",
        AUTH_ISSUER: "https://identity.example.test/#fragment",
        AUTH_AUDIENCE: "global-api",
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "secret",
      },
      attestedBuild,
    );
    expect(authUrlWithAmbientCredentials.admitted).toBe(false);
    expect(authUrlWithAmbientCredentials.checks.auth).toMatchObject({
      status: "failed",
      code: "AUTH_CONFIG_INVALID",
    });

    const remoteGateway = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        ...SETTLEMENT_ENV,
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
        AUTH_JWKS_URI: "https://identity.example.test/jwks",
        AUTH_ISSUER: "https://identity.example.test/",
        AUTH_AUDIENCE: "global-api",
        MODEL_GATEWAY_URL: "https://gateway.example.test/v1",
        MODEL_GATEWAY_KEY: "secret",
      },
      attestedBuild,
    );
    expect(remoteGateway.admitted).toBe(false);
    expect(remoteGateway.checks.gateway).toMatchObject({
      status: "failed",
      code: "PILOT_GATEWAY_NOT_LOOPBACK",
    });
  });
});
