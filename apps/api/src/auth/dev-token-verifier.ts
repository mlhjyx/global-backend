import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';
import { normalizeTokenRoles } from './scopes';
import {
  normalizeSubjectClaim,
  normalizeWorkspaceClaim,
} from './token-claims';

/**
 * DEV ONLY. Token is base64url(JSON { sub, workspace_id, roles }).
 * Replace with verification of the external platform's signed token in prod.
 */
@Injectable()
export class DevTokenVerifier extends TokenVerifier {
  async verify(token: string): Promise<RequestContext> {
    try {
      const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      return {
        userId: normalizeSubjectClaim(claims.sub),
        workspaceId: normalizeWorkspaceClaim(claims.workspace_id),
        roles: normalizeTokenRoles(claims.roles),
      };
    } catch {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: 'invalid dev token' },
      });
    }
  }
}
