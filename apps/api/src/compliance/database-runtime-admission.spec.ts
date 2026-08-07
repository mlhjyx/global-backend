import { describe, expect, it } from 'vitest';
import {
  assertSafeApplicationDatabaseRole,
  resolveApplicationDatabaseUrl,
  type ApplicationDatabaseRoleFacts,
} from './database-runtime-admission';

const SAFE_ROLE: ApplicationDatabaseRoleFacts = {
  roleName: 'app_user',
  superuser: false,
  bypassRls: false,
  databaseOwnerMember: false,
  ownsApplicationRelations: false,
};

describe('application database runtime admission', () => {
  it.each(['pilot', 'production'] as const)(
    '%s requires APP_DATABASE_URL and never falls back to DATABASE_URL',
    (deploymentStage) => {
      expect(() =>
        resolveApplicationDatabaseUrl({
          DEPLOYMENT_STAGE: deploymentStage,
          DATABASE_URL: 'postgresql://owner:secret@db.example/app',
        }),
      ).toThrowError(/APP_DATABASE_URL_REQUIRED/);
    },
  );

  it('allows the legacy DATABASE_URL fallback only in explicit development', () => {
    expect(
      resolveApplicationDatabaseUrl({
        DEPLOYMENT_STAGE: 'development',
        DATABASE_URL: 'postgresql://dev:dev@127.0.0.1/app',
      }),
    ).toBe('postgresql://dev:dev@127.0.0.1/app');
  });

  it('does not include credential-bearing URLs in admission errors', () => {
    const secretUrl = 'postgresql://owner:do-not-leak@db.example/app';
    let message = '';
    try {
      resolveApplicationDatabaseUrl({
        DEPLOYMENT_STAGE: 'pilot',
        DATABASE_URL: secretUrl,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(secretUrl);
    expect(message).not.toContain('do-not-leak');
  });

  it('admits only a non-owner, non-superuser, non-BYPASSRLS role', () => {
    expect(assertSafeApplicationDatabaseRole(SAFE_ROLE)).toEqual(SAFE_ROLE);

    for (const unsafe of [
      { ...SAFE_ROLE, superuser: true },
      { ...SAFE_ROLE, bypassRls: true },
      { ...SAFE_ROLE, databaseOwnerMember: true },
      { ...SAFE_ROLE, ownsApplicationRelations: true },
    ]) {
      expect(() => assertSafeApplicationDatabaseRole(unsafe)).toThrowError(
        /APP_DATABASE_ROLE_UNSAFE/,
      );
    }
  });

  it('fails closed on malformed or incomplete database role facts', () => {
    expect(() =>
      assertSafeApplicationDatabaseRole({
        ...SAFE_ROLE,
        roleName: '',
      }),
    ).toThrowError(/APP_DATABASE_ROLE_UNVERIFIED/);
    expect(() =>
      assertSafeApplicationDatabaseRole({
        ...SAFE_ROLE,
        bypassRls: undefined as never,
      }),
    ).toThrowError(/APP_DATABASE_ROLE_UNVERIFIED/);
  });
});
