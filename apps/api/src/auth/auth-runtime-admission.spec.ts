import { describe, expect, it } from 'vitest';
import { resolveAuthRuntimeAdmission } from './auth-runtime-admission';

const ROLE_SCOPE_MAP = JSON.stringify({
  'platform.admin': [
    'acquisition:read',
    'acquisition:write',
    'acquisition:review',
    'acquisition:event:ack',
    'acquisition:label:write',
    'acquisition:identity:review',
    'personal-data:read',
    'compliance:manage',
    'ops:read',
  ],
});

const JWKS = {
  AUTH_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://identity.example.test/',
  AUTH_AUDIENCE: 'growth-api',
};

describe('resolveAuthRuntimeAdmission', () => {
  it.each(['pilot', 'production'] as const)(
    '%s admits only explicit mapping plus complete JWKS issuer/audience/URI',
    (stage) => {
      const admission = resolveAuthRuntimeAdmission({
        DEPLOYMENT_STAGE: stage,
        NODE_ENV: 'production',
        API_BIND_HOST: '0.0.0.0',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
        ...JWKS,
      });

      expect(admission.stage).toBe(stage);
      expect(admission.verifierKind).toBe('jwks');
      expect(admission.jwks).toMatchObject({
        uri: JWKS.AUTH_JWKS_URI,
        issuer: JWKS.AUTH_ISSUER,
        audience: JWKS.AUTH_AUDIENCE,
      });
    },
  );

  it.each([
    ['AUTH_JWKS_URI'],
    ['AUTH_ISSUER'],
    ['AUTH_AUDIENCE'],
    ['AUTH_ROLE_SCOPE_MAP'],
  ])('pilot rejects missing %s', (missing) => {
    const env: Record<string, string> = {
      DEPLOYMENT_STAGE: 'pilot',
      NODE_ENV: 'production',
      API_BIND_HOST: '127.0.0.1',
      AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
      ...JWKS,
    };
    delete env[missing];

    expect(() => resolveAuthRuntimeAdmission(env)).toThrow(missing);
  });

  it('production forbids DevTokenVerifier even when the legacy override is set', () => {
    expect(() =>
      resolveAuthRuntimeAdmission({
        DEPLOYMENT_STAGE: 'production',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ALLOW_DEV_TOKENS: 'true',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
      }),
    ).toThrow(/JWKS|DevTokenVerifier/u);
  });

  it('NODE_ENV=production cannot be downgraded to development', () => {
    expect(() =>
      resolveAuthRuntimeAdmission({
        DEPLOYMENT_STAGE: 'development',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ALLOW_DEV_TOKENS: 'true',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
      }),
    ).toThrow(/downgrade|DEPLOYMENT_STAGE/u);
  });

  it('development admits dev tokens only with the explicit flag, explicit mapping, and loopback bind', () => {
    const admission = resolveAuthRuntimeAdmission({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'development',
      API_BIND_HOST: '127.0.0.1',
      AUTH_ALLOW_DEV_TOKENS: 'true',
      AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
    });

    expect(admission).toMatchObject({
      stage: 'development',
      verifierKind: 'dev',
      bindHost: '127.0.0.1',
    });
  });

  it.each([
    [{ API_BIND_HOST: '0.0.0.0', AUTH_ALLOW_DEV_TOKENS: 'true' }, 'API_BIND_HOST'],
    [{ API_BIND_HOST: '192.168.1.20', AUTH_ALLOW_DEV_TOKENS: 'true' }, 'API_BIND_HOST'],
    [{ API_BIND_HOST: '127.0.0.1' }, 'AUTH_ALLOW_DEV_TOKENS'],
  ])('development rejects unsafe dev-token admission %o', (overrides, expected) => {
    expect(() =>
      resolveAuthRuntimeAdmission({
        DEPLOYMENT_STAGE: 'development',
        NODE_ENV: 'development',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
        ...overrides,
      }),
    ).toThrow(expected);
  });

  it('OpenAPI export uses a rejecting verifier and does not create a serving admission bypass', () => {
    const admission = resolveAuthRuntimeAdmission({}, ['node', 'main.js', '--export-openapi']);

    expect(admission).toMatchObject({
      stage: 'development',
      verifierKind: 'disabled',
      bindHost: '127.0.0.1',
    });
  });
});
