import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard';
import { REQUIRED_SCOPES_METADATA } from '../../auth/require-scopes.decorator';
import { ScopesGuard } from '../../auth/scopes.guard';
import { PacksController } from './packs.controller';
import type { PackStudioService } from './pack-studio.service';

const CTX = {
  userId: '90000000-0000-4000-8000-000000000009',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  roles: ['saas-ops'],
  scopes: ['ops:read', 'ops:write'] as const,
};
const TARGET = '20000000-0000-4000-8000-000000000002';
const DRAFT = '30000000-0000-4000-8000-000000000003';

function controllerWith() {
  const service = {
    listPacks: vi.fn(async () => []),
    getPack: vi.fn(async () => ({})),
    createDraft: vi.fn(async () => ({ draftId: DRAFT })),
    updateDraft: vi.fn(async () => ({ updated: true })),
    validateDraft: vi.fn(async () => ({ issues: [] })),
    dryRunDraft: vi.fn(async () => ({ brief: '' })),
    evalDraft: vi.fn(async () => ({ passed: true })),
    publishDraft: vi.fn(async () => ({ version: '1.0.0' })),
    activateVersion: vi.fn(async () => ({ activated: true })),
    getWorkspaceEnablement: vi.fn(async () => ({ enabled: true })),
    setWorkspaceEnablement: vi.fn(async () => ({ enabled: false })),
    clearWorkspaceEnablement: vi.fn(async () => ({ removed: true })),
  } as unknown as PackStudioService;
  return { controller: new PacksController(service), service };
}

describe('PacksController authorization topology', () => {
  it('runs authentication before scope enforcement', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PacksController)).toEqual([AuthGuard, ScopesGuard]);
  });

  it('requires ops scopes on every handler', () => {
    const scopesOf = (handler: keyof PacksController) =>
      Reflect.getMetadata(REQUIRED_SCOPES_METADATA, PacksController.prototype[handler]);
    expect(scopesOf('list')).toEqual(['ops:read']);
    expect(scopesOf('detail')).toEqual(['ops:read']);
    expect(scopesOf('workspaceEnablement')).toEqual(['ops:read']);
    for (const handler of [
      'createDraft',
      'updateDraft',
      'validateDraft',
      'dryRun',
      'eval',
      'publish',
      'activate',
      'setWorkspaceEnablement',
      'clearWorkspaceEnablement',
    ] as const) {
      expect(scopesOf(handler), handler).toEqual(['ops:write']);
    }
  });
});

describe('PacksController request validation', () => {
  it('requires version and a valid scope for activation', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.activate(CTX, 'growth_motion.demo', { scope: 'platform' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.activate(CTX, 'growth_motion.demo', { version: '1.0.0', scope: 'canary' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.activate(CTX, 'growth_motion.demo', { version: '1.0.0', scope: 'workspace' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes a workspace activation through with the operator identity', async () => {
    const { controller, service } = controllerWith();
    await controller.activate(CTX, 'growth_motion.demo', {
      version: '1.0.0',
      scope: 'workspace',
      workspaceId: TARGET,
      canary: true,
    });
    expect(service.activateVersion).toHaveBeenCalledWith(
      CTX.workspaceId,
      CTX.userId,
      'growth_motion.demo',
      { version: '1.0.0', scope: 'workspace', workspaceId: TARGET, canary: true },
    );
  });

  it('validates selector arrays and boolean enablement', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.dryRun(CTX, 'growth_motion.demo', DRAFT, { markets: 'DE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.setWorkspaceEnablement(CTX, 'growth_motion.demo', TARGET, { enabled: 'false' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-string draft content and empty fromVersion', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.updateDraft(CTX, 'growth_motion.demo', DRAFT, { content: 42 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.createDraft(CTX, 'growth_motion.demo', { fromVersion: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
