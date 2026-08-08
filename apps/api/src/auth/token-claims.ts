import type { RequestContext } from './request-context';
import { isValidRoleName } from './auth-scopes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SUBJECT_BYTES = 256;
const MAX_ROLES = 128;

export function requestContextFromClaims(
  claims: Readonly<Record<string, unknown>>,
  workspaceClaim: string,
  rolesClaim: string,
): RequestContext {
  const subject = claims.sub;
  const workspaceId = claims[workspaceClaim];
  const roles = claims[rolesClaim];
  if (
    typeof subject !== 'string' ||
    !subject ||
    subject !== subject.trim() ||
    Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES
  ) {
    throw new Error('invalid subject claim');
  }
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new Error('invalid workspace claim');
  }
  if (!Array.isArray(roles) || roles.length > MAX_ROLES || roles.some((role) => !isValidRoleName(role))) {
    throw new Error('invalid roles claim');
  }
  if (new Set(roles).size !== roles.length) {
    throw new Error('duplicate roles claim');
  }
  return Object.freeze({
    userId: subject,
    workspaceId,
    roles: Object.freeze([...roles]),
  });
}
