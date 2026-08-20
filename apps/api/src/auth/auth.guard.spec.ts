import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard';
import type { RequestContext } from './request-context';
import { createRolesToScopesPolicy } from './scopes';
import { TokenVerifier } from './token-verifier';

const TEST_ROLE_POLICY = {
  AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({ viewer: [] }),
};

class FakeVerifier extends TokenVerifier {
  constructor(private readonly context: RequestContext) {
    super();
  }

  async verify(): Promise<RequestContext> {
    return this.context;
  }
}

function executionContext(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard authorization context', () => {
  it('derives immutable server scopes from signed token roles', async () => {
    const identity: RequestContext = {
      userId: 'user-1',
      workspaceId: 'workspace-1',
      roles: ['operator', 'unknown'],
    };
    const verifier = new FakeVerifier(identity);
    const policy = createRolesToScopesPolicy(
      {
        AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
          operator: ['acquisition:read', 'acquisition:write'],
        }),
      },
      'pilot',
    );
    const request = { headers: { authorization: 'Bearer signed-token' } };
    const guard = new AuthGuard(verifier, policy);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request).toMatchObject({
      requestContext: {
        userId: 'user-1',
        workspaceId: 'workspace-1',
        roles: ['operator', 'unknown'],
        scopes: ['acquisition:read', 'acquisition:write'],
      },
    });
    expect(Object.isFrozen(request.requestContext)).toBe(true);
    expect(Object.isFrozen(request.requestContext.roles)).toBe(true);
    expect(Object.isFrozen(request.requestContext.scopes)).toBe(true);
    expect(identity).toEqual({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      roles: ['operator', 'unknown'],
    });
  });

  it('does not call the verifier when the bearer header is missing', async () => {
    const verifier = {
      verify: vi.fn(),
    } as unknown as TokenVerifier;
    const policy = createRolesToScopesPolicy(TEST_ROLE_POLICY, 'test');
    const guard = new AuthGuard(verifier, policy);

    const error = await guard
      .canActivate(executionContext({ headers: {} }))
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      error: { code: 'TOKEN_MISSING', message: 'missing bearer token' },
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects an oversized bearer token before invoking a verifier', async () => {
    const verifier = {
      verify: vi.fn(),
    } as unknown as TokenVerifier;
    const guard = new AuthGuard(
      verifier,
      createRolesToScopesPolicy(TEST_ROLE_POLICY, 'test'),
    );

    await expect(
      guard.canActivate(
        executionContext({
          headers: { authorization: `Bearer ${'a'.repeat(16_385)}` },
        }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'TOKEN_INVALID' } } });
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});
