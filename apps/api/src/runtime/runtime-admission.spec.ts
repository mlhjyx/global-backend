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

  it('fails the pilot closed for missing audience or a non-loopback gateway', () => {
    const missingAudience = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
        AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        AUTH_ISSUER: 'https://identity.example.test/',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
        MODEL_GATEWAY_KEY: 'secret',
      },
      attestedBuild,
    );
    expect(missingAudience.admitted).toBe(false);
    expect(missingAudience.checks.auth).toMatchObject({ status: 'failed', code: 'AUTH_CONFIG_INCOMPLETE' });

    const remoteGateway = inspectRuntimeAdmission(
      { mode: 'pilot', bindHost: '127.0.0.1', port: 3000 },
      {
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
