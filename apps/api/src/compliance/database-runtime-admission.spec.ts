import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeApplicationDatabaseRole,
  resolveApplicationDatabaseUrl,
  resolveDatabaseDeploymentStage,
  resolvePlatformOwnerDatabaseUrl,
  verifyApplicationDatabaseRole,
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
  it('accepts only the three deployment stages and prevents a production downgrade', () => {
    expect(resolveDatabaseDeploymentStage({ DEPLOYMENT_STAGE: ' PILOT ' })).toBe(
      'pilot',
    );
    expect(resolveDatabaseDeploymentStage({ NODE_ENV: 'production' })).toBe(
      'production',
    );
    expect(resolveDatabaseDeploymentStage({ NODE_ENV: 'test' })).toBe(
      'development',
    );
    expect(() =>
      resolveDatabaseDeploymentStage({ DEPLOYMENT_STAGE: 'staging' }),
    ).toThrowError(/DEPLOYMENT_STAGE_INVALID/);
    expect(() =>
      resolveDatabaseDeploymentStage({
        DEPLOYMENT_STAGE: 'development',
        NODE_ENV: 'production',
      }),
    ).toThrowError(/DEPLOYMENT_STAGE_DOWNGRADE_FORBIDDEN/);
  });

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
    expect(
      resolveApplicationDatabaseUrl({
        DEPLOYMENT_STAGE: 'pilot',
        APP_DATABASE_URL: 'postgres://app_user:secret@db.example/app',
      }),
    ).toBe('postgres://app_user:secret@db.example/app');
    expect(() =>
      resolveApplicationDatabaseUrl({ DEPLOYMENT_STAGE: 'development' }),
    ).toThrowError(/APP_DATABASE_URL_REQUIRED/);
    for (const APP_DATABASE_URL of [
      'not-a-url',
      'mysql://app_user:secret@db.example/app',
    ]) {
      expect(() =>
        resolveApplicationDatabaseUrl({
          DEPLOYMENT_STAGE: 'pilot',
          APP_DATABASE_URL,
        }),
      ).toThrowError(/APP_DATABASE_URL_INVALID/);
    }
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

  it('requires an explicit platform owner URL and never falls back to DATABASE_URL', () => {
    expect(() =>
      resolvePlatformOwnerDatabaseUrl({
        DEPLOYMENT_STAGE: 'development',
        DATABASE_URL: 'postgresql://global:secret@db.example/app',
      }),
    ).toThrowError(/OWNER_DATABASE_URL_REQUIRED/);
  });

  it('rejects owner URLs that identify app_user or alias APP_DATABASE_URL', () => {
    const appUrl = 'postgresql://app_user:secret@db.example/app';
    expect(() =>
      resolvePlatformOwnerDatabaseUrl({ OWNER_DATABASE_URL: appUrl }),
    ).toThrowError(/OWNER_DATABASE_URL_REJECTED/);
    expect(() =>
      resolvePlatformOwnerDatabaseUrl({
        OWNER_DATABASE_URL: 'postgresql://misnamed:secret@db.example/app',
        APP_DATABASE_URL: 'postgresql://misnamed:secret@db.example/app',
      }),
    ).toThrowError(/OWNER_DATABASE_URL_REJECTED/);
    expect(() =>
      resolvePlatformOwnerDatabaseUrl({
        OWNER_DATABASE_URL: 'postgresql://app%5Fuser:secret@db.example/app',
      }),
    ).toThrowError(/OWNER_DATABASE_URL_REJECTED/);
    for (const OWNER_DATABASE_URL of [
      'mysql://platform_owner:secret@db.example/app',
      'postgresql://db.example/app',
      'postgresql://%E0%A4%A:secret@db.example/app',
    ]) {
      expect(() =>
        resolvePlatformOwnerDatabaseUrl({ OWNER_DATABASE_URL }),
      ).toThrowError(/OWNER_DATABASE_URL_REJECTED/);
    }
  });

  it('accepts a distinct explicit owner URL without leaking it in failures', () => {
    const owner = 'postgresql://platform_owner:secret@db.example/app';
    expect(resolvePlatformOwnerDatabaseUrl({ OWNER_DATABASE_URL: owner })).toBe(
      owner,
    );
    let rendered = '';
    try {
      resolvePlatformOwnerDatabaseUrl({
        OWNER_DATABASE_URL: 'not-postgres-do-not-leak-owner-secret',
      });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).not.toContain('do-not-leak-owner-secret');
  });

  it('does not let a malformed APP_DATABASE_URL alter a distinct owner decision', () => {
    const owner = 'postgresql://platform_owner:secret@db.example/app';
    expect(
      resolvePlatformOwnerDatabaseUrl({
        OWNER_DATABASE_URL: owner,
        APP_DATABASE_URL: 'not-a-url',
      }),
    ).toBe(owner);
  });

  it('probes exactly one safe role row and fails closed on missing or duplicate rows', async () => {
    const safeProbe = {
      $queryRawUnsafe: vi.fn(async () => [SAFE_ROLE]),
    };
    await expect(verifyApplicationDatabaseRole(safeProbe)).resolves.toEqual(
      SAFE_ROLE,
    );
    expect(safeProbe.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(safeProbe.$queryRawUnsafe.mock.calls[0][0]).toContain(
      'rolbypassrls',
    );

    for (const rows of [[], [SAFE_ROLE, SAFE_ROLE], null]) {
      await expect(
        verifyApplicationDatabaseRole({
          $queryRawUnsafe: vi.fn(async () => rows),
        } as never),
      ).rejects.toThrowError(/APP_DATABASE_ROLE_UNVERIFIED/);
    }
  });
});
