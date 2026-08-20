import { createHash } from 'node:crypto';
import {
  createLocalJWKSet,
  importJWK,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionBudgetGrantVerifier,
  type ExecutionBudgetGrantExpectedScope,
} from './execution-budget-grant.verifier';

const NOW = new Date('2026-08-21T00:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://control-plane.example.test/';
const AUDIENCE = 'global-backend:execution-budget';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const JTI = '33333333-3333-4333-8333-333333333333';
const REQUEST_HASH = 'a'.repeat(64);

const PRIVATE_JWKS = [
  {
    kty: 'RSA',
    n: 'vvU8Nm9m3YvIiOXCZqXomV3u-zjFalIISNGP8ofPvEvAEcgsHUQIYIaCttQGx3jRrHVlQT0jbvMM_D1IlpEDDJjutdcwD559OZ9FHV06i_gEcflKxXCmG4JaElRwFLzIdo2asc62_YjuBDsXTNJQAvyehc38rnz2dhIqmvTPRqQw3Ofaa0A571IbX5U-P1nlGcKT2FffpPqj7l636e3rU2HMM-vvJIEt4N3qEqK4kuYM0B9-DIOJ5WgH9vKize-SzZS8asDf_w0G3966N0ExKIa6aq51B-gO-e0EEhTd2Ag52kAH0u4O69t4OCtsnkcbsUU_3RCauR9qqgTyTGw1Zw',
    e: 'AQAB',
    d: 'RhrKLEHhxdwXlwqiwASQzB1MKzbAYzQSjolBC40ImtxEe0K9z1C2spkvS-ezRW_5qhK_RaAobgcU8VWeXIiIUgujN2b04gcReiIawZkEcXZwS1d2N94PXXIRl0EglLxp6_w4mqaFT7cBitQWzcE4VqBfokfpSDXgVaB9u728ivYBZZYuf26LitZ3bx4xPw3zsTnwNnIAwpsZBW-7IvQAv0rmg6e2VDtvs1KtpTSk9ihlnbRH6r3g-KDCceS6Jq-GfiWpetOcLn2pGpirdDaBNKsUT1mRK8SwrcO_YsrpUJbor-9xTzO0q6TRJPIp8kdOQ_5M-rdUhdJXFrAmgD8MoQ',
    p: '8jTHCoZvqd5aeDdC89YjnZqqkT9QHHqw45-YRab549Y0rOOPZ_TTe4BF7aTv0e0UaW1Xg5tU11ctAZH7TIuDrMa-AnW0bAX3x1QfKAL49AwQNNbdCC1DEAR-NkLW7YiIO3yGjDDSsOzGjMDkWCCJnm5q6xInMlwXUt-ccBQgDGM',
    q: 'ydVKAnAwP8hsWyDw85MkdbnEXSl0z2qDVtZzBalnqy7pY8Qk7FpDNjMdMHsfnpA59LI4k1Q46j2ElDgzmhBwGXbbEk6gXEmAlutcxFSxOESjB4fWsnftbcJw63JvpeDBevPKaJ-K4F2Mt_MB-VVAhs1WgwCTswte3RbP3_nYWC0',
    dp: 'E_QDHbvbgRv_Sf4LdvkCMB6oxJR5rg7xeZ8RNVO_LGTeLAwHKWJC9d6oZB59X0bvsou-dOocAC1_WKzFDhZEP7yTtLIrreaD9hjZBDvSdJB12VSGGwFXj_8-wouZFzJzPqtQjkYLZWXsKXZOmW_8xl-EUV9KeVya00n2okkWJs8',
    dq: 'wILOWtEDVHMo1yruaIWaqyeLYojeP9CKgdN-VpIkraTLPDukNERMA3BxkQJ_QFC01u7_A5e7ycDvqiiJH5Q6OC-j-SxBzITXQBwymZlmiBL_pXktkYDOWHi0F_9I-uEL6uiJ0Y0Le8H_LJ1-7oEgUPOeZsmwF4Dq9NqDYFEAx-k',
    qi: 'JeyddS0tJ77kpl0CX3Ll9RiJLjaT3OZ5DHH4Pw1j9uNMrmZCbFt8vnqq2XMIwm8fDfctX4gf32IAMEY9P_qwya_UeqHoTPHcksDxMDndJfo4NjZZ-6tu7IvnubZw3G1aZzCn4WhjQTAbU0X5BCogISk0hrVYS-0cD6_XXhmYV00',
    alg: 'RS256',
    kid: 'execution-rs256-1',
    use: 'sig',
  },
  {
    kty: 'EC',
    x: 'RlAKnjNRkDLUtlfnTfa-PEqUIqRKwc9wqeL_jYz-l7s',
    y: 'mEe-HjWcVujdmIJJc8Dyu4SQf1JGccAAnv2_uMOj-f4',
    crv: 'P-256',
    d: 'WRRQcLrRvsQguZtooDJ6t3J-rcSfYKZjJzbnf0VdVtQ',
    alg: 'ES256',
    kid: 'execution-es256-1',
    use: 'sig',
  },
  {
    kty: 'OKP',
    crv: 'Ed25519',
    d: 'a5_2DEadoa2WDFA9ZVATuY_lqfAWjGPPzKtWvtgi9lc',
    x: 'kuAsB988j8cNLQPtt9UNTAOFwSvxpSJbNQ89xtCLoBQ',
    alg: 'EdDSA',
    kid: 'execution-eddsa-1',
    use: 'sig',
  },
] as const satisfies readonly JWK[];

const PUBLIC_JWKS = PRIVATE_JWKS.map((key) => {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicKey } = key;
  return publicKey;
});

const EXPECTED_SCOPE: ExecutionBudgetGrantExpectedScope = {
  authorityKind: 'WORKSPACE_GRANT',
  purpose: 'icp.design',
  workspaceId: WORKSPACE_ID,
  subjectType: 'company',
  subjectId: COMPANY_ID,
  requestSha256: REQUEST_HASH,
};

const TEST_ENV = {
  APP_ENVIRONMENT: 'test',
  NODE_ENV: 'test',
  EXECUTION_BUDGET_GRANT_JWKS_URI:
    'https://control-plane.example.test/.well-known/execution-budget-jwks.json',
  EXECUTION_BUDGET_GRANT_ISSUER: ISSUER,
  EXECUTION_BUDGET_GRANT_AUDIENCE: AUDIENCE,
  EXECUTION_BUDGET_GRANT_ALGORITHMS: 'RS256,ES256,EdDSA',
};

const signingKeys = new Map<string, KeyLike | Uint8Array>();

beforeAll(async () => {
  for (const jwk of PRIVATE_JWKS) {
    signingKeys.set(jwk.alg, await importJWK(jwk, jwk.alg));
  }
});

interface TokenOptions {
  algorithm?: 'RS256' | 'ES256' | 'EdDSA';
  audience?: string | string[];
  issuer?: string;
  kid?: string | null;
  typ?: string;
  issuedAt?: number;
  notBefore?: number;
  expiresAt?: number;
  claims?: Record<string, unknown>;
}

async function signedToken(options: TokenOptions = {}): Promise<string> {
  const algorithm = options.algorithm ?? 'RS256';
  const fixture = PRIVATE_JWKS.find((key) => key.alg === algorithm)!;
  const header = {
    alg: algorithm,
    typ: options.typ ?? 'execution-budget-grant+jwt',
    ...(options.kid === null ? {} : { kid: options.kid ?? fixture.kid }),
  };
  return new SignJWT({
    schema_version: 'execution-budget-grant/v1',
    authority_kind: 'WORKSPACE_GRANT',
    purpose: 'icp.design',
    workspace_id: WORKSPACE_ID,
    subject_type: 'company',
    subject_id: COMPANY_ID,
    request_sha256: REQUEST_HASH,
    currency: 'USD',
    unit: 'microusd',
    cap_microusd: '5000000',
    ...options.claims,
  })
    .setProtectedHeader(header)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setJti(JTI)
    .setIssuedAt(options.issuedAt ?? NOW_SECONDS)
    .setNotBefore(options.notBefore ?? NOW_SECONDS)
    .setExpirationTime(options.expiresAt ?? NOW_SECONDS + 300)
    .sign(signingKeys.get(algorithm)!);
}

function verifier(
  env: NodeJS.ProcessEnv = TEST_ENV,
  keyResolver = createLocalJWKSet({ keys: PUBLIC_JWKS }),
): ExecutionBudgetGrantVerifier {
  return new ExecutionBudgetGrantVerifier(env, {
    keyResolver,
    now: () => NOW,
  });
}

describe('ExecutionBudgetGrantVerifier', () => {
  it.each(['RS256', 'ES256', 'EdDSA'] as const)(
    'verifies a valid deterministic %s workspace grant into a fresh immutable claim',
    async (algorithm) => {
      const compactJws = await signedToken({ algorithm });

      const authority = await verifier().verify(compactJws, EXPECTED_SCOPE);

      expect(authority).toEqual({
        schemaVersion: 'execution-budget-grant/v1',
        authorityKind: 'WORKSPACE_GRANT',
        issuer: ISSUER,
        audience: AUDIENCE,
        jti: JTI,
        purpose: 'icp.design',
        workspaceId: WORKSPACE_ID,
        subjectType: 'company',
        subjectId: COMPANY_ID,
        requestSha256: REQUEST_HASH,
        scheduleId: null,
        currency: 'USD',
        unit: 'microusd',
        capMicrousd: 5_000_000n,
        capPerRunMicrousd: null,
        campaignCapMicrousd: null,
        maxRuns: null,
        tokenSha256: createHash('sha256').update(compactJws).digest('hex'),
        issuedAt: NOW,
        notBefore: NOW,
        expiresAt: new Date(NOW.getTime() + 300_000),
      });
      expect(Object.isFrozen(authority)).toBe(true);
      expect(
        JSON.stringify(authority, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ).not.toContain(compactJws);
    },
  );

  it('rejects an unsigned none token before key resolution', async () => {
    const keyResolver = vi.fn();
    const header = Buffer.from(
      JSON.stringify({
        alg: 'none',
        kid: 'execution-none-1',
        typ: 'execution-budget-grant+jwt',
      }),
    ).toString('base64url');
    const payload = Buffer.from('{}').toString('base64url');

    await expect(
      verifier(TEST_ENV, keyResolver as never).verify(
        `${header}.${payload}.`,
        EXPECTED_SCOPE,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it('rejects an HS256 token before key resolution', async () => {
    const keyResolver = vi.fn();
    const compactJws = await new SignJWT({})
      .setProtectedHeader({
        alg: 'HS256',
        kid: 'execution-hs256-1',
        typ: 'execution-budget-grant+jwt',
      })
      .sign(new TextEncoder().encode('test-only-symmetric-secret'));

    await expect(
      verifier(TEST_ENV, keyResolver as never).verify(
        compactJws,
        EXPECTED_SCOPE,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it.each([
    ['missing kid', { kid: null }],
    ['wrong typ', { typ: 'JWT' }],
  ] as const)('rejects a protected header with %s', async (_name, options) => {
    await expect(
      verifier().verify(await signedToken(options), EXPECTED_SCOPE),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
  });

  it.each([
    ['wrong fixed audience', { audience: 'global-backend:identity' }],
    ['an audience array', { audience: [AUDIENCE, 'global-backend:identity'] }],
    ['wrong issuer', { issuer: 'https://attacker.example.test/' }],
  ] as const)('rejects a signed token with %s', async (_name, options) => {
    await expect(
      verifier().verify(await signedToken(options), EXPECTED_SCOPE),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
  });

  it.each([
    ['a TTL over 300 seconds', { expiresAt: NOW_SECONDS + 301 }, 'EXECUTION_BUDGET_GRANT_INVALID'],
    ['an iat beyond clock tolerance', { issuedAt: NOW_SECONDS + 61, notBefore: NOW_SECONDS }, 'EXECUTION_BUDGET_GRANT_INVALID'],
    ['an expired exp', { issuedAt: NOW_SECONDS - 400, notBefore: NOW_SECONDS - 400, expiresAt: NOW_SECONDS - 61 }, 'EXECUTION_BUDGET_GRANT_EXPIRED'],
  ] as const)(
    'rejects a signed token with %s',
    async (_name, options, code) => {
      await expect(
        verifier().verify(await signedToken(options), EXPECTED_SCOPE),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([
    ['workspace', { workspaceId: '44444444-4444-4444-8444-444444444444' }],
    ['purpose', { purpose: 'icp.query_plan' as const }],
    ['subject type', { subjectType: 'icp' }],
    ['subject id', { subjectId: '55555555-5555-4555-8555-555555555555' }],
    ['request hash', { requestSha256: 'b'.repeat(64) }],
  ] as const)('rejects a verified grant with mismatched %s scope', async (_name, scope) => {
    await expect(
      verifier().verify(await signedToken(), { ...EXPECTED_SCOPE, ...scope }),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
  });

  it('rejects a compact JWS over 16 KiB before key resolution', async () => {
    const keyResolver = vi.fn();
    const oversized = `${'a'.repeat(16 * 1024 + 1)}.e30.signature`;

    await expect(
      verifier(TEST_ENV, keyResolver as never).verify(
        oversized,
        EXPECTED_SCOPE,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it('never exposes the compact JWS through errors or logging', async () => {
    const compactJws = await signedToken();
    const observedLogs: unknown[][] = [];
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
        observedLogs.push(values);
      }),
    );
    const unavailable = verifier(TEST_ENV, async () => {
      throw new TypeError(`remote failure for ${compactJws}`);
    });

    const error = await unavailable
      .verify(compactJws, EXPECTED_SCOPE)
      .catch((caught: unknown) => caught);

    for (const spy of spies) spy.mockRestore();
    expect(error).toMatchObject({
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
    expect(JSON.stringify(error)).not.toContain(compactJws);
    expect(JSON.stringify(observedLogs)).not.toContain(compactJws);
  });

  it('fails closed when deployment configures an arbitrary audience', async () => {
    const unavailable = verifier({
      ...TEST_ENV,
      EXECUTION_BUDGET_GRANT_AUDIENCE: 'global-backend:identity',
    });

    await expect(
      unavailable.verify(await signedToken(), EXPECTED_SCOPE),
    ).rejects.toMatchObject({
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
  });
});
