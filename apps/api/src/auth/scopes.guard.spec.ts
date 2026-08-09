import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RequireScopes } from './require-scopes.decorator';
import { ScopesGuard } from './scopes.guard';

function testContext(handler: Function, controller: Function, request: object): ExecutionContext {
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
    expect(() =>
      guard.canActivate(
        testContext(
          ProtectedController.prototype.read,
          ProtectedController,
          {},
        ),
      ),
    ).toThrow('authenticated request context is required');
  });

  it('fails closed when a protected handler has no scope metadata', () => {
    expect(() =>
      guard.canActivate(
        testContext(
          MissingMetadataController.prototype.execute,
          MissingMetadataController,
          { requestContext: { scopes: [] } },
        ),
      ),
    ).toThrow('required scope metadata is missing');
  });
});
