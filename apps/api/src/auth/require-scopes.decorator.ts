import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
} from './scopes';

export const REQUIRED_SCOPES_METADATA = 'authz:required-scopes';

export function RequireScopes(
  ...required: readonly AuthorizationScope[]
): ClassDecorator & MethodDecorator {
  const unique = new Set(required);
  const scopes = Object.freeze(
    AUTHORIZATION_SCOPES.filter((scope) => unique.has(scope)),
  );
  if (scopes.length === 0 || scopes.length !== unique.size) {
    throw new Error('RequireScopes needs one or more known authorization scopes');
  }
  return applyDecorators(
    SetMetadata(REQUIRED_SCOPES_METADATA, scopes),
    ApiExtension('x-required-scopes', scopes),
  );
}
