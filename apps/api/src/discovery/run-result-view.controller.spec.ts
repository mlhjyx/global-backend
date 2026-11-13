import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import { RunResultViewController } from './run-result-view.controller';

const CTX: RequestContext = { userId: 'u1', workspaceId: 'ws1', roles: ['admin'] };

const RUN = { id: 'run-1', icpId: 'icp-1', status: 'DONE', completedAt: null };

function fixture(run: unknown) {
  const tx = {
    discoveryRun: { findUnique: vi.fn(async () => run) },
    discoveryCompanyJob: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    canonicalCompany: { findMany: vi.fn(async () => []) },
    runEvent: { findMany: vi.fn(async () => []) },
    lead: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspace: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

describe('RunResultViewController (PR-06a)', () => {
  it('reads the view inside the caller workspace and envelopes it', async () => {
    const { prisma } = fixture(RUN);
    const controller = new RunResultViewController(prisma as unknown as PrismaService);

    const response = await controller.getRunResultView(CTX, 'run-1');

    expect(prisma.withWorkspace).toHaveBeenCalledWith(CTX.workspaceId, expect.any(Function));
    expect(response).toMatchObject({
      data: {
        runId: 'run-1',
        icpId: 'icp-1',
        status: 'DONE',
        candidates: { total: 0, truncated: false, items: [] },
        scoring: {
          thisRun: { available: false, label: 'not_scored_in_run', batches: 0 },
          latest: { label: 'latest_not_necessarily_this_run', items: [] },
        },
      },
    });
  });

  it('answers 404 when the run is not visible in the workspace', async () => {
    const { prisma } = fixture(null);
    const controller = new RunResultViewController(prisma as unknown as PrismaService);

    await expect(controller.getRunResultView(CTX, 'run-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
