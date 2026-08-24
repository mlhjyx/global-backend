import { ServiceUnavailableException } from '@nestjs/common';
import { RequestContext } from './request-context';

/**
 * Seam for external identity. Auth is owned by the SaaS platform; our backend
 * only verifies the token it issues and derives the request context.
 *
 * Prod swaps the dev implementation for a real verifier (JWKS / shared secret /
 * introspection) without changing guards, controllers, or domain code.
 */
export abstract class TokenVerifier {
  abstract verify(token: string): Promise<RequestContext>;
}

/**
 * Diagnostic-runtime verifier used only when the managed JWKS contract is not
 * configured or cannot be constructed. It never parses or trusts a token.
 * Runtime admission exposes the configuration failure; product requests remain
 * fail-closed without preventing the health surface from booting.
 */
export class UnavailableTokenVerifier extends TokenVerifier {
  async verify(_token: string): Promise<RequestContext> {
    throw new ServiceUnavailableException({
      error: {
        code: 'AUTH_VERIFICATION_UNAVAILABLE',
        message: 'authentication verification is unavailable',
      },
    });
  }
}
