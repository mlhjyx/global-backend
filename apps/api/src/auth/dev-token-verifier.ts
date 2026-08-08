import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';
import { requestContextFromClaims } from './token-claims';

/**
 * DEV ONLY. Token is base64url(JSON { sub, workspace_id, roles }).
 * Replace with verification of the external platform's signed token in prod.
 */
@Injectable()
export class DevTokenVerifier extends TokenVerifier {
  async verify(token: string): Promise<RequestContext> {
    try {
      if (Buffer.byteLength(token, 'utf8') > 16_384) {
        throw new Error('token is too large');
      }
      const claims: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        throw new Error('invalid claims');
      }
      return requestContextFromClaims(claims as Record<string, unknown>, 'workspace_id', 'roles');
    } catch {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: 'invalid dev token' },
      });
    }
  }
}
