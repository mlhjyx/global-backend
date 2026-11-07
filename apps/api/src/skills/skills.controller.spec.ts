import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { SkillsController } from './skills.controller';
import type { SkillsService } from './skills.service';

const CTX = {
  userId: '90000000-0000-4000-8000-000000000009',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  roles: ['saas-ops'],
  scopes: ['ops:read', 'ops:write'] as const,
};

function controllerWith(overrides: Partial<Record<keyof SkillsService, unknown>> = {}) {
  const service = {
    listSkills: vi.fn(async () => []),
    getSkill: vi.fn(async () => ({ skillKey: 'x' })),
    setStatus: vi.fn(async () => ({ skillKey: 'x', status: 'DISABLED' })),
    getWorkspaceEnablement: vi.fn(async () => ({ enabled: true })),
    setWorkspaceEnablement: vi.fn(async () => ({ enabled: false })),
    clearWorkspaceEnablement: vi.fn(async () => ({ removed: true })),
    ...overrides,
  } as unknown as SkillsService;
  return { controller: new SkillsController(service), service };
}

describe('SkillsController authorization topology', () => {
  it('runs authentication before scope enforcement', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SkillsController)).toEqual([AuthGuard, ScopesGuard]);
  });

  it('requires ops scopes on every handler', () => {
    const scopesOf = (handler: keyof SkillsController) =>
      Reflect.getMetadata(REQUIRED_SCOPES_METADATA, SkillsController.prototype[handler]);
    expect(scopesOf('list')).toEqual(['ops:read']);
    expect(scopesOf('detail')).toEqual(['ops:read']);
    expect(scopesOf('workspaceEnablement')).toEqual(['ops:read']);
    expect(scopesOf('setStatus')).toEqual(['ops:write']);
    expect(scopesOf('setWorkspaceEnablement')).toEqual(['ops:write']);
    expect(scopesOf('clearWorkspaceEnablement')).toEqual(['ops:write']);
  });
});

describe('SkillsController request validation', () => {
  it('rejects unknown status values and oversized reasons', async () => {
    const { controller } = controllerWith();
    await expect(controller.setStatus(CTX, 'demo.skill', { status: 'PAUSED' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.setStatus(CTX, 'demo.skill', { status: 'DISABLED', reason: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the operator and platform status on a kill switch', async () => {
    const { controller, service } = controllerWith();
    const result = await controller.setStatus(CTX, 'demo.skill', {
      status: 'DISABLED',
      reason: 'quality hold',
    });
    expect(result).toEqual({ data: { skillKey: 'x', status: 'DISABLED' } });
    expect(service.setStatus).toHaveBeenCalledWith(
      CTX.workspaceId,
      CTX.userId,
      'demo.skill',
      'DISABLED',
      'quality hold',
    );
  });

  it('requires a boolean enabled flag for workspace overrides', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.setWorkspaceEnablement(CTX, 'demo.skill', '20000000-0000-4000-8000-000000000002', {
        enabled: 'false',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes the target workspace (not the operator workspace) to override writes', async () => {
    const { controller, service } = controllerWith();
    const target = '20000000-0000-4000-8000-000000000002';
    await controller.setWorkspaceEnablement(CTX, 'demo.skill', target, { enabled: false });
    expect(service.setWorkspaceEnablement).toHaveBeenCalledWith(
      target,
      CTX.userId,
      'demo.skill',
      false,
      undefined,
    );
  });
});
