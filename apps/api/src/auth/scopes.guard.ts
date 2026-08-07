import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestContext } from './request-context';
import { AuthScope, REQUIRED_AUTH_SCOPES, ROLE_SCOPE_POLICY, RoleScopePolicy } from './auth-scopes';

interface AuthenticatedRequest {
  requestContext?: RequestContext;
}

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ROLE_SCOPE_POLICY) private readonly policy: RoleScopePolicy,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly AuthScope[]>(REQUIRED_AUTH_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const requestContext = request.requestContext;
    if (!requestContext || !Array.isArray(requestContext.roles)) {
      throw new UnauthorizedException({
        error: {
          code: 'TOKEN_CONTEXT_MISSING',
          message: 'authenticated request context is missing',
        },
      });
    }
    if (!this.policy.permits(requestContext.roles, required)) {
      throw new ForbiddenException({
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: 'the authenticated role is not authorized for this operation',
          details: { requiredScopes: [...required] },
        },
      });
    }
    return true;
  }
}
