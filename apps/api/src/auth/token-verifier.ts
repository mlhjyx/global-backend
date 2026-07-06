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
