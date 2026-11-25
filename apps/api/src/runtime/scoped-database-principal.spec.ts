import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertScopedDatabasePrincipal,
  CUSTOMER_WORKER_OPS_DATABASE_ROLE,
  inspectScopedDatabaseUrl,
  OUTBOX_RELAY_DATABASE_ROLE,
  ScopedDatabasePrincipalError,
} from './scoped-database-principal';

const API_ROOT = resolve(import.meta.dirname, '../..');

describe('scoped-database-principal', () => {
  it('validates scoped database URLs and forbids owner/app_user roles', () => {
    expect(inspectScopedDatabaseUrl('OUTBOX_RELAY_DATABASE_URL', undefined)).toEqual({
      status: 'failed',
      code: 'OUTBOX_RELAY_DATABASE_URL_REQUIRED',
    });
    expect(inspectScopedDatabaseUrl('OUTBOX_RELAY_DATABASE_URL', 'not-a-url')).toEqual({
      status: 'failed',
      code: 'OUTBOX_RELAY_DATABASE_URL_INVALID',
    });
    expect(
      inspectScopedDatabaseUrl(
        'OUTBOX_RELAY_DATABASE_URL',
        'postgresql://global:pw@127.0.0.1:5432/global_dev',
      ),
    ).toEqual({
      status: 'failed',
      code: 'OUTBOX_RELAY_DATABASE_URL_ROLE_INVALID',
    });
    expect(
      inspectScopedDatabaseUrl(
        'OUTBOX_RELAY_DATABASE_URL',
        'postgresql://app_user:pw@127.0.0.1:5432/global_dev',
      ),
    ).toEqual({
      status: 'failed',
      code: 'OUTBOX_RELAY_DATABASE_URL_ROLE_INVALID',
    });
    expect(
      inspectScopedDatabaseUrl(
        'OUTBOX_RELAY_DATABASE_URL',
        'postgresql://outbox_relay_worker_login:pw@127.0.0.1:5432/global_dev',
      ),
    ).toEqual({ status: 'ok' });
  });

  it('verifies pg_roles principal invariants and fails closed on superuser/bypassrls/wrong membership', async () => {
    const validRow = {
      currentUser: 'outbox_relay_worker_login',
      sessionUser: 'outbox_relay_worker_login',
      sessionRole: 'none',
      rolCanLogin: true,
      rolInherit: true,
      rolSuper: false,
      rolBypassRls: false,
      rolCreateDb: false,
      rolCreateRole: false,
      rolReplication: false,
      memberships: [OUTBOX_RELAY_DATABASE_ROLE],
    };
    const db = { $queryRaw: vi.fn(async () => [validRow]) };
    await expect(
      assertScopedDatabasePrincipal(db, OUTBOX_RELAY_DATABASE_ROLE, 'OutboxRelayService'),
    ).resolves.toEqual(validRow);

    for (const badRow of [
      { ...validRow, rolSuper: true },
      { ...validRow, rolBypassRls: true },
      { ...validRow, rolCanLogin: false },
      { ...validRow, rolInherit: false },
      { ...validRow, sessionRole: OUTBOX_RELAY_DATABASE_ROLE, currentUser: OUTBOX_RELAY_DATABASE_ROLE },
      { ...validRow, sessionUser: 'app_user', currentUser: 'app_user' },
      { ...validRow, memberships: [OUTBOX_RELAY_DATABASE_ROLE, CUSTOMER_WORKER_OPS_DATABASE_ROLE] },
      { ...validRow, memberships: [] },
    ]) {
      await expect(
        assertScopedDatabasePrincipal(
          { $queryRaw: vi.fn(async () => [badRow]) },
          OUTBOX_RELAY_DATABASE_ROLE,
          'OutboxRelayService',
        ),
      ).rejects.toBeInstanceOf(ScopedDatabasePrincipalError);
    }
  });

  it('forbids process.env.DATABASE_URL across runtime apps/api/src/', () => {
    let matches = '';
    try {
      matches = execFileSync(
        'rg',
        ['-n', '--glob', '!*.spec.*', '--glob', '!*.test.*', 'process\\.env\\.DATABASE_URL', 'src'],
        { cwd: API_ROOT, encoding: 'utf8' },
      ).trim();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    expect(matches).toBe('');
  });
});
