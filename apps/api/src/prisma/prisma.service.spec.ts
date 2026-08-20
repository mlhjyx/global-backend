import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isAuthorizedAppDatabasePrincipal,
  PrismaService,
} from './prisma.service';

const safePrincipal = Object.freeze({
  sessionUser: 'app_user',
  currentUser: 'app_user',
  rolSuper: false,
  rolBypassRls: false,
  rolCreateDb: false,
  rolCreateRole: false,
  rolReplication: false,
  rolInherit: true,
  memberships: [] as string[],
});

describe('PrismaService degraded bootstrap', () => {
  it('never falls back from the tenant app role URL to the owner URL', () => {
    const source = readFileSync(join(import.meta.dirname, 'prisma.service.ts'), 'utf8');
    expect(source).not.toContain('process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL');
    expect(source).not.toMatch(/datasourceUrl:\s*process\.env\.DATABASE_URL/);
  });

  it('does not abort HTTP bootstrap when the database is temporarily unavailable', async () => {
    const service = new PrismaService();
    Object.assign(service as object, {
      $connect: vi.fn(async () => {
        throw new Error('postgresql://owner:secret@db/customer');
      }),
      $queryRawUnsafe: vi.fn(async () => [safePrincipal]),
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.getReadiness()).toEqual({
      status: 'not_ready',
      code: 'DATABASE_UNAVAILABLE',
    });
    expect(JSON.stringify(service.getReadiness())).not.toContain('secret');
  });

  it('recovers readiness after a bounded reconnect succeeds', async () => {
    const connect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    const service = new PrismaService();
    Object.assign(service as object, {
      $connect: connect,
      $queryRawUnsafe: vi.fn(async () => [safePrincipal]),
    });

    await service.onModuleInit();
    await expect(service.reconnect()).resolves.toEqual({ status: 'ready' });
    expect(service.getReadiness()).toEqual({ status: 'ready' });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('refuses superuser, BYPASSRLS, role membership and substituted principals', () => {
    expect(isAuthorizedAppDatabasePrincipal(safePrincipal)).toBe(true);
    for (const unsafe of [
      { ...safePrincipal, sessionUser: 'global' },
      { ...safePrincipal, currentUser: 'global' },
      { ...safePrincipal, rolSuper: true },
      { ...safePrincipal, rolBypassRls: true },
      { ...safePrincipal, memberships: ['database_owner'] },
    ]) {
      expect(isAuthorizedAppDatabasePrincipal(unsafe)).toBe(false);
    }
  });

  it('connects but remains closed when the live database principal is privileged', async () => {
    const service = new PrismaService();
    Object.assign(service as object, {
      $connect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [{ ...safePrincipal, rolBypassRls: true }]),
    });

    await expect(service.reconnect()).resolves.toEqual({
      status: 'not_ready',
      code: 'DATABASE_PRINCIPAL_INVALID',
    });
    expect(service.getReadiness()).toEqual({
      status: 'not_ready',
      code: 'DATABASE_PRINCIPAL_INVALID',
    });
  });
});
