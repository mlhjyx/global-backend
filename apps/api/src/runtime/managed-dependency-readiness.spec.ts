import { describe, expect, it, vi } from 'vitest';
import {
  checkBrowserReadiness,
  checkExecutionBudgetJwksReadiness,
  checkImagePipelineIsolationReadiness,
  checkModelGatewayReadiness,
  checkPlatformBudgetAuthorityReadiness,
  checkRedisReadiness,
  ExecutionBudgetAuthorityReadinessContributors,
  ManagedDependencyReadinessContributors,
  rendererRuntimeIdentity,
} from './managed-dependency-readiness';

const identity = {
  attested: true as const,
  schema_version: 'global-runtime-release-identity/v1' as const,
  build_sha: 'a'.repeat(40),
  built_at: '2026-08-16T00:00:00.000Z',
  image_digest: `sha256:${'b'.repeat(64)}`,
  artifact_digest: `sha256:${'c'.repeat(64)}`,
  artifact_manifest_digest: `sha256:${'d'.repeat(64)}`,
  sbom_digest: `sha256:${'e'.repeat(64)}`,
  source_tree_digest: `sha256:${'f'.repeat(64)}`,
  renderer_digest: `sha256:${'1'.repeat(64)}`,
  migration_revision: '20260816000000_runtime_process_lease',
  schema_digest: `sha256:${'2'.repeat(64)}`,
};

const EXECUTION_BUDGET_ENV = {
  APP_ENVIRONMENT: 'test',
  NODE_ENV: 'test',
  EXECUTION_BUDGET_GRANT_JWKS_URI: 'http://127.0.0.1:3100/.well-known/execution-budget-jwks.json',
  EXECUTION_BUDGET_GRANT_ISSUER: 'http://127.0.0.1:3100/',
  EXECUTION_BUDGET_GRANT_AUDIENCE: 'global-backend:execution-budget',
  EXECUTION_BUDGET_GRANT_ALGORITHMS: 'RS256,ES256,EdDSA',
};

const EXECUTION_ES256_PUBLIC_JWK = {
  kty: 'EC',
  x: 'RlAKnjNRkDLUtlfnTfa-PEqUIqRKwc9wqeL_jYz-l7s',
  y: 'mEe-HjWcVujdmIJJc8Dyu4SQf1JGccAAnv2_uMOj-f4',
  crv: 'P-256',
  alg: 'ES256',
  kid: 'execution-es256-1',
  use: 'sig',
};

describe('managed dependency readiness', () => {
  const platformAuthorityRows = (overrides: Readonly<Record<string, string>> = {}) =>
    ['platform.acquisition', 'platform.intent_watch', 'platform.sanctions'].map((purpose) => ({
      purpose,
      state: overrides[purpose] ?? 'active',
    }));

  function platformSource(rows: readonly object[] | Error) {
    return {
      inspectPlatformAuthorityFreshness: vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { status: 'available' as const, rows };
      }),
    };
  }

  it('rejects an unsafe execution-budget JWKS URL before network dispatch', async () => {
    const unsafe = 'https://user:must-never-leak@control-plane.example.test/jwks?redirect=evil';
    const fetcher = vi.fn();

    const result = await checkExecutionBudgetJwksReadiness(
      {
        APP_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        EXECUTION_BUDGET_GRANT_JWKS_URI: unsafe,
        EXECUTION_BUDGET_GRANT_ISSUER: 'https://control-plane.example.test/',
        EXECUTION_BUDGET_GRANT_AUDIENCE: 'global-backend:execution-budget',
        EXECUTION_BUDGET_GRANT_ALGORITHMS: 'RS256,ES256,EdDSA',
      },
      fetcher,
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(unsafe);
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
  });

  it('probes the configured execution-budget JWKS with a bounded redirect-free request', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [EXECUTION_ES256_PUBLIC_JWK],
          }),
          { status: 200 },
        ),
    );

    const result = await checkExecutionBudgetJwksReadiness(EXECUTION_BUDGET_ENV, fetcher);

    expect(result).toEqual({ status: 'ok' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/.well-known/execution-budget-jwks.json',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it.each([
    [
      'an unusable public key',
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        x: 'x',
        y: 'y',
      },
    ],
    [
      'private key material',
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        d: 'WRRQcLrRvsQguZtooDJ6t3J-rcSfYKZjJzbnf0VdVtQ',
      },
    ],
    [
      'an algorithm-incompatible key',
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        alg: 'RS256',
      },
    ],
  ])('rejects an execution-budget JWKS containing %s', async (_name, key) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: [key] }), { status: 200 }));

    await expect(checkExecutionBudgetJwksReadiness(EXECUTION_BUDGET_ENV, fetcher)).resolves.toEqual({
      status: 'failed',
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
  });

  it('rejects loopback HTTP execution-budget trust roots in production', async () => {
    const fetcher = vi.fn();

    const result = await checkExecutionBudgetJwksReadiness(
      {
        APP_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        EXECUTION_BUDGET_GRANT_JWKS_URI: 'http://127.0.0.1:3100/jwks',
        EXECUTION_BUDGET_GRANT_ISSUER: 'http://127.0.0.1:3100/',
        EXECUTION_BUDGET_GRANT_AUDIENCE: 'global-backend:execution-budget',
        EXECUTION_BUDGET_GRANT_ALGORITHMS: 'RS256,ES256,EdDSA',
      },
      fetcher,
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a missing deployment-owned platform writer without falling back to another principal', async () => {
    await expect(checkPlatformBudgetAuthorityReadiness(undefined)).resolves.toEqual({
      status: 'failed',
      code: 'PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE',
    });
  });

  it('proves all three fixed platform purposes from the bounded repository readback', async () => {
    const source = platformSource(platformAuthorityRows());

    await expect(checkPlatformBudgetAuthorityReadiness(source, new Date('2026-08-21T00:00:00.000Z'))).resolves.toEqual({
      status: 'ok',
    });
    expect(source.inspectPlatformAuthorityFreshness).toHaveBeenCalledWith(new Date('2026-08-21T00:00:00.000Z'));
  });

  it.each([
    ['missing', 'MISSING'],
    ['expired', 'EXPIRED'],
    ['revoked', 'REVOKED'],
    ['exhausted', 'EXHAUSTED'],
    ['not_yet_valid', 'NOT_YET_VALID'],
    ['invalid', 'INVALID'],
  ])('reports %s authority for the exact fixed platform purpose without row details', async (state, codeSuffix) => {
    const source = platformSource(platformAuthorityRows({ 'platform.intent_watch': state }));

    const result = await checkPlatformBudgetAuthorityReadiness(source, new Date('2026-08-21T00:00:00.000Z'));

    expect(result).toEqual({
      status: 'failed',
      code: `PLATFORM_BUDGET_AUTHORITY_PLATFORM_INTENT_WATCH_${codeSuffix}`,
    });
    expect(JSON.stringify(result)).not.toContain('schedule');
    expect(JSON.stringify(result)).not.toContain('authority_id');
  });

  it('bounds malformed rows and raw platform database errors to one stable code', async () => {
    for (const rows of [
      platformAuthorityRows().slice(0, 2),
      new Error('postgresql://writer:must-never-leak@db/platform'),
    ]) {
      const source = platformSource(rows);
      const result = await checkPlatformBudgetAuthorityReadiness(source);
      expect(result).toEqual({
        status: 'failed',
        code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE',
      });
      expect(JSON.stringify(result)).not.toContain('must-never-leak');
    }
  });

  it('registers and unregisters the additive authority contributors without probing on registration', async () => {
    const contributors = new Map<string, () => unknown>();
    const unregister = vi.fn();
    const registry = {
      register: vi.fn((name: string, contributor: () => unknown) => {
        contributors.set(name, contributor);
        return unregister;
      }),
    };
    const managed = new ManagedDependencyReadinessContributors(registry as never, { current: () => identity } as never);
    managed.onModuleInit();
    expect(contributors.has('execution_budget_jwks')).toBe(true);
    expect(contributors.has('platform_budget_authority')).toBe(false);
    expect(unregister).not.toHaveBeenCalled();
    vi.stubEnv('TOOL_RATE_LIMIT_REDIS_URL', '');
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('MODEL_GATEWAY_URL', '');
    vi.stubEnv('MODEL_GATEWAY_KEY', '');
    vi.stubEnv('CHROME_PATH', '/not-an-allowed-browser');
    try {
      await expect(contributors.get('redis')?.()).resolves.toEqual({
        status: 'failed',
        code: 'REDIS_CONFIG_REQUIRED',
      });
      await expect(contributors.get('model_gateway')?.()).resolves.toEqual({
        status: 'failed',
        code: 'MODEL_GATEWAY_CONFIG_REQUIRED',
      });
      await expect(contributors.get('browser')?.()).resolves.toEqual({
        status: 'failed',
        code: 'BROWSER_RUNTIME_CONFIG_INVALID',
      });
      expect(contributors.get('renderer')?.()).toEqual({ status: 'ok' });
    } finally {
      vi.unstubAllEnvs();
    }
    managed.onModuleDestroy();
    expect(unregister).toHaveBeenCalledTimes(contributors.size);

    const platformUnregister = vi.fn();
    const platformRegistry = {
      register: vi.fn((name: string, contributor: () => unknown) => {
        contributors.set(name, contributor);
        return platformUnregister;
      }),
    };
    const platform = new ExecutionBudgetAuthorityReadinessContributors(
      platformRegistry as never,
      {
        inspectPlatformAuthorityFreshness: vi.fn(async () => ({
          status: 'writer_unavailable' as const,
        })),
      } as never,
    );
    platform.onModuleInit();
    expect(platformRegistry.register).toHaveBeenCalledWith('platform_budget_authority', expect.any(Function));
    await expect(contributors.get('platform_budget_authority')?.()).resolves.toEqual({
      status: 'failed',
      code: 'PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE',
    });
    platform.onModuleDestroy();
    expect(platformUnregister).toHaveBeenCalledOnce();
  });

  it('holds Worker readiness when the Linux image decoder limiter is absent', async () => {
    await expect(checkImagePipelineIsolationReadiness('linux', async () => false)).resolves.toEqual({
      status: 'failed',
      code: 'IMAGE_PIPELINE_ISOLATION_UNAVAILABLE',
    });
    await expect(checkImagePipelineIsolationReadiness('linux', async () => true)).resolves.toEqual({ status: 'ok' });
  });

  it('requires an authoritative Redis PING and fails closed when config is missing', async () => {
    await expect(checkRedisReadiness({}, vi.fn())).resolves.toEqual({
      status: 'failed',
      code: 'REDIS_CONFIG_REQUIRED',
    });
    const client = {
      status: 'wait',
      connect: vi.fn(async () => undefined),
      ping: vi.fn(async () => 'PONG'),
      disconnect: vi.fn(),
    };
    await expect(
      checkRedisReadiness(
        { REDIS_URL: 'redis://127.0.0.1:6379' },
        vi.fn(() => client),
      ),
    ).resolves.toEqual({ status: 'ok' });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    'redis://cache.example.test:6379/0',
    'http://127.0.0.1:6379',
    'rediss://cache.example.test:6380/0?family=4',
    'rediss://cache.example.test:6380/0#private-fragment',
    'rediss://cache.example.test:6380/not-a-db',
  ])('rejects an unsafe Redis URL before constructing a client: %s', async (url) => {
    const factory = vi.fn();
    const result = await checkRedisReadiness({ REDIS_URL: url }, factory);
    expect(result).toEqual({
      status: 'failed',
      code: 'REDIS_CONFIG_INVALID',
    });
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it('allows credentials in a TLS URL but never returns them when the probe fails', async () => {
    const configured = 'rediss://user:must-never-leak@cache.example.test:6380/0';
    const factory = vi.fn(() => {
      throw new Error(`failed ${configured}`);
    });
    const result = await checkRedisReadiness({ REDIS_URL: configured }, factory);
    expect(result).toEqual({ status: 'failed', code: 'REDIS_UNAVAILABLE' });
    expect(factory).toHaveBeenCalledWith(configured);
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
  });

  it('uses only the no-generation model-list probe and bounds failures', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      body: { cancel: vi.fn(async () => undefined) },
    }));
    await expect(
      checkModelGatewayReadiness(
        {
          MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
          MODEL_GATEWAY_KEY: 'must-not-be-returned',
        },
        fetcher as never,
      ),
    ).resolves.toEqual({ status: 'ok' });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3001/v1/models', expect.objectContaining({ method: 'GET' }));
    expect(JSON.stringify(await checkModelGatewayReadiness({}, fetcher as never))).not.toContain(
      'must-not-be-returned',
    );
  });

  it('never sends the gateway key to an unsafe probe origin', async () => {
    for (const url of [
      'http://gateway.example.test/v1',
      'https://user:password@gateway.example.test/v1',
      'https://gateway.example.test/v1?redirect=evil',
    ]) {
      const fetcher = vi.fn();
      const result = await checkModelGatewayReadiness(
        {
          MODEL_GATEWAY_URL: url,
          MODEL_GATEWAY_KEY: 'never-dispatch-this-key',
        },
        fetcher,
      );
      expect(result).toEqual({
        status: 'failed',
        code: 'MODEL_GATEWAY_CONFIG_INVALID',
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('never-dispatch-this-key');
    }
  });

  it('derives the renderer identity from the attested renderer component digest', () => {
    expect(rendererRuntimeIdentity(identity)).toBe(`site-renderer@${identity.renderer_digest}`);
    expect(() =>
      rendererRuntimeIdentity({
        attested: false,
        schema_version: 'global-runtime-release-identity/v1',
        code: 'BUILD_ATTESTATION_REQUIRED',
      }),
    ).toThrow('RENDERER_IDENTITY_NOT_PROVEN');
  });

  it('launches only the fixed local Chromium binary with a zero-network data document', async () => {
    const probe = vi.fn(async () => undefined);
    await expect(checkBrowserReadiness({}, probe)).resolves.toEqual({
      status: 'ok',
    });
    expect(probe).toHaveBeenCalledWith(
      '/usr/bin/chromium',
      expect.arrayContaining([
        '--headless=new',
        '--disable-background-networking',
        expect.stringMatching(/^data:text\/html,/),
      ]),
    );
    const unsafe = vi.fn();
    await expect(checkBrowserReadiness({ CHROME_PATH: '/tmp/downloaded-chrome' }, unsafe)).resolves.toEqual({
      status: 'failed',
      code: 'BROWSER_RUNTIME_CONFIG_INVALID',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });
});
