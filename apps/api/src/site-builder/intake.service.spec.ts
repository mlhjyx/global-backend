import { describe, expect, it } from 'vitest';
import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { IntakeService } from './intake.service';
import type { DemoV0Launcher } from './demo-launcher';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };

const BASE_INTAKE = {
  company: { nameZh: '杭州爱克姆泵业有限公司', nameEn: 'Acme Pump Co., Ltd.' },
  industry: 'isic-2813',
  products: ['centrifugal pump', 'screw pump'],
  targetMarkets: ['DE', 'US'],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: 'sales@acmepump.com',
};

interface FakeDb {
  sites: Record<string, unknown>[];
  runs: Record<string, unknown>[];
}

function makeService(opts: { existingSite?: boolean; launcher?: DemoV0Launcher } = {}) {
  const db: FakeDb = { sites: [], runs: [] };
  if (opts.existingSite) db.sites.push({ id: 'existing', workspaceId: CTX.workspaceId });
  const tx = {
    $executeRaw: async () => 0, // advisory lock no-op
    site: {
      findFirst: async () => db.sites[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'site-1', ...data };
        db.sites.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = db.sites.findIndex((s) => s.id === where.id);
        if (i >= 0) db.sites.splice(i, 1);
      },
    },
    siteBuildRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'run-1', ...data };
        db.runs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.runs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const launched: string[] = [];
  const launcher: DemoV0Launcher =
    opts.launcher ??
    ({
      launchDemoV0: async ({ siteId }: { siteId: string }) => {
        launched.push(siteId);
      },
    } as DemoV0Launcher);
  const service = new IntakeService(prisma as never, launcher);
  return { service, db, launched };
}

describe('IntakeService（注册引导 → 建档 + demo v0，01 §2 / 07 §1）', () => {
  it('无站路径：建 site（mode=builder，status=building，slug 合法）+ demo_v0 run + 触发 launcher', async () => {
    const { service, db, launched } = makeService();
    const res = await service.create(CTX, BASE_INTAKE);

    expect(res).toEqual({ siteId: 'site-1', mode: 'builder', status: 'building' });
    const site = db.sites[0] as Record<string, unknown>;
    expect(site.workspaceId).toBe(CTX.workspaceId);
    expect(site.mode).toBe('builder');
    expect(site.status).toBe('building');
    expect(site.name).toBe('Acme Pump Co., Ltd.');
    expect(site.slug).toMatch(/^acme-pump-co-ltd-[a-z0-9]{6}$/);
    expect(site.intake).toEqual(BASE_INTAKE);
    expect(site.locales).toEqual(['en']);

    const run = db.runs[0] as Record<string, unknown>;
    expect(run.kind).toBe('demo_v0');
    expect(run.status).toBe('queued');
    expect(run.siteId).toBe('site-1');
    expect(launched).toEqual(['site-1']);
  });

  it('有站路径：hasWebsite=true 也无条件建 demo（mode=builder/status=building/建 run/触发 launcher）——只作背景知识不分叉（R0-2，01 §2.1 / DoD-1）', async () => {
    const { service, db, launched } = makeService();
    const res = await service.create(CTX, {
      ...BASE_INTAKE,
      hasWebsite: true,
      websiteUrl: 'https://www.acmepump.com',
    });

    // 与无站路径同一结果：无条件建 demo
    expect(res).toEqual({ siteId: 'site-1', mode: 'builder', status: 'building' });
    expect(db.runs).toHaveLength(1);
    const run = db.runs[0] as Record<string, unknown>;
    expect(run.kind).toBe('demo_v0');
    expect(run.status).toBe('queued');
    expect(launched).toEqual(['site-1']);
    // hasWebsite/websiteUrl 仍作背景知识存入 intake（供后续 M3 诊断，不再分叉栏目）
    const site = db.sites[0] as Record<string, unknown>;
    const intake = site.intake as Record<string, unknown>;
    expect(intake.hasWebsite).toBe(true);
    expect(intake.websiteUrl).toBe('https://www.acmepump.com');
  });

  it('hasWebsite=true 但缺 websiteUrl → BadRequest（服务层兜底，不信 DTO 层）', async () => {
    const { service } = makeService();
    await expect(
      service.create(CTX, { ...BASE_INTAKE, hasWebsite: true, websiteUrl: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('workspace 已有站点 → Conflict（v1 每 workspace 限 1 站）', async () => {
    const { service } = makeService({ existingSite: true });
    await expect(service.create(CTX, BASE_INTAKE)).rejects.toBeInstanceOf(ConflictException);
  });

  it('launcher 抛错：补偿回滚（site 删除，级联 run）+ 502 上抛——re-intake 可重试不撞 409', async () => {
    const failing: DemoV0Launcher = {
      launchDemoV0: async () => {
        throw new Error('temporal unreachable');
      },
    };
    const { service, db } = makeService({ launcher: failing });
    await expect(service.create(CTX, BASE_INTAKE)).rejects.toBeInstanceOf(BadGatewayException);
    expect(db.sites).toHaveLength(0); // 站点已回滚
    // 回滚后同 workspace 再次 intake 成功（不因残留 409）
    const ok = await service.create(CTX, BASE_INTAKE).catch(() => null);
    expect(ok).toBeNull(); // 仍是 failing launcher → 依旧 502，但不是 Conflict
  });

  it('无英文名：站名用中文名，slug 退 site- 前缀', async () => {
    const { service, db } = makeService();
    await service.create(CTX, { ...BASE_INTAKE, company: { nameZh: '杭州泵业', nameEn: null } });
    const site = db.sites[0] as Record<string, unknown>;
    expect(site.name).toBe('杭州泵业');
    expect(site.slug).toMatch(/^site-[a-z0-9]{6}$/);
  });
});
