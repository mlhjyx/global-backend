import { describe, expect, it } from 'vitest';
import { resolveRuntimeProcessSnapshot } from './runtime-admission';

const PILOT_AUTH = Object.freeze({
  DEPLOYMENT_STAGE: 'pilot',
  NODE_ENV: 'production',
  AUTH_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://identity.example.test/',
  AUTH_AUDIENCE: 'global-api',
});

describe('canonical runtime auth admission', () => {
  it('requires the complete JWKS contract outside development', () => {
    for (const missing of [
      'AUTH_JWKS_URI',
      'AUTH_ISSUER',
      'AUTH_AUDIENCE',
    ] as const) {
      const environment: Record<string, string | undefined> = {
        ...PILOT_AUTH,
      };
      delete environment[missing];

      expect(() => resolveRuntimeProcessSnapshot(environment)).toThrow(
        new RegExp(missing),
      );
    }
  });

  it('validates both JWKS URI and issuer as absolute secure identities', () => {
    expect(() =>
      resolveRuntimeProcessSnapshot({
        ...PILOT_AUTH,
        AUTH_ISSUER: 'tenant-issuer',
      }),
    ).toThrow(/AUTH_ISSUER/u);
    expect(() =>
      resolveRuntimeProcessSnapshot({
        ...PILOT_AUTH,
        AUTH_JWKS_URI: 'http://identity.example.test/jwks.json',
      }),
    ).toThrow(/AUTH_JWKS_URI/u);
  });

  it('allows HTTP identity endpoints only on loopback in development', () => {
    expect(
      resolveRuntimeProcessSnapshot({
        DEPLOYMENT_STAGE: 'development',
        NODE_ENV: 'development',
        AUTH_JWKS_URI: 'http://127.0.0.1:4100/jwks.json',
        AUTH_ISSUER: 'http://127.0.0.1:4100/',
        AUTH_AUDIENCE: 'global-api',
      }).safety.auth.mode,
    ).toBe('jwks');

    expect(() =>
      resolveRuntimeProcessSnapshot({
        DEPLOYMENT_STAGE: 'development',
        NODE_ENV: 'development',
        AUTH_JWKS_URI: 'http://identity.example.test/jwks.json',
        AUTH_ISSUER: 'http://identity.example.test/',
        AUTH_AUDIENCE: 'global-api',
      }),
    ).toThrow(/AUTH_JWKS_URI/u);
  });

  it('bounds audience and validates signed claim identifiers', () => {
    expect(() =>
      resolveRuntimeProcessSnapshot({
        ...PILOT_AUTH,
        AUTH_AUDIENCE: 'a'.repeat(513),
      }),
    ).toThrow(/AUTH_AUDIENCE/u);
    expect(() =>
      resolveRuntimeProcessSnapshot({
        ...PILOT_AUTH,
        AUTH_WORKSPACE_CLAIM: 'not a claim',
      }),
    ).toThrow(/AUTH_WORKSPACE_CLAIM/u);
  });
});
