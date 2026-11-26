import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { UpdateWorkspaceDto } from './dto/workspace.dto';
import { WorkspaceController } from './workspace.controller';
import type { WorkspaceService } from './workspace.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['ADMIN'],
  scopes: ['acquisition:read', 'acquisition:write'],
};

describe('WorkspaceController', () => {
  it('enforces AuthGuard + ScopesGuard and required scopes on handlers', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WorkspaceController)).toEqual([
      AuthGuard,
      ScopesGuard,
    ]);
    expect(
      Reflect.getMetadata(
        REQUIRED_SCOPES_METADATA,
        WorkspaceController.prototype.update,
      ),
    ).toEqual(['acquisition:write']);
    expect(
      Reflect.getMetadata(
        REQUIRED_SCOPES_METADATA,
        WorkspaceController.prototype.usageSummary,
      ),
    ).toEqual(['acquisition:read']);
  });

  it('trims UpdateWorkspaceDto name and rejects blank or overlong names', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const meta = { type: 'body' as const, metatype: UpdateWorkspaceDto };

    const valid = await pipe.transform({ name: '  Acme Export Co.  ' }, meta);
    expect(valid).toBeInstanceOf(UpdateWorkspaceDto);
    expect(valid.name).toBe('Acme Export Co.');

    await expect(pipe.transform({ name: '   ' }, meta)).rejects.toThrow();
    await expect(pipe.transform({ name: 'a'.repeat(129) }, meta)).rejects.toThrow();
    await expect(pipe.transform({}, meta)).rejects.toThrow();
  });

  it('wraps update and usageSummary responses in { data } envelopes', async () => {
    const now = new Date('2026-11-26T00:00:00.000Z');
    const service = {
      update: vi.fn(async () => ({
        id: CTX.workspaceId,
        name: 'Acme',
        createdAt: now,
        updatedAt: now,
      })),
      usageSummary: vi.fn(async () => ({
        workspaceId: CTX.workspaceId,
        companies: { total: 1, draft: 0, enriching: 0, review: 0, active: 1 },
        sellerDocuments: {
          total: 0,
          ready: 0,
          pendingUpload: 0,
          processing: 0,
          failed: 0,
          totalBytes: 0,
          readyBytes: 0,
          pendingUploadBytes: 0,
          quota: { maxPerWorkspace: 500, maxPerCompany: 200, maxBytesPerWorkspace: 2147483648 },
        },
        icps: { total: 0 },
        discoveryRuns: { total: 0, running: 0, completed: 0, failed: 0 },
        canonicalCompanies: { total: 0, suppressed: 0 },
        canonicalContacts: { total: 0 },
        siteAssets: { total: 0, totalBytes: 0, variants: 0, variantBytes: 0 },
        siteReleases: { total: 0, ready: 0 },
        operationArtifacts: {
          total: 0,
          totalBytes: 0,
          personalDataCount: 0,
          personalDataBytes: 0,
        },
      })),
    } as unknown as WorkspaceService;

    const controller = new WorkspaceController(service);
    const updated = await controller.update(CTX, { name: 'Acme' });
    expect(updated).toEqual({
      data: {
        id: CTX.workspaceId,
        name: 'Acme',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
    const summary = await controller.usageSummary(CTX);
    expect(summary.data.workspaceId).toBe(CTX.workspaceId);
  });
});
