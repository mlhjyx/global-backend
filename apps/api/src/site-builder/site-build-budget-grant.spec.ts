import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertBudgetGrantConsumable,
  isBudgetGrantExpiredStorageError,
  SiteBuildBudgetGrantError,
  SiteBuildBudgetGrantVerifier,
} from './site-build-budget-grant';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const requestSha256 = 'a'.repeat(64);
const now = new Date('2026-08-16T00:00:00.000Z');
let privateKey: CryptoKey;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

async function token(overrides: Record<string, unknown> = {}, typ = 'site-build-budget-grant+jwt') {
  return new SignJWT({
    schema_version: 'site-builder-budget-grant/v1',
    purpose: 'site_builder.build_run',
    operation: 'refurbish',
    workspace_id: workspaceId,
    site_id: siteId,
    request_sha256: requestSha256,
    currency: 'USD',
    unit: 'microusd',
    cap_microusd: '5000000',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'budget-key-1', typ })
    .setIssuer('https://saas.example.test')
    .setAudience('global-backend:site-builder-budget')
    .setJti('33333333-3333-4333-8333-333333333333')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setNotBefore(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(privateKey);
}

async function asymmetricToken(
  algorithm: 'RS256' | 'ES256' | 'EdDSA',
  signingKey: CryptoKey,
  overrides: Record<string, unknown> = {},
  options: { kid?: string; audience?: string | string[] } = {},
) {
  return new SignJWT({
    schema_version: 'site-builder-budget-grant/v1',
    purpose: 'site_builder.build_run',
    operation: 'refurbish',
    workspace_id: workspaceId,
    site_id: siteId,
    request_sha256: requestSha256,
    currency: 'USD',
    unit: 'microusd',
    cap_microusd: '5000000',
    ...overrides,
  })
    .setProtectedHeader({
      alg: algorithm,
      ...(options.kid === undefined ? { kid: 'budget-key-asymmetric' } : options.kid ? { kid: options.kid } : {}),
      typ: 'site-build-budget-grant+jwt',
    })
    .setIssuer('https://saas.example.test')
    .setAudience(
      options.audience ?? 'global-backend:site-builder-budget',
    )
    .setJti('33333333-3333-4333-8333-333333333333')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setNotBefore(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(signingKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keyResolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'budget-key-1', alg: 'RS256' }] });
});

function verifier() {
  return new SiteBuildBudgetGrantVerifier(
    {
      SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'https://saas.example.test/.well-known/jwks.json',
      SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
      SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
      SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
    },
    { keyResolver, now: () => now },
  );
}

describe('SiteBuildBudgetGrantVerifier', () => {
  it('stays constructible but unavailable when trust configuration is absent', async () => {
    let contributor: (() => unknown) | undefined;
    const register = vi.fn((_name, callback) => {
      contributor = callback;
      return vi.fn();
    });
    const unavailable = new SiteBuildBudgetGrantVerifier(
      {},
      {},
      { register } as never,
    );

    expect(register).toHaveBeenCalledWith(
      'budget_grant_verification',
      expect.any(Function),
    );
    await expect(Promise.resolve(contributor?.())).resolves.toEqual({
      status: 'failed',
      code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
    });
    const error = await unavailable.verify(undefined, {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' });
    expect((error as SiteBuildBudgetGrantError).getStatus()).toBe(503);
  });

  it('rejects non-HTTPS trust URLs in production without performing network I/O', async () => {
    const key = vi.fn();
    const unavailable = new SiteBuildBudgetGrantVerifier(
      {
        APP_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'http://saas.example.test/jwks',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'http://saas.example.test',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { keyResolver: key as never },
    );
    const error = await unavailable
      .verify(await token(), { workspaceId, siteId, operation: 'refurbish', requestSha256 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' });
    expect(key).not.toHaveBeenCalled();
  });

  it('allows HTTP trust roots only for development loopback', async () => {
    const unregister = vi.fn();
    let contributor: (() => unknown) | undefined;
    const register = vi.fn((_name, callback) => {
      contributor = callback;
      return unregister;
    });
    const available = new SiteBuildBudgetGrantVerifier(
      {
        APP_ENVIRONMENT: 'development',
        SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'http://127.0.0.1:3010/jwks',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'http://localhost:3010',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { keyResolver },
      { register } as never,
    );
    expect(register).toHaveBeenCalledOnce();
    await expect(Promise.resolve(contributor?.())).resolves.toEqual({ status: 'ok' });
    available.onModuleDestroy();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('keeps readiness closed when the configured remote JWKS trust root is unreachable', async () => {
    let contributor: (() => unknown) | undefined;
    const verifier = new SiteBuildBudgetGrantVerifier(
      {
        APP_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'https://saas.example.test/.well-known/jwks.json',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { fetcher: vi.fn(async () => { throw new Error('jwks offline'); }) },
      { register: vi.fn((_name, callback) => { contributor = callback; return vi.fn(); }) } as never,
    );

    await expect(Promise.resolve(contributor?.())).resolves.toEqual({
      status: 'failed',
      code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
    });
    verifier.onModuleDestroy();
  });

  it('verifies and normalizes a request-bound one-time grant without retaining the token', async () => {
    const raw = await token();
    const grant = await verifier().verify(raw, {
      workspaceId,
      siteId,
      operation: 'refurbish',
      requestSha256,
    });

    expect(grant).toMatchObject({
      issuer: 'https://saas.example.test',
      audience: 'global-backend:site-builder-budget',
      jti: '33333333-3333-4333-8333-333333333333',
      workspaceId,
      siteId,
      operation: 'refurbish',
      capMicrousd: 5_000_000n,
      tokenSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.keys(grant)).not.toContain('rawToken');
  });

  it('accepts the PostgreSQL BIGINT maximum without narrowing it to a JS number', async () => {
    await expect(
      verifier().verify(
        await token({ cap_microusd: '9223372036854775807' }),
        { workspaceId, siteId, operation: 'refurbish', requestSha256 },
      ),
    ).resolves.toMatchObject({
      capMicrousd: 9_223_372_036_854_775_807n,
    });
  });

  it.each(['ES256', 'EdDSA'] as const)(
    'accepts a valid %s Grant through the same verifier contract',
    async (algorithm) => {
      const pair = await generateKeyPair(algorithm);
      const jwk = await exportJWK(pair.publicKey);
      const resolver = createLocalJWKSet({
        keys: [{ ...jwk, kid: 'budget-key-asymmetric', alg: algorithm }],
      });
      const algorithmVerifier = new SiteBuildBudgetGrantVerifier(
        {
          SITE_BUILD_BUDGET_GRANT_JWKS_URI:
            'https://saas.example.test/.well-known/jwks.json',
          SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
          SITE_BUILD_BUDGET_GRANT_AUDIENCE:
            'global-backend:site-builder-budget',
          SITE_BUILD_BUDGET_GRANT_ALGORITHMS: algorithm,
        },
        { keyResolver: resolver, now: () => now },
      );

      await expect(
        algorithmVerifier.verify(
          await asymmetricToken(algorithm, pair.privateKey),
          { workspaceId, siteId, operation: 'refurbish', requestSha256 },
        ),
      ).resolves.toMatchObject({ operation: 'refurbish', workspaceId });
    },
  );

  it('rejects none, HS, missing kid, identity audience substitution and audience arrays', async () => {
    const noneHeader = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'site-build-budget-grant+jwt', kid: 'none' }),
    ).toString('base64url');
    const nonePayload = Buffer.from('{}').toString('base64url');
    await expect(
      verifier().verify(`${noneHeader}.${nonePayload}.`, {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });

    const secret = new TextEncoder().encode('not-a-product-asymmetric-key');
    const hs = await new SignJWT({})
      .setProtectedHeader({
        alg: 'HS256',
        kid: 'symmetric',
        typ: 'site-build-budget-grant+jwt',
      })
      .sign(secret);
    await expect(
      verifier().verify(hs, {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });

    await expect(
      verifier().verify(
        await asymmetricToken('RS256', privateKey, {}, { kid: '' }),
        { workspaceId, siteId, operation: 'refurbish', requestSha256 },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
    await expect(
      verifier().verify(
        await asymmetricToken('RS256', privateKey, {}, {
          kid: 'budget-key-1',
          audience: 'global-backend:identity',
        }),
        { workspaceId, siteId, operation: 'refurbish', requestSha256 },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
    await expect(
      verifier().verify(
        await asymmetricToken('RS256', privateKey, {}, {
          kid: 'budget-key-1',
          audience: ['global-backend:site-builder-budget', 'global-backend:identity'],
        }),
        { workspaceId, siteId, operation: 'refurbish', requestSha256 },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
  });

  it('fails closed when deployment attempts to configure a different audience', async () => {
    const unavailable = new SiteBuildBudgetGrantVerifier(
      {
        SITE_BUILD_BUDGET_GRANT_JWKS_URI:
          'https://saas.example.test/.well-known/jwks.json',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:identity',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { keyResolver, now: () => now },
    );
    await expect(
      unavailable.verify(await token(), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({
      code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
    });
  });

  it.each([
    ['', 'BUDGET_GRANT_REQUIRED'],
    ['not-a-jws', 'BUDGET_GRANT_INVALID'],
  ])('rejects %j with a stable public error', async (raw, code) => {
    await expect(
      verifier().verify(raw, { workspaceId, siteId, operation: 'refurbish', requestSha256 }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects a valid signature with a mismatched request scope', async () => {
    await expect(
      verifier().verify(await token(), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_SCOPE_MISMATCH' });
  });

  it('rejects unsupported typ and a non-canonical money claim', async () => {
    await expect(
      verifier().verify(await token({}, 'JWT'), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toBeInstanceOf(SiteBuildBudgetGrantError);
    await expect(
      verifier().verify(await token({ cap_microusd: '05000000' }), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
  });

  it('classifies remote trust lookup failures as unavailable without echoing the JWS', async () => {
    const remoteFailure = new SiteBuildBudgetGrantVerifier(
      {
        SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'https://saas.example.test/.well-known/jwks.json',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      {
        keyResolver: async () => {
          throw new TypeError('remote JWKS unavailable');
        },
        now: () => now,
      },
    );
    const raw = await token();
    let error: unknown;
    try {
      await remoteFailure.verify(raw, {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' });
    expect((error as SiteBuildBudgetGrantError).getStatus()).toBe(503);
    expect(JSON.stringify(error)).not.toContain(raw);
  });

  it('rejects invalid lifetime, site binding and BIGINT overflow claims', async () => {
    await expect(
      verifier().verify(await token({ site_id: undefined }), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
    await expect(
      verifier().verify(
        await token({ operation: 'intake', site_id: siteId }),
        { workspaceId, operation: 'intake', requestSha256 },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });
    await expect(
      verifier().verify(await token({ cap_microusd: '9223372036854775808' }), {
        workspaceId,
        siteId,
        operation: 'refurbish',
        requestSha256,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_GRANT_INVALID' });

    const lateNow = new Date(now.getTime() + 361_000);
    const expiredVerifier = new SiteBuildBudgetGrantVerifier(
      {
        SITE_BUILD_BUDGET_GRANT_JWKS_URI: 'https://saas.example.test/.well-known/jwks.json',
        SITE_BUILD_BUDGET_GRANT_ISSUER: 'https://saas.example.test',
        SITE_BUILD_BUDGET_GRANT_AUDIENCE: 'global-backend:site-builder-budget',
        SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
      },
      { keyResolver, now: () => lateNow },
    );
    const expired = await expiredVerifier.verify(await token(), {
      workspaceId,
      siteId,
      operation: 'refurbish',
      requestSha256,
    });
    expect(expired.expiredAtVerification).toBe(true);
    expect(() => assertBudgetGrantConsumable(expired, lateNow)).toThrowError(
      expect.objectContaining({ code: 'BUDGET_GRANT_EXPIRED' }),
    );
  });

  it('rechecks storage-time expiry and recognizes the stable database error', async () => {
    const grant = await verifier().verify(await token(), {
      workspaceId,
      siteId,
      operation: 'refurbish',
      requestSha256,
    });

    expect(() => assertBudgetGrantConsumable(grant, now)).not.toThrow();
    expect(() =>
      assertBudgetGrantConsumable(
        grant,
        new Date(grant.expiresAt.getTime() + 60_001),
      ),
    ).toThrowError(expect.objectContaining({ code: 'BUDGET_GRANT_EXPIRED' }));
    expect(
      isBudgetGrantExpiredStorageError(new Error('BUDGET_GRANT_EXPIRED')),
    ).toBe(true);
    expect(isBudgetGrantExpiredStorageError(new Error('other'))).toBe(false);
    expect(isBudgetGrantExpiredStorageError('BUDGET_GRANT_EXPIRED')).toBe(false);
  });
});
