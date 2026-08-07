import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { JwksTokenVerifier } from './jwks-token-verifier';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('JwksTokenVerifier', () => {
  it('does not disclose jose/provider verification details to callers', async () => {
    process.env.AUTH_JWKS_URI = 'https://identity.example.test/.well-known/jwks.json';
    process.env.AUTH_ISSUER = 'https://identity.example.test/';
    process.env.AUTH_AUDIENCE = 'growth-api';
    const verifier = new JwksTokenVerifier();

    const error = await verifier.verify('not-a-compact-jwt').catch((caught) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
    });
  });
});
