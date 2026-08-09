import { describe, expect, it } from 'vitest';
import { inspectRuntimeAdmission } from './runtime-admission';

const attestedBuild = {
  attested: true as const,
  schema_version: 'global-runtime-build-attestation/v1' as const,
  build_sha: 'a'.repeat(40),
  built_at: '2026-08-10T00:00:00.000Z',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  migration_revision: '20260809010101_runtime_receipts',
  schema_digest: `sha256:${'c'.repeat(64)}`,
};

describe('inspectRuntimeAdmission', () => {
  it('keeps development explicit about optional auth/gateway evidence', () => {
    const result = inspectRuntimeAdmission(
      { mode: 'development', bindHost: '127.0.0.1', port: 3000 },
      {},
      { attested: false, schema_version: 'global-runtime-build-attestation/v1' },
    );
    expect(result.admitted).toBe(true);
    expect(result.checks).toMatchObject({
      build: { status: 'optional' },
      auth: { status: 'optional' },
      gateway: { status: 'optional' },
    });
  });

  it('admits the controlled pilot only with attested build, JWKS contract, and loopback gateway', () => {
    const result = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        NODE_ENV: 'production',
        AUTH_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
        AUTH_ISSUER: 'https://identity.example.test/',
        AUTH_AUDIENCE: 'global-api',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
        MODEL_GATEWAY_KEY: 'present-but-never-returned',
      },
      attestedBuild,
    );
    expect(result).toMatchObject({
      admitted: true,
      checks: {
        build: { status: 'ok' },
        auth: { status: 'ok' },
        gateway: { status: 'ok' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('present-but-never-returned');
  });

  it('fails controlled admission when production switches are misaligned or model stubs are enabled', () => {
    const baseEnv = {
      AUTH_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
      AUTH_ISSUER: 'https://identity.example.test/',
      AUTH_AUDIENCE: 'global-api',
      MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
      MODEL_GATEWAY_KEY: 'secret',
    };
    const settings = { mode: 'pilot' as const, bindHost: '127.0.0.1', port: 3000 };

    const wrongNodeEnvironment = inspectRuntimeAdmission(
      settings,
      { ...baseEnv, NODE_ENV: 'development' },
      attestedBuild,
    );
    expect(wrongNodeEnvironment.admitted).toBe(false);
    expect(wrongNodeEnvironment.checks.environment).toMatchObject({
      status: 'failed',
      code: 'CONTROLLED_NODE_ENV_REQUIRED',
    });

    const stubEnabled = inspectRuntimeAdmission(
      settings,
      { ...baseEnv, NODE_ENV: 'production', MODEL_ALLOW_STUB: 'true' },
      attestedBuild,
    );
    expect(stubEnabled.admitted).toBe(false);
    expect(stubEnabled.checks.gateway).toMatchObject({
      status: 'failed',
      code: 'MODEL_STUB_FORBIDDEN',
    });
  });

  it('fails the pilot closed for missing audience or a non-loopback gateway', () => {
    const missingAudience = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        NODE_ENV: 'production',
        AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        AUTH_ISSUER: 'https://identity.example.test/',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
        MODEL_GATEWAY_KEY: 'secret',
      },
      attestedBuild,
    );
    expect(missingAudience.admitted).toBe(false);
    expect(missingAudience.checks.auth).toMatchObject({ status: 'failed', code: 'AUTH_CONFIG_INCOMPLETE' });

    const blankConfiguration = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        NODE_ENV: 'production',
        AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        AUTH_ISSUER: 'https://identity.example.test/',
        AUTH_AUDIENCE: '   ',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
        MODEL_GATEWAY_KEY: '   ',
      },
      attestedBuild,
    );
    expect(blankConfiguration.admitted).toBe(false);
    expect(blankConfiguration.checks.auth).toMatchObject({
      status: 'failed',
      code: 'AUTH_CONFIG_INCOMPLETE',
    });
    expect(blankConfiguration.checks.gateway).toMatchObject({
      status: 'failed',
      code: 'GATEWAY_CONFIG_INCOMPLETE',
    });

    const authUrlWithAmbientCredentials = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        NODE_ENV: 'production',
        AUTH_JWKS_URI: 'https://user:password@identity.example.test/jwks?tenant=hidden',
        AUTH_ISSUER: 'https://identity.example.test/#fragment',
        AUTH_AUDIENCE: 'global-api',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
        MODEL_GATEWAY_KEY: 'secret',
      },
      attestedBuild,
    );
    expect(authUrlWithAmbientCredentials.admitted).toBe(false);
    expect(authUrlWithAmbientCredentials.checks.auth).toMatchObject({
      status: 'failed',
      code: 'AUTH_CONFIG_INVALID',
    });

    const remoteGateway = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        NODE_ENV: 'production',
        AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        AUTH_ISSUER: 'https://identity.example.test/',
        AUTH_AUDIENCE: 'global-api',
        MODEL_GATEWAY_URL: 'https://gateway.example.test/v1',
        MODEL_GATEWAY_KEY: 'secret',
      },
      attestedBuild,
    );
    expect(remoteGateway.admitted).toBe(false);
    expect(remoteGateway.checks.gateway).toMatchObject({
      status: 'failed',
      code: 'PILOT_GATEWAY_NOT_LOOPBACK',
    });
  });
});
