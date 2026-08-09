import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RequireScopes } from './require-scopes.decorator';
import { ScopesGuard } from './scopes.guard';

function testContext(
  handler: ReturnType<ExecutionContext['getHandler']>,
  controller: ReturnType<ExecutionContext['getClass']>,
  request: object,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

@RequireScopes('acquisition:read')
class ProtectedController {
  read(): void {}

  @RequireScopes('acquisition:review', 'acquisition:identity:review')
  review(): void {}
}

class MissingMetadataController {
  execute(): void {}
}

describe('ScopesGuard', () => {
  const guard = new ScopesGuard(new Reflector());

  it('allows a request only when all declared scopes are present', () => {
    const request = {
      requestContext: {
        scopes: ['acquisition:review', 'acquisition:identity:review'],
      },
    };
    expect(
      guard.canActivate(
        testContext(
          ProtectedController.prototype.review,
          ProtectedController,
          request,
        ),
      ),
    ).toBe(true);
  });

  it('fails closed when a required scope is absent', () => {
    const request = {
      requestContext: { scopes: ['acquisition:review'] },
    };
    expect(() =>
      guard.canActivate(
        testContext(
          ProtectedController.prototype.review,
          ProtectedController,
          request,
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when AuthGuard did not attach a context', () => {
    const error = (() => {
      try {
        guard.canActivate(
          testContext(
            ProtectedController.prototype.read,
            ProtectedController,
            {},
          ),
        );
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'AUTH_CONTEXT_MISSING' },
    });
  });

  it('fails closed when a protected handler has no scope metadata', () => {
    const error = (() => {
      try {
        guard.canActivate(
          testContext(
            MissingMetadataController.prototype.execute,
            MissingMetadataController,
            { requestContext: { scopes: [] } },
          ),
        );
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'SCOPE_METADATA_MISSING' },
    });
  });
});
