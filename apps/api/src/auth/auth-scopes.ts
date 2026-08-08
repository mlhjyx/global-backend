export const AUTH_SCOPES = Object.freeze([
  'acquisition:read',
  'acquisition:write',
  'acquisition:review',
  'acquisition:event:ack',
  'acquisition:label:write',
  'acquisition:identity:review',
  'personal-data:read',
  'compliance:manage',
  'ops:read',
] as const);

export type AuthScope = (typeof AUTH_SCOPES)[number];

export const REQUIRED_AUTH_SCOPES = 'global.auth.required-scopes';
export const ROLE_SCOPE_POLICY = Symbol('ROLE_SCOPE_POLICY');

const AUTH_SCOPE_SET = new Set<string>(AUTH_SCOPES);
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_MAPPING_BYTES = 16_384;
const MAX_ROLES = 128;

function mappingError(message: string): Error {
  return new Error(`AUTH_ROLE_SCOPE_MAP ${message}`);
}

/** Shared closed syntax for server mapping keys and signed token role values. */
export function isValidRoleName(value: unknown): value is string {
  return typeof value === 'string' && ROLE_NAME.test(value) && !value.includes('*');
}

/** Immutable, server-controlled mapping from signed token roles to fixed scopes. */
export class RoleScopePolicy {
  private constructor(private readonly scopesByRole: ReadonlyMap<string, ReadonlySet<AuthScope>>) {}

  static parse(raw: string | undefined): RoleScopePolicy {
    if (!raw?.trim()) throw mappingError('is required and must not be blank');
    if (Buffer.byteLength(raw, 'utf8') > MAX_MAPPING_BYTES) {
      throw mappingError(`must not exceed ${MAX_MAPPING_BYTES} bytes`);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw mappingError('must be valid JSON');
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw mappingError('must be a JSON object');
    }

    const entries = Object.entries(decoded as Record<string, unknown>);
    if (entries.length === 0) throw mappingError('must define at least one role');
    if (entries.length > MAX_ROLES) {
      throw mappingError(`must not define more than ${MAX_ROLES} roles`);
    }

    const mapping = new Map<string, ReadonlySet<AuthScope>>();
    for (const [role, rawScopes] of entries) {
      if (!isValidRoleName(role)) {
        throw mappingError(`contains invalid role key ${JSON.stringify(role)}`);
      }
      if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
        throw mappingError(`role ${JSON.stringify(role)} must have scopes`);
      }

      const scopes = new Set<AuthScope>();
      for (const rawScope of rawScopes) {
        if (typeof rawScope !== 'string' || !AUTH_SCOPE_SET.has(rawScope)) {
          throw mappingError(`role ${JSON.stringify(role)} contains unknown scope ${JSON.stringify(rawScope)}`);
        }
        const scope = rawScope as AuthScope;
        if (scopes.has(scope)) {
          throw mappingError(`role ${JSON.stringify(role)} contains duplicate scope ${JSON.stringify(scope)}`);
        }
        scopes.add(scope);
      }
      mapping.set(role, scopes);
    }
    return new RoleScopePolicy(mapping);
  }

  /** Only for the non-serving OpenAPI process, whose verifier rejects every token. */
  static disabledRuntime(): RoleScopePolicy {
    return new RoleScopePolicy(new Map());
  }

  scopesForRoles(roles: readonly string[]): ReadonlySet<AuthScope> {
    const resolved = new Set<AuthScope>();
    for (const role of roles) {
      if (typeof role !== 'string') continue;
      for (const scope of this.scopesByRole.get(role) ?? []) resolved.add(scope);
    }
    return resolved;
  }

  permits(roles: readonly string[], required: readonly AuthScope[]): boolean {
    const granted = this.scopesForRoles(roles);
    return required.every((scope) => granted.has(scope));
  }
}
