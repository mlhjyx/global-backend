import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DevTokenVerifier } from './dev-token-verifier';

const workspaceId = '11111111-1111-4111-8111-111111111111';

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
          workspace_id: workspaceId,
          roles: ['viewer'],
          scopes: ['compliance:manage'],
          scope: 'compliance:manage',
        }),
      ),
    ).resolves.toEqual({
      userId: 'user-1',
      workspaceId,
      roles: ['viewer'],
    });
  });

  it('preserves unknown roles for the server policy to map to no scopes', async () => {
    const verifier = new DevTokenVerifier();
    await expect(
      verifier.verify(
        token({
          sub: 'user-1',
          workspace_id: workspaceId,
          roles: ['unknown'],
        }),
      ),
    ).resolves.toMatchObject({ roles: ['unknown'] });
  });

  it('rejects malformed tokens and missing identity claims', async () => {
    const verifier = new DevTokenVerifier();
    for (const candidate of [
      'not-json',
      token({ workspace_id: workspaceId }),
      token({ sub: 'user-1' }),
      token({ sub: 'user-1', workspace_id: workspaceId, roles: [42] }),
      token({ sub: {}, workspace_id: workspaceId, roles: [] }),
      token({ sub: 'user-1', workspace_id: {}, roles: [] }),
      token({ sub: 'user-1', workspace_id: 'workspace-1', roles: [] }),
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
