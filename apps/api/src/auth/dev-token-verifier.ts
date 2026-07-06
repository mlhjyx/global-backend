import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';

/**
 * DEV ONLY. Token is base64url(JSON { sub, workspace_id, roles }).
 * Replace with verification of the external platform's signed token in prod.
 */
@Injectable()
export class DevTokenVerifier extends TokenVerifier {
  async verify(token: string): Promise<RequestContext> {
    try {
      const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (!claims.sub || !claims.workspace_id) throw new Error('missing claims');
      return {
        userId: String(claims.sub),
        workspaceId: String(claims.workspace_id),
        roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
      };
    } catch {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: 'invalid dev token' },
      });
    }
  }
}
