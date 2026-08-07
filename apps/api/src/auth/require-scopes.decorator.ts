import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { AuthScope, REQUIRED_AUTH_SCOPES } from './auth-scopes';
import { ScopesGuard } from './scopes.guard';

/**
 * Requires every declared scope after AuthGuard has attached signed context.
 * The vendor extension makes the same server-enforced requirement visible in OpenAPI.
 */
export function RequireScopes(...required: readonly [AuthScope, ...AuthScope[]]): MethodDecorator & ClassDecorator {
  const scopes = Object.freeze([...new Set(required)]);
  if (scopes.length !== required.length) {
    throw new Error('RequireScopes does not accept duplicate scopes');
  }
  return applyDecorators(
    SetMetadata(REQUIRED_AUTH_SCOPES, scopes),
    UseGuards(ScopesGuard),
    ApiExtension('x-required-scopes', scopes),
  );
}
