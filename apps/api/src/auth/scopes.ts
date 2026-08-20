import type { RuntimeMode } from '../runtime/runtime-environment';

export const AUTHORIZATION_SCOPES = Object.freeze([
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

export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];
export const ROLES_TO_SCOPES_POLICY = Symbol('ROLES_TO_SCOPES_POLICY');

const KNOWN_SCOPES = new Set<string>(AUTHORIZATION_SCOPES);
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RESERVED_ROLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_POLICY_BYTES = 65_536;
const MAX_TOKEN_ROLES = 128;

type RoleScopeMap = Readonly<Record<string, readonly AuthorizationScope[]>>;

export interface RolesToScopesPolicy {
  resolve(roles: readonly string[]): readonly AuthorizationScope[];
}

export function normalizeTokenRoles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('roles claim must be an array');
  if (value.length > MAX_TOKEN_ROLES) {
    throw new Error(`roles claim must not contain more than ${MAX_TOKEN_ROLES} roles`);
  }
  const roles = new Set<string>();
  for (const role of value) {
    if (
      typeof role !== 'string' ||
      RESERVED_ROLE_KEYS.has(role) ||
      !ROLE_PATTERN.test(role)
    ) {
      throw new Error('roles claim contains an invalid role');
    }
    roles.add(role);
  }
  return [...roles];
}

function parseConfiguredMap(raw: string): RoleScopeMap {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('AUTH_ROLE_SCOPE_MAP_JSON must be valid JSON');
  }
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new Error('AUTH_ROLE_SCOPE_MAP_JSON must be a JSON object');
  }

  const entries = Object.entries(candidate as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('AUTH_ROLE_SCOPE_MAP_JSON must define at least one role');
  }

  const parsed: Record<string, readonly AuthorizationScope[]> = Object.create(null);
  for (const [role, value] of entries) {
    if (RESERVED_ROLE_KEYS.has(role) || !ROLE_PATTERN.test(role)) {
      throw new Error(`AUTH_ROLE_SCOPE_MAP_JSON contains invalid role: ${role}`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`AUTH_ROLE_SCOPE_MAP_JSON scope list must be an array for role: ${role}`);
    }

    const unique = new Set<AuthorizationScope>();
    for (const scope of value) {
      if (typeof scope !== 'string' || !KNOWN_SCOPES.has(scope)) {
        throw new Error(
          `AUTH_ROLE_SCOPE_MAP_JSON contains unknown authorization scope for role: ${role}`,
        );
      }
      unique.add(scope as AuthorizationScope);
    }
    parsed[role] = Object.freeze(
      AUTHORIZATION_SCOPES.filter((scope) => unique.has(scope)),
    );
  }
  return Object.freeze(parsed);
}

function policy(roleScopeMap: RoleScopeMap): RolesToScopesPolicy {
  return Object.freeze({
    resolve(roles: readonly string[]): readonly AuthorizationScope[] {
      const granted = new Set<AuthorizationScope>();
      for (const role of roles) {
        const scopes = Object.hasOwn(roleScopeMap, role)
          ? roleScopeMap[role]
          : undefined;
        if (!scopes) continue;
        for (const scope of scopes) granted.add(scope);
      }
      return Object.freeze(
        AUTHORIZATION_SCOPES.filter((scope) => granted.has(scope)),
      );
    },
  });
}

export function createRolesToScopesPolicy(
  env: NodeJS.ProcessEnv,
  mode: RuntimeMode,
): RolesToScopesPolicy {
  const raw = env.AUTH_ROLE_SCOPE_MAP_JSON;
  if (raw && Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) {
    throw new Error(
      `AUTH_ROLE_SCOPE_MAP_JSON must not exceed ${MAX_POLICY_BYTES} UTF-8 bytes`,
    );
  }
  const configured = raw?.trim();
  if (!configured) {
    throw new Error(`AUTH_ROLE_SCOPE_MAP_JSON is required in ${mode}`);
  }
  return policy(parseConfiguredMap(configured));
}
