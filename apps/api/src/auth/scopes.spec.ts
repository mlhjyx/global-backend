import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_SCOPES,
  createRolesToScopesPolicy,
  normalizeTokenRoles,
} from './scopes';

const EXPECTED_SCOPES = [
  'acquisition:read',
  'acquisition:write',
  'acquisition:review',
  'acquisition:event:ack',
  'acquisition:label:write',
  'acquisition:identity:review',
  'personal-data:read',
  'compliance:manage',
  'ops:read',
] as const;

describe('roles to scopes policy', () => {
  it('exposes only the nine approved server scopes', () => {
    expect(AUTHORIZATION_SCOPES).toEqual(EXPECTED_SCOPES);
  });

  it('requires one explicit server-controlled mapping in every managed environment', () => {
    expect(() => createRolesToScopesPolicy({}, 'development')).toThrow(
      'AUTH_ROLE_SCOPE_MAP_JSON is required in development',
    );
    expect(() => createRolesToScopesPolicy({}, 'pilot')).toThrow(
      'AUTH_ROLE_SCOPE_MAP_JSON is required in pilot',
    );
    expect(() => createRolesToScopesPolicy({}, 'production')).toThrow(
      'AUTH_ROLE_SCOPE_MAP_JSON is required in production',
    );
    expect(() => createRolesToScopesPolicy({}, 'test')).toThrow(
      'AUTH_ROLE_SCOPE_MAP_JSON is required in test',
    );
  });

  it('rejects malformed mappings and any scope outside the closed vocabulary', () => {
    expect(() =>
      createRolesToScopesPolicy(
        { AUTH_ROLE_SCOPE_MAP_JSON: '{not-json' },
        'pilot',
      ),
    ).toThrow('AUTH_ROLE_SCOPE_MAP_JSON must be valid JSON');

    expect(() =>
      createRolesToScopesPolicy(
        {
          AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
            operator: ['acquisition:read', 'campaign:send'],
          }),
        },
        'pilot',
      ),
    ).toThrow('unknown authorization scope');

    expect(() =>
      createRolesToScopesPolicy(
        {
          AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({ operator: 'acquisition:read' }),
        },
        'pilot',
      ),
    ).toThrow('scope list must be an array');

    expect(() =>
      createRolesToScopesPolicy(
        { AUTH_ROLE_SCOPE_MAP_JSON: ' '.repeat(65_537) },
        'pilot',
      ),
    ).toThrow('must not exceed 65536 UTF-8 bytes');
  });

  it('maps unknown token roles to no scopes without default access', () => {
    const policy = createRolesToScopesPolicy(
      {
        AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
          operator: ['acquisition:read', 'acquisition:write'],
        }),
      },
      'pilot',
    );

    expect(policy.resolve(['unknown'])).toEqual([]);
    expect(policy.resolve(['operator', 'unknown'])).toEqual([
      'acquisition:read',
      'acquisition:write',
    ]);

    const testPolicy = createRolesToScopesPolicy(
      { AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({ viewer: [] }) },
      'test',
    );
    expect(testPolicy.resolve(['toString'])).toEqual([]);
    expect(testPolicy.resolve(['hasOwnProperty'])).toEqual([]);
  });

  it('deduplicates roles and scopes without mutating caller claims', () => {
    const roles = ['operator', 'operator'];
    const policy = createRolesToScopesPolicy(
      {
        AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
          operator: [
            'acquisition:write',
            'acquisition:read',
            'acquisition:write',
          ],
        }),
      },
      'production',
    );

    expect(policy.resolve(roles)).toEqual([
      'acquisition:read',
      'acquisition:write',
    ]);
    expect(roles).toEqual(['operator', 'operator']);
  });

  it('uses the same explicit role map semantics in tests and managed runtime', () => {
    const env = {
      AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
        viewer: ['acquisition:read', 'ops:read'],
      }),
    };
    expect(createRolesToScopesPolicy(env, 'test').resolve(['viewer'])).toEqual([
      'acquisition:read',
      'ops:read',
    ]);
    expect(
      createRolesToScopesPolicy(env, 'production').resolve(['viewer']),
    ).toEqual(['acquisition:read', 'ops:read']);
  });

  it('normalizes a bounded string-only roles claim and rejects malformed values', () => {
    expect(normalizeTokenRoles(['operator', 'operator', 'unknown'])).toEqual([
      'operator',
      'unknown',
    ]);
    expect(() => normalizeTokenRoles('operator')).toThrow(
      'roles claim must be an array',
    );
    expect(() => normalizeTokenRoles(['operator', 42])).toThrow(
      'roles claim contains an invalid role',
    );
    expect(() => normalizeTokenRoles(['invalid role'])).toThrow(
      'roles claim contains an invalid role',
    );
    expect(() =>
      normalizeTokenRoles(Array.from({ length: 129 }, (_, index) => `role-${index}`)),
    ).toThrow('roles claim must not contain more than 128 roles');
  });
});
