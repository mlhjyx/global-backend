import { UnauthorizedException } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type KeyLike,
} from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { JwksTokenVerifier } from './jwks-token-verifier';

interface SigningKey {
  kid: string;
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
}

const issuer = 'https://identity.example.test/';
const audience = 'global-api';
const workspaceId = '11111111-1111-4111-8111-111111111111';
let server: Server;
let jwksUri: string;
let oldKey: SigningKey;
let newKey: SigningKey;
let unknownKey: SigningKey;

async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await generateKeyPair('RS256');
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: 'RS256',
      use: 'sig',
      kid,
    },
  };
}

async function signed(
  key: SigningKey,
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string | null;
    workspaceId?: unknown;
    roles?: unknown;
    expired?: boolean;
    notBeforeFuture?: boolean;
  } = {},
): Promise<string> {
  let jwt = new SignJWT({
    ...(overrides.workspaceId === null
      ? {}
      : { workspace_id: overrides.workspaceId ?? workspaceId }),
    roles: overrides.roles ?? ['operator'],
    scope: 'compliance:manage',
    scp: ['compliance:manage'],
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expired ? '-10m' : '10m');
  if (overrides.subject !== null) {
    jwt = jwt.setSubject(overrides.subject ?? 'user-1');
  }
  if (overrides.notBeforeFuture) jwt = jwt.setNotBefore('10m');
  return jwt.sign(key.privateKey);
}

async function invalid(token: string): Promise<UnauthorizedException> {
  const error = await new JwksTokenVerifier()
    .verify(token)
    .then(() => undefined)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).getResponse()).toMatchObject({
    error: { code: 'TOKEN_INVALID' },
  });
  return error as UnauthorizedException;
}

beforeAll(async () => {
  [oldKey, newKey, unknownKey] = await Promise.all([
    signingKey('old-key'),
    signingKey('new-key'),
    signingKey('unknown-key'),
  ]);
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ keys: [oldKey.publicJwk, newKey.publicJwk] }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address() as AddressInfo;
  jwksUri = `http://127.0.0.1:${address.port}/jwks`;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function configure(): void {
  vi.stubEnv('AUTH_JWKS_URI', jwksUri);
  vi.stubEnv('AUTH_ISSUER', issuer);
  vi.stubEnv('AUTH_AUDIENCE', audience);
  vi.stubEnv('AUTH_CLOCK_SKEW_S', '1');
}

describe('JwksTokenVerifier contract', () => {
  it('verifies issuer, audience, subject, workspace and roles without trusting scope claims', async () => {
    configure();
    const verifier = new JwksTokenVerifier();
    await expect(
      verifier.verify(await signed(oldKey, { roles: ['operator', 'unknown'] })),
    ).resolves.toEqual({
      userId: 'user-1',
      workspaceId,
      roles: ['operator', 'unknown'],
    });
  });

  it('accepts old and new kid values during an overlapping key rotation', async () => {
    configure();
    const verifier = new JwksTokenVerifier();
    await expect(verifier.verify(await signed(oldKey))).resolves.toBeDefined();
    await expect(verifier.verify(await signed(newKey))).resolves.toBeDefined();
    await invalid(await signed(unknownKey));
  });

  it('rejects wrong issuer and audience', async () => {
    configure();
    await invalid(await signed(oldKey, { issuer: 'https://attacker.example/' }));
    await invalid(await signed(oldKey, { audience: 'another-api' }));
  });

  it('rejects expired and not-yet-valid tokens', async () => {
    configure();
    await invalid(await signed(oldKey, { expired: true }));
    await invalid(await signed(oldKey, { notBeforeFuture: true }));
  });

  it('rejects missing subject or workspace identity', async () => {
    configure();
    await invalid(await signed(oldKey, { subject: null }));
    await invalid(await signed(oldKey, { workspaceId: null }));
  });

  it('rejects a non-string roles claim even when the signature is valid', async () => {
    configure();
    await invalid(await signed(oldKey, { roles: ['operator', 42] }));
  });

  it('rejects non-string and non-UUID workspace claims', async () => {
    configure();
    await invalid(await signed(oldKey, { workspaceId: {} }));
    await invalid(await signed(oldKey, { workspaceId: 'workspace-1' }));
  });

  it.each(['-1', '301', 'Infinity', 'not-a-number'])(
    'rejects unsafe AUTH_CLOCK_SKEW_S=%s',
    (clockSkew) => {
      expect(
        () =>
          new JwksTokenVerifier({
            AUTH_JWKS_URI: 'https://identity.example.test/jwks',
            AUTH_ISSUER: issuer,
            AUTH_AUDIENCE: audience,
            AUTH_CLOCK_SKEW_S: clockSkew,
          }),
      ).toThrow(/AUTH_CLOCK_SKEW_S/);
    },
  );

  it('requires an explicit audience at the verifier boundary', () => {
    expect(
      () =>
        new JwksTokenVerifier({
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
          AUTH_ISSUER: issuer,
        }),
    ).toThrow(/AUTH_AUDIENCE/);
  });

  it.each([
    ['workspace', { AUTH_WORKSPACE_CLAIM: '__proto__' }],
    ['workspace', { AUTH_WORKSPACE_CLAIM: '' }],
    ['roles', { AUTH_ROLES_CLAIM: 'constructor' }],
    ['roles', { AUTH_ROLES_CLAIM: 'x'.repeat(129) }],
  ])('rejects an unsafe custom %s claim name', (_kind, override) => {
    expect(
      () =>
        new JwksTokenVerifier({
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
          AUTH_ISSUER: issuer,
          AUTH_AUDIENCE: audience,
          ...override,
        }),
    ).toThrow(/claim name/);
  });
});
