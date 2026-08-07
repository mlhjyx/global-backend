import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SCOPES,
  REQUIRED_AUTH_SCOPES,
  RoleScopePolicy,
} from './auth-scopes';
import { RequireScopes } from './require-scopes.decorator';
import { ScopesGuard } from './scopes.guard';

const ADMIN_MAPPING = JSON.stringify({
  'platform.admin': [...AUTH_SCOPES],
  'acquisition.reader': ['acquisition:read'],
  'privacy.reader': ['personal-data:read'],
});

class ProtectedController {
  @RequireScopes('acquisition:read', 'personal-data:read')
  detail(): void {}

  unscoped(): void {}
}

function contextFor(
  handler: () => void,
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    getClass: () => ProtectedController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RoleScopePolicy', () => {
  it('accepts only the fixed nine scopes and unions exact mapped roles', () => {
    const policy = RoleScopePolicy.parse(ADMIN_MAPPING);

    expect(AUTH_SCOPES).toEqual([
      'acquisition:read',
      'acquisition:write',
      'acquisition:review',
      'acquisition:event:ack',
      'acquisition:label:write',
      'acquisition:identity:review',
      'personal-data:read',
      'compliance:manage',
      'ops:read',
    ]);
    expect(policy.scopesForRoles(['acquisition.reader', 'privacy.reader'])).toEqual(
      new Set(['acquisition:read', 'personal-data:read']),
    );
  });

  it('maps unknown or differently-cased roles to no scopes', () => {
    const policy = RoleScopePolicy.parse(ADMIN_MAPPING);

    expect(policy.scopesForRoles(['unknown', 'Platform.Admin'])).toEqual(new Set());
  });

  it.each([
    [undefined, 'missing mapping'],
    ['', 'blank mapping'],
    ['{}', 'empty mapping'],
    ['[]', 'array mapping'],
    ['{"": ["acquisition:read"]}', 'empty role'],
    ['{"*": ["acquisition:read"]}', 'wildcard role'],
    ['{"reader": []}', 'empty scope list'],
    ['{"reader": ["acquisition:* "]}', 'wildcard scope'],
    ['{"reader": ["not-a-scope"]}', 'unknown scope'],
    ['{"reader": ["acquisition:read", "acquisition:read"]}', 'duplicate scope'],
  ])('rejects %s (%s)', (raw) => {
    expect(() => RoleScopePolicy.parse(raw)).toThrow(/AUTH_ROLE_SCOPE_MAP/u);
  });
});

describe('RequireScopes + ScopesGuard', () => {
  const policy = RoleScopePolicy.parse(ADMIN_MAPPING);
  const guard = new ScopesGuard(new Reflector(), policy);

  it('publishes immutable required-scope metadata for authorization and OpenAPI', () => {
    const scopes = Reflect.getMetadata(
      REQUIRED_AUTH_SCOPES,
      ProtectedController.prototype.detail,
    );
    expect(scopes).toEqual(['acquisition:read', 'personal-data:read']);
    expect(Object.isFrozen(scopes)).toBe(true);
  });

  it('requires every declared scope across the signed context roles', () => {
    const allowed = contextFor(ProtectedController.prototype.detail, {
      requestContext: {
        userId: 'signed-user',
        workspaceId: 'signed-workspace',
        roles: ['acquisition.reader', 'privacy.reader'],
      },
    });

    expect(guard.canActivate(allowed)).toBe(true);
  });

  it('denies unknown roles and never trusts body/header role or scope claims', () => {
    const spoofed = contextFor(ProtectedController.prototype.detail, {
      requestContext: {
        userId: 'signed-user',
        workspaceId: 'signed-workspace',
        roles: ['unknown'],
      },
      body: {
        roles: ['platform.admin'],
        scopes: [...AUTH_SCOPES],
        userId: 'spoofed-user',
        workspaceId: 'spoofed-workspace',
      },
      headers: {
        'x-roles': 'platform.admin',
        'x-scopes': AUTH_SCOPES.join(' '),
      },
    });

    expect(() => guard.canActivate(spoofed)).toThrow(ForbiddenException);
  });

  it('fails closed when AuthGuard has not attached a signed request context', () => {
    const missing = contextFor(ProtectedController.prototype.detail, {});

    expect(() => guard.canActivate(missing)).toThrow(UnauthorizedException);
  });

  it('does not invent authorization requirements for unscoped non-domain handlers', () => {
    const unscoped = contextFor(ProtectedController.prototype.unscoped, {});

    expect(guard.canActivate(unscoped)).toBe(true);
  });
});
