import { describe, expect, it } from 'vitest';
import { resolveRuntimeProcessSnapshot } from './runtime-admission';

const SAFE_NON_DEVELOPMENT_ENV = Object.freeze({
  NODE_ENV: 'production',
  API_BIND_HOST: '127.0.0.1',
  CORS_ORIGINS: 'https://app.example.test',
  AUTH_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://identity.example.test',
  MODEL_GATEWAY_URL: 'https://models.example.test/v1',
  MODEL_GATEWAY_KEY: 'test-scoped-key',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
  DATA_PROCESSOR_JURISDICTION: 'EU',
  SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
});

describe('canonical runtime process safety snapshot', () => {
  it.each(['pilot', 'production'] as const)(
    'requires canonical NODE_ENV=production for %s',
    (deploymentStage) => {
      expect(() =>
        resolveRuntimeProcessSnapshot({
          ...SAFE_NON_DEVELOPMENT_ENV,
          deploymentStage,
          DEPLOYMENT_STAGE: deploymentStage,
          NODE_ENV: undefined,
        }),
      ).toThrow(/NODE_ENV.*production/i);
      expect(() =>
        resolveRuntimeProcessSnapshot({
          ...SAFE_NON_DEVELOPMENT_ENV,
          DEPLOYMENT_STAGE: deploymentStage,
          NODE_ENV: 'prodution',
        }),
      ).toThrow(/NODE_ENV/i);
    },
  );

  it.each([
    ['AUTH_JWKS_URI', undefined],
    ['AUTH_ALLOW_DEV_TOKENS', 'true'],
    ['MODEL_GATEWAY_URL', undefined],
    ['MODEL_ALLOW_STUB', 'true'],
    ['S3_ACCESS_KEY', undefined],
    ['S3_SECRET_KEY', undefined],
    ['DATA_PROCESSOR_JURISDICTION', undefined],
    ['SITE_RENDERER_BUILD_ID', undefined],
  ] as const)(
    'rejects pilot before Nest when %s would enable an unsafe development path',
    (name, value) => {
      expect(() =>
        resolveRuntimeProcessSnapshot({
          ...SAFE_NON_DEVELOPMENT_ENV,
          DEPLOYMENT_STAGE: 'pilot',
          [name]: value,
        }),
      ).toThrow(new RegExp(name));
    },
  );

  it('freezes one copied environment and all derived safety decisions', () => {
    const source: Record<string, string | undefined> = {
      DEPLOYMENT_STAGE: 'pilot',
      ...SAFE_NON_DEVELOPMENT_ENV,
    };
    const snapshot = resolveRuntimeProcessSnapshot(source);
    source.AUTH_ISSUER = 'https://attacker.invalid';

    expect(snapshot).toMatchObject({
      deploymentStage: 'pilot',
      environment: {
        AUTH_ISSUER: 'https://identity.example.test',
      },
      safety: {
        auth: { mode: 'jwks' },
        model: { allowStub: false },
        storage: {
          available: true,
          allowUnavailable: false,
          manageVariantAttemptLifecycle: false,
          strictVariantAttemptLifecycle: true,
        },
        processorJurisdiction: 'EU',
        siteRendererBuildIdentity: 'site-renderer@1.0.0+sha.abc123',
        temporal: { connectTimeoutMs: 3_000 },
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.environment)).toBe(true);
    expect(Object.isFrozen(snapshot.safety)).toBe(true);
    expect(Object.isFrozen(snapshot.safety.auth)).toBe(true);
  });

  it('records development fallbacks explicitly without rereading process.env', () => {
    const snapshot = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'development',
      AUTH_ALLOW_DEV_TOKENS: 'true',
    });

    expect(snapshot.safety).toMatchObject({
      auth: { mode: 'development' },
      model: { allowStub: true },
      storage: { available: false, allowUnavailable: true },
      processorJurisdiction: 'EU',
      siteRendererBuildIdentity: 'site-renderer@dev-unpinned',
    });
  });

  it.each([undefined, 'false'] as const)(
    'rejects development without JWKS when AUTH_ALLOW_DEV_TOKENS=%s',
    (allowDevelopmentTokens) => {
      expect(() =>
        resolveRuntimeProcessSnapshot({
          DEPLOYMENT_STAGE: 'development',
          NODE_ENV: 'development',
          AUTH_ALLOW_DEV_TOKENS: allowDevelopmentTokens,
        }),
      ).toThrow(/AUTH_ALLOW_DEV_TOKENS.*true/i);
    },
  );

  it('does not require the dev-token opt-in when development uses JWKS', () => {
    const snapshot = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'development',
      AUTH_JWKS_URI: 'https://identity.example.test/jwks.json',
      AUTH_ISSUER: 'https://identity.example.test',
    });

    expect(snapshot.safety.auth.mode).toBe('jwks');
  });
});
