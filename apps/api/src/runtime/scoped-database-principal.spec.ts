import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertScopedDatabasePrincipal,
  CUSTOMER_WORKER_OPS_DATABASE_ROLE,
  inspectScopedDatabaseUrl,
  OUTBOX_RELAY_DATABASE_ROLE,
  ScopedDatabasePrincipalError,
} from './scoped-database-principal';

const API_ROOT = resolve(import.meta.dirname, '../..');
const RUNTIME_SOURCE_EXTENSION_RE = /\.(?:ts|mts|js|mjs)$/u;
const TEST_FILE_RE = /\.(?:spec|test)\./u;
const FORBIDDEN_DATABASE_URL_RE = /\bprocess\.env\.DATABASE_URL\b/u;

function collectRuntimeSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...collectRuntimeSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      RUNTIME_SOURCE_EXTENSION_RE.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

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
    const runtimeFiles = collectRuntimeSourceFiles(resolve(API_ROOT, 'src')).sort();
    expect(runtimeFiles.length).toBeGreaterThan(0);

    const matches: string[] = [];
    for (const filePath of runtimeFiles) {
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (FORBIDDEN_DATABASE_URL_RE.test(line)) {
          matches.push(`${relative(API_ROOT, filePath)}:${index + 1}:${line.trim()}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
