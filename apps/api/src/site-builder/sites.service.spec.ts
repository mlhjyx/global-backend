import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SitesService } from './sites.service';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function makeService(rows: Record<string, unknown>[] = []) {
  const db = { sites: rows.map((r) => ({ ...r })) };
  const tx = {
    site: {
      findMany: async () => db.sites,
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.sites.find((s) => s.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.sites.find((s) => s.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  return { service: new SitesService(prisma as never), db };
}

const SITE_ROW = {
  id: SITE_ID,
  workspaceId: CTX.workspaceId,
  name: 'Acme Pump',
  slug: 'acme-pump-ab12cd',
  mode: 'builder',
  status: 'ready',
  stylePreset: null,
  locales: ['en'],
  activeVersionId: null,
  intake: {},
  profile: { brand: { tone: 'professional' } },
  createdAt: new Date('2026-07-14T00:00:00Z'),
  updatedAt: new Date('2026-07-14T00:00:00Z'),
};

describe('SitesService（站点列表/详情/向导档案，07 §2）', () => {
  it('list 返回本 workspace 站点（RLS 已兜底，服务不重复过滤）', async () => {
    const { service } = makeService([SITE_ROW]);
    const rows = await service.list(CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(SITE_ID);
  });

  it('get 未命中 → NotFound', async () => {
    const { service } = makeService([]);
    await expect(service.get(CTX, SITE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('patchProfile 组级合并并落库；返回合并后的档案', async () => {
    const { service, db } = makeService([SITE_ROW]);
    const merged = await service.patchProfile(CTX, SITE_ID, {
      contact: { inboxEmail: 'sales@acmepump.com' },
    });
    expect(merged).toEqual({
      brand: { tone: 'professional' },
      contact: { inboxEmail: 'sales@acmepump.com' },
    });
    expect((db.sites[0] as Record<string, unknown>).profile).toEqual(merged);
  });

  it('patchProfile 未知组名 → BadRequest（白名单五组）', async () => {
    const { service } = makeService([SITE_ROW]);
    await expect(
      service.patchProfile(CTX, SITE_ID, { evilGroup: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('patchProfile 站点不存在 → NotFound', async () => {
    const { service } = makeService([]);
    await expect(service.patchProfile(CTX, SITE_ID, { brand: {} })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getProfile 返回档案（空档案返回 {}）', async () => {
    const { service } = makeService([{ ...SITE_ROW, profile: null }]);
    expect(await service.getProfile(CTX, SITE_ID)).toEqual({});
  });
});
