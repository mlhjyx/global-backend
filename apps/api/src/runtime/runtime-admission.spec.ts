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
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
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

  it("admits the controlled pilot only with attested build, JWKS contract, and loopback gateway", () => {
    const result = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
        NODE_ENV: "production",
        DATA_PROCESSOR_JURISDICTION: "EU",
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
      APP_DATABASE_URL:
        "postgresql://app_user:secret@127.0.0.1:5432/global_dev",
      AUTH_JWKS_URI: "https://identity.example.test/.well-known/jwks.json",
      AUTH_ISSUER: "https://identity.example.test/",
      AUTH_AUDIENCE: "global-api",
      AUTH_ROLE_SCOPE_MAP_JSON: '{"viewer":["acquisition:read"]}',
      MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
      MODEL_GATEWAY_KEY: "secret",
      DATA_PROCESSOR_JURISDICTION: "EU",
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

  it("fails the pilot closed for missing audience or a non-loopback gateway", () => {
    const missingAudience = inspectRuntimeAdmission(
      { mode: "pilot", bindHost: "127.0.0.1", port: 3000 },
      {
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
