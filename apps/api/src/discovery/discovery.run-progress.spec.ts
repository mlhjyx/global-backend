import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery.service';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { workspaceId: '22222222-2222-4222-8222-222222222222', userId: 'u1', roles: [] } as never;

function serviceWith(tx: Record<string, unknown>) {
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  return new DiscoveryService(prisma as never, {} as never, {} as never);
}

describe('M0⑤ 进度 API', () => {
  it('returns events after a seq cursor with a replay-safe nextAfter', async () => {
    const events = [
      { seq: 5n, at: new Date('2026-11-04T04:00:00Z'), level: 'info', type: 'phase_started', payload: { phase: 'quick' } },
      { seq: 6n, at: new Date('2026-11-04T04:01:00Z'), level: 'info', type: 'company_done', payload: { companyId: 'c1' } },
    ];
    const findMany = vi.fn(async () => events);
    const tx = {
      discoveryRun: { findUnique: async () => ({ id: RUN_ID, status: 'RUNNING' }) },
      runEvent: { findMany },
    };

    await expect(serviceWith(tx).listRunEvents(CTX, RUN_ID, 4, 100)).resolves.toEqual({
      status: 'RUNNING',
      events: [
        { seq: 5, at: '2026-11-04T04:00:00.000Z', level: 'info', type: 'phase_started', payload: { phase: 'quick' } },
        { seq: 6, at: '2026-11-04T04:01:00.000Z', level: 'info', type: 'company_done', payload: { companyId: 'c1' } },
      ],
      nextAfter: 6,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { runId: RUN_ID, seq: { gt: 4n } },
      orderBy: { seq: 'asc' },
      take: 100,
      select: { seq: true, at: true, level: true, type: true, payload: true },
    });
  });

  it('keeps the cursor when no newer event exists (idle polling)', async () => {
    const tx = {
      discoveryRun: { findUnique: async () => ({ id: RUN_ID, status: 'DONE' }) },
      runEvent: { findMany: async () => [] },
    };
    await expect(serviceWith(tx).listRunEvents(CTX, RUN_ID, 9)).resolves.toMatchObject({
      status: 'DONE',
      events: [],
      nextAfter: 9,
    });
  });

  it('404s events for an unknown run', async () => {
    const tx = { discoveryRun: { findUnique: async () => null } };
    await expect(serviceWith(tx).listRunEvents(CTX, RUN_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('joins company names onto the job queue page and exposes the cursor', async () => {
    const jobs = [
      { id: 'j1', canonicalCompanyId: 'c1', stage: 'quick_judged', verdictQuick: 'match', verdictDeep: null, lastErrorCode: null, costCents: 0, startedAt: null, finishedAt: null },
      { id: 'j2', canonicalCompanyId: 'c2', stage: 'done', verdictQuick: 'weak', verdictDeep: 'match', lastErrorCode: null, costCents: 3, startedAt: new Date('2026-11-04T04:00:00Z'), finishedAt: new Date('2026-11-04T04:02:00Z') },
    ];
    const tx = {
      discoveryRun: { findUnique: async () => ({ id: RUN_ID }) },
      discoveryCompanyJob: { findMany: async () => jobs },
      canonicalCompany: {
        findMany: async () => [
          { id: 'c1', name: 'Acme', domain: 'acme.de', country: 'DE' },
          { id: 'c2', name: 'Beta', domain: 'beta.de', country: 'DE' },
        ],
      },
    };

    const page = await serviceWith(tx).listRunJobs(CTX, RUN_ID, { limit: 2 });
    expect(page.data).toEqual([
      expect.objectContaining({ id: 'j1', companyId: 'c1', name: 'Acme', stage: 'quick_judged', verdictQuick: 'match' }),
      expect.objectContaining({ id: 'j2', companyId: 'c2', name: 'Beta', stage: 'done', verdictDeep: 'match', costCents: 3 }),
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
