import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type FetchImplementation,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JwksRuntimeConfig } from './auth-runtime-admission';
import { JwksTokenVerifier } from './jwks-token-verifier';

const ISSUER = 'https://identity.example.test/';
const AUDIENCE = 'growth-api';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG: JwksRuntimeConfig = {
  uri: 'https://identity.example.test/.well-known/jwks.json',
  issuer: ISSUER,
  audience: AUDIENCE,
  clockSkewSeconds: 0,
  workspaceClaim: 'workspace_id',
  rolesClaim: 'roles',
};

let privateKey1: CryptoKey;
let privateKey2: CryptoKey;
let verifier: JwksTokenVerifier;

beforeAll(async () => {
  const pair1 = await generateKeyPair('RS256');
  const pair2 = await generateKeyPair('RS256');
  privateKey1 = pair1.privateKey;
  privateKey2 = pair2.privateKey;
  const publicJwk1 = await exportJWK(pair1.publicKey);
  const publicJwk2 = await exportJWK(pair2.publicKey);
  const localJwks = createLocalJWKSet({
    keys: [
      { ...publicJwk1, alg: 'RS256', use: 'sig', kid: 'key-1' },
      { ...publicJwk2, alg: 'RS256', use: 'sig', kid: 'key-2' },
    ],
  });
  verifier = new JwksTokenVerifier(CONFIG, localJwks);
});

function validClaims(): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-123',
    workspace_id: WORKSPACE_ID,
    roles: ['acquisition.reader'],
    nbf: now - 1,
    exp: now + 300,
  };
}

async function signedToken(
  overrides: Record<string, unknown> = {},
  options: { kid?: string | null; privateKey?: CryptoKey } = {},
): Promise<string> {
  const payload = { ...validClaims(), ...overrides };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) delete payload[key];
  }
  const protectedHeader =
    options.kid === null ? { alg: 'RS256' as const } : { alg: 'RS256' as const, kid: options.kid ?? 'key-1' };
  return new SignJWT(payload).setProtectedHeader(protectedHeader).sign(options.privateKey ?? privateKey1);
}

async function expectGenericRejection(token: string, target: JwksTokenVerifier = verifier): Promise<void> {
  const error = await target.verify(token).catch((caught) => caught);
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).getResponse()).toEqual({
    error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('JwksTokenVerifier offline contract', () => {
  it('accepts valid iss/aud/exp/nbf/sub/workspace_id/roles/kid claims', async () => {
    await expect(verifier.verify(await signedToken())).resolves.toEqual({
      userId: 'user-123',
      workspaceId: WORKSPACE_ID,
      roles: ['acquisition.reader'],
    });
  });

  it('accepts same-issuer kid rotation without rebuilding the verifier', async () => {
    await expect(verifier.verify(await signedToken())).resolves.toMatchObject({
      userId: 'user-123',
    });
    await expect(
      verifier.verify(await signedToken({}, { kid: 'key-2', privateKey: privateKey2 })),
    ).resolves.toMatchObject({ userId: 'user-123' });
  });

  it.each([
    ['iss', { iss: 'https://attacker.example.test/' }, {}],
    ['aud', { aud: 'some-other-api' }, {}],
    ['exp', { exp: 1 }, {}],
    ['missing exp', { exp: undefined }, {}],
    ['nbf', { nbf: Math.floor(Date.now() / 1000) + 600 }, {}],
    ['missing nbf', { nbf: undefined }, {}],
    ['sub', { sub: undefined }, {}],
    ['workspace_id', { workspace_id: undefined }, {}],
    ['roles', { roles: undefined }, {}],
    ['kid', {}, { kid: 'unknown-key' }],
    ['missing kid', {}, { kid: null }],
  ] as const)('rejects invalid or missing %s with one generic error', async (_name, claims, options) => {
    await expectGenericRejection(await signedToken(claims, options));
  });

  it.each([
    ['non-UUID workspace', { workspace_id: 'workspace-not-uuid' }],
    ['oversize subject', { sub: 'u'.repeat(257) }],
    ['too many roles', { roles: Array.from({ length: 129 }, (_, index) => `role.${index}`) }],
    ['untrimmed role', { roles: [' acquisition.reader'] }],
    ['wildcard role', { roles: ['acquisition.*'] }],
    ['duplicate role', { roles: ['acquisition.reader', 'acquisition.reader'] }],
    ['non-string role', { roles: [{ name: 'acquisition.reader' }] }],
  ])('rejects bounded claim violation: %s', async (_name, claims) => {
    await expectGenericRejection(await signedToken(claims));
  });

  it('does not disclose jose/provider verification details for malformed compact JWS', async () => {
    const malformedInput = 'not-a-compact-jwt-sensitive-material';
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expectGenericRejection(malformedInput);

    expect(warning).toHaveBeenCalledWith('token verification rejected: malformed_token');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(malformedInput);
  });

  it('rejects non-RS256 signatures before consulting the JWKS resolver', async () => {
    const pair = await generateKeyPair('PS256');
    const resolver = vi.fn(async () => pair.publicKey);
    const target = new JwksTokenVerifier(CONFIG, resolver as JWTVerifyGetKey);
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: 'PS256', kid: 'ps-key' })
      .sign(pair.privateKey);

    await expectGenericRejection(token, target);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('uses real remote-JWKS refresh, cooldown, cache, and fail-closed outage behavior offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));

    const pair1 = await generateKeyPair('RS256');
    const pair2 = await generateKeyPair('RS256');
    const jwk1 = Object.freeze({ ...(await exportJWK(pair1.publicKey)), alg: 'RS256', use: 'sig', kid: 'remote-1' });
    const jwk2 = Object.freeze({ ...(await exportJWK(pair2.publicKey)), alg: 'RS256', use: 'sig', kid: 'remote-2' });
    let published = Object.freeze({ keys: Object.freeze([jwk1]) });
    let outage = false;
    const fetchJwks = vi.fn<FetchImplementation>(async (url, options) => {
      expect(url).toBe(CONFIG.uri);
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('manual');
      if (outage) {
        return new Response('temporarily unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(published), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const remote = createRemoteJWKSet(new URL(CONFIG.uri), {
      cooldownDuration: 1_000,
      cacheMaxAge: 2_000,
      timeoutDuration: 500,
      [customFetch]: fetchJwks,
    });
    const target = new JwksTokenVerifier(CONFIG, remote);
    const token1 = await signedToken({}, { kid: 'remote-1', privateKey: pair1.privateKey });
    const token2 = await signedToken({}, { kid: 'remote-2', privateKey: pair2.privateKey });

    await expect(target.verify(token1)).resolves.toMatchObject({ userId: 'user-123' });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(remote.fresh).toBe(true);

    outage = true;
    await expect(target.verify(token1)).resolves.toMatchObject({ userId: 'user-123' });
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    outage = false;
    published = Object.freeze({ keys: Object.freeze([jwk1, jwk2]) });
    await expectGenericRejection(token2, target);
    expect(remote.coolingDown).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    await expect(target.verify(token2)).resolves.toMatchObject({ userId: 'user-123' });
    expect(fetchJwks).toHaveBeenCalledTimes(2);

    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    outage = true;
    vi.advanceTimersByTime(2_001);
    await expectGenericRejection(token1, target);
    expect(fetchJwks).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenLastCalledWith('token verification rejected: jwks_unavailable');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('temporarily unavailable');
  });
});
