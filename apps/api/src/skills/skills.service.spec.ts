import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from './skills.service';

const OPERATOR_WS = '10000000-0000-4000-8000-000000000001';
const TARGET_WS = '20000000-0000-4000-8000-000000000002';

function serviceWith(responses: unknown[][]) {
  const query = vi.fn(async () => responses.shift() ?? []);
  const transaction = { $queryRaw: query };
  const withWorkspace = vi.fn(
    async (_workspaceId: string, fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction),
  );
  return {
    service: new SkillsService({ withWorkspace } as unknown as PrismaService),
    withWorkspace,
    query,
  };
}

describe('SkillsService', () => {
  it('lists the platform catalog in the operator workspace context', async () => {
    const rows = [{ skillKey: 'demo.skill', status: 'ACTIVE', currentVersion: '1.0.0' }];
    const { service, withWorkspace } = serviceWith([rows]);
    await expect(service.listSkills(OPERATOR_WS)).resolves.toEqual(rows);
    expect(withWorkspace).toHaveBeenCalledWith(OPERATOR_WS, expect.any(Function));
  });

  it('returns the platform catalog package with its version history', async () => {
    const pkg = { id: 'p', skillKey: 'demo.skill', status: 'ACTIVE' };
    const versions = [{ id: 'v2' }, { id: 'v1' }];
    const { service } = serviceWith([[pkg], versions]);
    await expect(service.getSkill(OPERATOR_WS, 'demo.skill')).resolves.toEqual({ ...pkg, versions });
  });

  it('answers 404 for an unregistered skill', async () => {
    const { service } = serviceWith([[]]);
    await expect(service.getSkill(OPERATOR_WS, 'missing.skill')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('flips the platform kill switch and pins the operator and reason', async () => {
    const { service } = serviceWith([[{ id: 'p' }]]);
    await expect(
      service.setStatus(OPERATOR_WS, 'user-1', 'demo.skill', 'DISABLED', 'hold'),
    ).resolves.toEqual({ skillKey: 'demo.skill', status: 'DISABLED', reason: 'hold' });
  });

  it('answers 404 when the kill switch names an unregistered skill', async () => {
    const { service } = serviceWith([[]]);
    await expect(
      service.setStatus(OPERATOR_WS, 'user-1', 'missing.skill', 'DISABLED', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('computes effective enablement from platform status and the workspace override', async () => {
    const active = serviceWith([[{ id: 'p', status: 'ACTIVE' }], []]);
    await expect(active.service.getWorkspaceEnablement(TARGET_WS, 'demo.skill')).resolves.toMatchObject({
      enabled: true,
      override: null,
      platformStatus: 'ACTIVE',
    });
    expect(active.withWorkspace).toHaveBeenCalledWith(TARGET_WS, expect.any(Function));

    const overriddenOff = serviceWith([
      [{ id: 'p', status: 'ACTIVE' }],
      [{ enabled: false, reason: 'pilot', updatedAt: new Date(0) }],
    ]);
    await expect(
      overriddenOff.service.getWorkspaceEnablement(TARGET_WS, 'demo.skill'),
    ).resolves.toMatchObject({ enabled: false });

    const platformOff = serviceWith([
      [{ id: 'p', status: 'DISABLED' }],
      [{ enabled: true, reason: null, updatedAt: new Date(0) }],
    ]);
    await expect(
      platformOff.service.getWorkspaceEnablement(TARGET_WS, 'demo.skill'),
    ).resolves.toMatchObject({ enabled: false, platformStatus: 'DISABLED' });
  });

  it('upserts a workspace override scoped to the target workspace', async () => {
    const row = { enabled: false, reason: 'hold', updatedAt: new Date(0) };
    const { service, withWorkspace } = serviceWith([[{ id: 'p', status: 'ACTIVE' }], [row]]);
    await expect(
      service.setWorkspaceEnablement(TARGET_WS, 'user-1', 'demo.skill', false, 'hold'),
    ).resolves.toEqual({ skillKey: 'demo.skill', workspaceId: TARGET_WS, ...row });
    expect(withWorkspace).toHaveBeenCalledWith(TARGET_WS, expect.any(Function));
  });

  it('reports whether a workspace override was removed', async () => {
    const removed = serviceWith([[{ id: 'p', status: 'ACTIVE' }], [{ id: 'e' }]]);
    await expect(
      removed.service.clearWorkspaceEnablement(TARGET_WS, 'demo.skill'),
    ).resolves.toMatchObject({ removed: true });

    const nothing = serviceWith([[{ id: 'p', status: 'ACTIVE' }], []]);
    await expect(
      nothing.service.clearWorkspaceEnablement(TARGET_WS, 'demo.skill'),
    ).resolves.toMatchObject({ removed: false });
  });

  it('answers 404 for override writes on an unregistered skill', async () => {
    const { service } = serviceWith([[]]);
    await expect(
      service.setWorkspaceEnablement(TARGET_WS, 'user-1', 'missing.skill', true, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
