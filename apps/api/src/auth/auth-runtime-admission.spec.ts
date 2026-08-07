import { describe, expect, it } from 'vitest';
import { assertServingAdmission, resolveAuthRuntimeAdmission } from './auth-runtime-admission';

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
        API_BIND_HOST: '127.0.0.1',
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

  it.each(['pilot', 'production'] as const)('%s rejects non-loopback bind admission', (stage) => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.20']) {
      expect(() =>
        resolveAuthRuntimeAdmission({
          DEPLOYMENT_STAGE: stage,
          NODE_ENV: 'production',
          API_BIND_HOST: host,
          AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
          ...JWKS,
        }),
      ).toThrow('API_BIND_HOST');
    }
  });

  it.each([['AUTH_JWKS_URI'], ['AUTH_ISSUER'], ['AUTH_AUDIENCE'], ['AUTH_ROLE_SCOPE_MAP']])(
    'pilot rejects missing %s',
    (missing) => {
      const env: Record<string, string> = {
        DEPLOYMENT_STAGE: 'pilot',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
        ...JWKS,
      };
      delete env[missing];

      expect(() => resolveAuthRuntimeAdmission(env)).toThrow(missing);
    },
  );

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

  it.each(['', ' production ', 'staging'])('rejects an invalid explicit DEPLOYMENT_STAGE %j', (stage) => {
    expect(() => resolveAuthRuntimeAdmission({ DEPLOYMENT_STAGE: stage }, ['node', 'main.js', '--export-openapi'])).toThrow(
      'DEPLOYMENT_STAGE',
    );
  });

  it('treats NODE_ENV=production as the production floor when DEPLOYMENT_STAGE is omitted', () => {
    const admission = resolveAuthRuntimeAdmission({
      NODE_ENV: 'production',
      API_BIND_HOST: '127.0.0.1',
      AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
      ...JWKS,
    });

    expect(admission.stage).toBe('production');
    expect(admission.verifierKind).toBe('jwks');
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
    [{ API_BIND_HOST: '::', AUTH_ALLOW_DEV_TOKENS: 'true' }, 'API_BIND_HOST'],
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

  it.each([
    [{ AUTH_JWKS_URI: JWKS.AUTH_JWKS_URI }, 'AUTH_ISSUER'],
    [{ ...JWKS, AUTH_JWKS_URI: 'http://identity.example.test/jwks' }, 'HTTPS'],
    [{ ...JWKS, AUTH_CLOCK_SKEW_S: '301' }, 'AUTH_CLOCK_SKEW_S'],
    [{ ...JWKS, AUTH_WORKSPACE_CLAIM: 'not a claim' }, 'AUTH_WORKSPACE_CLAIM'],
  ])('rejects malformed or partial development JWKS configuration %o', (jwks, expected) => {
    expect(() =>
      resolveAuthRuntimeAdmission({
        DEPLOYMENT_STAGE: 'development',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ROLE_SCOPE_MAP: ROLE_SCOPE_MAP,
        ...jwks,
      }),
    ).toThrow(expected);
  });

  it('OpenAPI export uses a rejecting verifier and does not create a serving admission bypass', () => {
    const admission = resolveAuthRuntimeAdmission({}, ['node', 'main.js', '--export-openapi']);

    expect(admission).toMatchObject({
      stage: 'development',
      verifierKind: 'disabled',
      bindHost: '127.0.0.1',
      allowListen: false,
    });
    expect(() => assertServingAdmission(admission)).toThrow(/cannot open/u);
  });
});
