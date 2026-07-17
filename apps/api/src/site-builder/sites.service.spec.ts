import { describe, expect, it } from 'vitest';
import { HttpException, NotFoundException } from '@nestjs/common';
import { SitesService } from './sites.service';
import { ProfilePrecondition } from './profile-contract';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const V0 = '33333333-3333-4333-8333-333333333333';
const BODY_PRECONDITION: ProfilePrecondition = {
  expectedVersionId: V0,
  source: 'baseVersionId',
};

function makeService(rows: Record<string, unknown>[] = [], assets: Array<{ id: string; kind: string }> = []) {
  const db = { sites: rows.map((r) => ({ ...r })) };
  const tx = {
    $queryRaw: async () =>
      assets.map((asset) => ({
        ...asset,
        processingStatus: 'ready',
        contentHash: 'a'.repeat(64),
      })),
    site: {
      findMany: async () => db.sites,
      findUnique: async ({ where }: { where: { id: string } }) => db.sites.find((s) => s.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.sites.find((s) => s.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; profileVersionId: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.sites.find((s) => s.id === where.id && s.profileVersionId === where.profileVersionId);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    asset: {
      findMany: async () => assets,
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
  profile: { brand: { slogan: 'Initial profile' } },
  profileVersionId: V0,
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
    const merged = await service.patchProfile(
      CTX,
      SITE_ID,
      { contact: { publicEmails: ['sales@acmepump.com'] } },
      BODY_PRECONDITION,
    );
    expect(merged).toMatchObject({
      brand: { slogan: 'Initial profile' },
      contact: { publicEmails: ['sales@acmepump.com'] },
    });
    expect(merged.versionId).not.toBe(V0);
    expect((db.sites[0] as Record<string, unknown>).profile).toEqual({
      brand: { slogan: 'Initial profile' },
      contact: { publicEmails: ['sales@acmepump.com'] },
    });
    expect((db.sites[0] as Record<string, unknown>).profileVersionId).toBe(merged.versionId);
  });

  it('patchProfile 站点不存在 → NotFound', async () => {
    const { service } = makeService([]);
    await expect(service.patchProfile(CTX, SITE_ID, { brand: {} }, BODY_PRECONDITION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getProfile 返回档案（空档案返回 {}）', async () => {
    const { service } = makeService([{ ...SITE_ROW, profile: null }]);
    expect(await service.getProfile(CTX, SITE_ID)).toEqual({ versionId: V0 });
  });

  it('legacy Profile GET fails closed without returning values or mutating the row', async () => {
    const legacy = {
      brand: { legacyTone: 'professional-secret@example.com' },
    };
    const { service, db } = makeService([{ ...SITE_ROW, profile: legacy }]);
    const before = structuredClone(db.sites[0]);

    const error = await service.getProfile(CTX, SITE_ID).catch((reason) => reason);

    expect(error).toMatchObject({
      status: 409,
      response: {
        error: {
          code: 'PROFILE_MIGRATION_REQUIRED',
          details: {
            path: '/brand/legacyTone',
            group: 'brand',
            action: 'REPLACE_INVALID_GROUP',
          },
        },
      },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('professional-secret@example.com');
    expect(db.sites[0]).toEqual(before);
  });

  it('getProfile preserves tenant-hidden 404 precedence over migration diagnostics', async () => {
    const { service } = makeService([]);
    await expect(service.getProfile(CTX, SITE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stale body token returns stable 409 and does not write', async () => {
    const { service, db } = makeService([SITE_ROW]);
    const stale: ProfilePrecondition = {
      expectedVersionId: '44444444-4444-4444-8444-444444444444',
      source: 'baseVersionId',
    };
    await expect(service.patchProfile(CTX, SITE_ID, { brand: {} }, stale)).rejects.toMatchObject({
      status: 409,
    });
    expect(db.sites[0].profileVersionId).toBe(V0);
  });

  it('stale If-Match token returns stable 412; two same-base writes have exactly one winner', async () => {
    const { service } = makeService([SITE_ROW]);
    const header: ProfilePrecondition = {
      expectedVersionId: V0,
      source: 'if-match',
    };
    const outcomes = await Promise.allSettled([
      service.patchProfile(CTX, SITE_ID, { brand: { slogan: 'A' } }, header),
      service.patchProfile(CTX, SITE_ID, { contact: { publicEmails: ['b@example.com'] } }, header),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((result) => result.status === 'rejected');
    expect(loser?.status).toBe('rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(HttpException);
    expect((loser as PromiseRejectedResult).reason.getStatus()).toBe(412);
  });

  it('rejects an Asset UUID that cannot resolve through current workspace/site RLS', async () => {
    const { service, db } = makeService([SITE_ROW]);
    await expect(
      service.patchProfile(
        CTX,
        SITE_ID,
        { brand: { logoAssetId: '55555555-5555-4555-8555-555555555555' } },
        BODY_PRECONDITION,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.sites[0].profileVersionId).toBe(V0);
  });

  it('validates Asset references on the merged Profile, including unchanged groups', async () => {
    const logoId = '55555555-5555-4555-8555-555555555555';
    const { service, db } = makeService([{ ...SITE_ROW, profile: { brand: { logoAssetId: logoId } } }]);
    await expect(
      service.patchProfile(CTX, SITE_ID, { contact: { publicEmails: ['sales@example.com'] } }, BODY_PRECONDITION),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.sites[0].profileVersionId).toBe(V0);
  });

  it('does not let one Asset kind overwrite another reference path requirement', async () => {
    const sharedId = '55555555-5555-4555-8555-555555555555';
    const { service } = makeService([SITE_ROW], [{ id: sharedId, kind: 'cert' }]);
    await expect(
      service.patchProfile(
        CTX,
        SITE_ID,
        {
          brand: { logoAssetId: sharedId },
          trustAssets: {
            certifications: [{ name: 'ISO 9001', certificateAssetIds: [sharedId] }],
          },
        },
        BODY_PRECONDITION,
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        error: {
          details: { path: '/brand/logoAssetId', expectedKind: 'logo' },
        },
      },
    });
  });

  it('rejects a write when historical merged Profile violates the strict response schema', async () => {
    const { service, db } = makeService([{ ...SITE_ROW, profile: { brand: { legacyTone: 'professional' } } }]);
    await expect(
      service.patchProfile(CTX, SITE_ID, { contact: { publicEmails: ['sales@example.com'] } }, BODY_PRECONDITION),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.sites[0].profileVersionId).toBe(V0);
  });
});
