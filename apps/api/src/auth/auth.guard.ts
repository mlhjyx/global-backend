import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenVerifier } from './token-verifier';

/** Validates the bearer token and attaches the resolved RequestContext. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly verifier: TokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_MISSING', message: 'missing bearer token' },
      });
    }
    req.requestContext = await this.verifier.verify(header.slice('Bearer '.length));
    return true;
  }
}
