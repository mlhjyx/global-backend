import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DevTokenVerifier } from './dev-token-verifier';

function token(claims: object): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

describe('DevTokenVerifier', () => {
  it('accepts only identity and roles from the development token', async () => {
    const verifier = new DevTokenVerifier();
    await expect(
      verifier.verify(
        token({
          sub: 'user-1',
          workspace_id: 'workspace-1',
          roles: ['viewer'],
          scopes: ['compliance:manage'],
          scope: 'compliance:manage',
        }),
      ),
    ).resolves.toEqual({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      roles: ['viewer'],
    });
  });

  it('preserves unknown roles for the server policy to map to no scopes', async () => {
    const verifier = new DevTokenVerifier();
    await expect(
      verifier.verify(
        token({
          sub: 'user-1',
          workspace_id: 'workspace-1',
          roles: ['unknown'],
        }),
      ),
    ).resolves.toMatchObject({ roles: ['unknown'] });
  });

  it('rejects malformed tokens and missing identity claims', async () => {
    const verifier = new DevTokenVerifier();
    for (const candidate of [
      'not-json',
      token({ workspace_id: 'workspace-1' }),
      token({ sub: 'user-1' }),
      token({ sub: 'user-1', workspace_id: 'workspace-1', roles: [42] }),
    ]) {
      const error = await verifier
        .verify(candidate)
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toEqual({
        error: { code: 'TOKEN_INVALID', message: 'invalid dev token' },
      });
    }
  });
});
