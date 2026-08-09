import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import {
  ROLES_TO_SCOPES_POLICY,
  type RolesToScopesPolicy,
} from './scopes';

/** Validates the bearer token and attaches the resolved RequestContext. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifier,
    @Inject(ROLES_TO_SCOPES_POLICY)
    private readonly rolesToScopes: RolesToScopesPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_MISSING', message: 'missing bearer token' },
      });
    }
    const verified = await this.verifier.verify(header.slice('Bearer '.length));
    const roles = Object.freeze([...verified.roles]);
    req.requestContext = Object.freeze({
      userId: verified.userId,
      workspaceId: verified.workspaceId,
      roles,
      scopes: this.rolesToScopes.resolve(roles),
    });
    return true;
  }
}
