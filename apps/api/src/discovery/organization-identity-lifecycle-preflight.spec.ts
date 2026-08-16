import { describe, expect, it } from 'vitest';
import {
  assertIdentityV2LifecycleAppRole,
  assertIdentityV2LifecycleDatabaseTargets,
} from './organization-identity-lifecycle-preflight';

describe('Identity v2 lifecycle acceptance preflight', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts matching loopback owner/app targets on %s',
    (hostname) => {
      const owner = `postgresql://owner:secret@${hostname}:55432/global_identity_acceptance`;
      const app = `postgresql://app_user:secret@${hostname}:55432/global_identity_acceptance`;
      expect(assertIdentityV2LifecycleDatabaseTargets(owner, app)).toMatchObject({
        port: '55432',
        database: 'global_identity_acceptance',
      });
    },
  );

  it.each([
    [
      'remote owner',
      'postgresql://owner:secret@db.example.com:5432/global_identity_acceptance',
      'postgresql://app_user:secret@db.example.com:5432/global_identity_acceptance',
    ],
    [
      'different host',
      'postgresql://owner:secret@localhost:5432/global_identity_acceptance',
      'postgresql://app_user:secret@127.0.0.1:5432/global_identity_acceptance',
    ],
    [
      'different port',
      'postgresql://owner:secret@localhost:5432/global_identity_acceptance',
      'postgresql://app_user:secret@localhost:55432/global_identity_acceptance',
    ],
    [
      'different database',
      'postgresql://owner:secret@localhost:5432/global_identity_acceptance',
      'postgresql://app_user:secret@localhost:5432/other_identity_acceptance',
    ],
    [
      'production-shaped database',
      'postgresql://owner:secret@localhost:5432/global_identity_v2',
      'postgresql://app_user:secret@localhost:5432/global_identity_v2',
    ],
  ])('rejects %s', (_label, owner, app) => {
    expect(() => assertIdentityV2LifecycleDatabaseTargets(owner, app)).toThrow();
  });

  it('accepts only the exact restricted app_user role', () => {
    expect(() => assertIdentityV2LifecycleAppRole({
      role: 'app_user',
      superuser: false,
      bypassrls: false,
    })).not.toThrow();
    for (const role of [
      { role: 'global', superuser: false, bypassrls: false },
      { role: 'app_user', superuser: true, bypassrls: false },
      { role: 'app_user', superuser: false, bypassrls: true },
      undefined,
    ]) {
      expect(() => assertIdentityV2LifecycleAppRole(role)).toThrow();
    }
  });
});
