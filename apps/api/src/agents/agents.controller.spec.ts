import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { AgentsController } from './agents.controller';
import type { AgentsService } from './agents.service';

const CTX = {
  userId: '90000000-0000-4000-8000-000000000009',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  roles: ['saas-ops'],
  scopes: ['ops:read', 'ops:write'] as const,
};

function controllerWith(overrides: Partial<Record<keyof AgentsService, unknown>> = {}) {
  const service = {
    listAgents: vi.fn(async () => []),
    setStatus: vi.fn(async () => ({ agentKey: 'discovery.qualifier', status: 'DISABLED' })),
    ...overrides,
  } as unknown as AgentsService;
  return { controller: new AgentsController(service), service };
}

describe('AgentsController authorization topology', () => {
  it('runs authentication before scope enforcement', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentsController)).toEqual([AuthGuard, ScopesGuard]);
  });

  it('requires ops scopes on every handler (tenant tokens are rejected)', () => {
    const scopesOf = (handler: keyof AgentsController) =>
      Reflect.getMetadata(REQUIRED_SCOPES_METADATA, AgentsController.prototype[handler]);
    expect(scopesOf('list')).toEqual(['ops:read']);
    expect(scopesOf('setStatus')).toEqual(['ops:write']);
  });
});

describe('AgentsController request validation', () => {
  it('rejects unknown status values and oversized reasons', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.setStatus(CTX, 'discovery.qualifier', { status: 'PAUSED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.setStatus(CTX, 'discovery.qualifier', {
        status: 'DISABLED',
        reason: 'x'.repeat(501),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the operator and platform status on a kill switch', async () => {
    const { controller, service } = controllerWith();
    await controller.setStatus(CTX, 'discovery.qualifier', {
      status: 'DISABLED',
      reason: 'e2e 9b',
    });
    expect(service.setStatus).toHaveBeenCalledWith(
      CTX.workspaceId,
      CTX.userId,
      'discovery.qualifier',
      'DISABLED',
      'e2e 9b',
    );
  });
});
