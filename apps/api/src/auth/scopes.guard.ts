import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestContext } from './request-context';
import { REQUIRED_SCOPES_METADATA } from './require-scopes.decorator';
import type { AuthorizationScope } from './scopes';

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      readonly AuthorizationScope[]
    >(REQUIRED_SCOPES_METADATA, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) {
      throw new ForbiddenException({
        error: {
          code: 'SCOPE_METADATA_MISSING',
          message: 'required scope metadata is missing',
        },
      });
    }

    const request = context.switchToHttp().getRequest<{
      requestContext?: RequestContext;
    }>();
    const requestContext = request.requestContext;
    if (!requestContext) {
      throw new ForbiddenException({
        error: {
          code: 'AUTH_CONTEXT_MISSING',
          message: 'authenticated request context is required',
        },
      });
    }

    const granted = new Set(requestContext.scopes ?? []);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException({
        error: {
          code: 'SCOPE_REQUIRED',
          message: 'required authorization scope is missing',
          details: { required: [...required] },
        },
      });
    }
    return true;
  }
}
