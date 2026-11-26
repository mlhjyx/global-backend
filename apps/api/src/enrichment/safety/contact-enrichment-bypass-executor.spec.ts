import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { createBypassContactEnrichmentSafetyExecutor } from './contact-enrichment-bypass-executor';

const W = '10000000-0000-4000-8000-000000000001';
const C = '10000000-0000-4000-8000-000000000002';
const RUN = '10000000-0000-4000-8000-000000000003';
const AUTH = '10000000-0000-4000-8000-000000000004';
const REF = 'a'.repeat(64);

function createMockPrisma(opts: {
  tierScore?: number | null;
  prospeoEnabled?: boolean;
  emailableEnabled?: boolean;
  headRows?: unknown[];
} = {}) {
  const prospeoEnabled = opts.prospeoEnabled ?? true;
  const emailableEnabled = opts.emailableEnabled ?? true;
  return {
    dataProvider: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (where.key === 'prospeo') return { key: 'prospeo', status: prospeoEnabled ? 'ENABLED' : 'DISABLED' };
        if (where.key === 'emailable') return { key: 'emailable', status: emailableEnabled ? 'ENABLED' : 'DISABLED' };
        return { key: where.key, status: 'DISABLED' };
      }),
    },
    sourcePolicy: {
      findUnique: vi.fn(async () => ({ status: 'ALLOWED' })),
    },
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        lead: {
          findFirst: vi.fn(async () =>
            opts.tierScore !== undefined ? { totalScore: opts.tierScore } : { totalScore: 0.5 },
          ),
        },
        $queryRaw: vi.fn(async () => opts.headRows ?? []),
      }),
    ),
  };
}

describe('contact-enrichment-bypass-executor (F8 bypass parity)', () => {
  it('enforces lawful basis before waterfall execution', async () => {
    const prisma = createMockPrisma();
    const runWaterfall = vi.fn();
    const executor = createBypassContactEnrichmentSafetyExecutor({
      prisma: prisma as never,
      env: { PROSPEO_API_KEY: 'test-prospeo', EMAILABLE_API_KEY: 'test-emailable' },
      broker: { checkSourcePolicy: vi.fn(), invoke: vi.fn() } as never,
      runWaterfall,
    });

    await expect(
      executor.executeHttp({ userId: 'u-1', workspaceId: W, roles: [], scopes: [] } as never, C, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(runWaterfall).not.toHaveBeenCalled();
  });

  it('routes prospeo + emailable through direct waterfall without touching execution_budget_authority', async () => {
    const prisma = createMockPrisma({ prospeoEnabled: true, emailableEnabled: true });
    const runWaterfall = vi.fn(async (deps, input) => {
      expect(deps.finders.map((f: { key: string }) => f.key)).toEqual(['prospeo']);
      expect(deps.verifiers?.map((v: { key: string }) => v.key)).toContain('emailable');
      expect(input.lawfulBasis).toEqual({ basis: 'legitimate_interest' });
      return {
        companyId: C,
        tier: 'B' as const,
        attempted: 1,
        costMicrousd: 1700,
        deadlineHit: false,
        results: [{ contactId: 'c-1', status: 'stored' as const }],
      };
    });
    const executor = createBypassContactEnrichmentSafetyExecutor({
      prisma: prisma as never,
      env: { PROSPEO_API_KEY: 'test-prospeo', EMAILABLE_API_KEY: 'test-emailable' },
      broker: { checkSourcePolicy: vi.fn(), invoke: vi.fn() } as never,
      runWaterfall,
    });

    const httpResult = await executor.executeHttp(
      { userId: 'u-1', workspaceId: W, roles: [], scopes: [] } as never,
      C,
      { lawfulBasis: { basis: 'legitimate_interest' }, maxProviders: 2, maxProbe: 4 },
    );
    expect(httpResult).toMatchObject({
      admission: 'ADMITTED',
      companyId: C,
      results: [{ contactId: 'c-1', status: 'stored' }],
    });

    const runResult = await executor.executeRun({
      workspaceId: W,
      companyId: C,
      businessRunId: RUN,
      binding: {
        authorityId: AUTH,
        replay: false,
        scopeKey: W,
        accountKey: `discovery.run:discovery_run:request:${REF}:${REF}`,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
        subjectId: `request:${REF}`,
        requestSha256: REF,
      },
      lawfulBasis: { basis: 'legitimate_interest' },
      remainingMicrousd: '250000',
      actorId: 'discovery-run:test',
    });
    expect(runResult.admission).toBe('ADMITTED');
    expect(runWaterfall).toHaveBeenCalledTimes(2);
  });

  it('returns NOT_ADMITTED when no finder is configured or enabled', async () => {
    const prisma = createMockPrisma({ prospeoEnabled: false });
    const executor = createBypassContactEnrichmentSafetyExecutor({
      prisma: prisma as never,
      env: {},
      broker: { checkSourcePolicy: vi.fn(), invoke: vi.fn() } as never,
      runWaterfall: vi.fn(),
    });
    const noConfig = await executor.executeHttp(
      { userId: 'u-1', workspaceId: W, roles: [], scopes: [] } as never,
      C,
      { lawfulBasis: { basis: 'legitimate_interest' } },
    );
    expect(noConfig).toMatchObject({ admission: 'NOT_ADMITTED', reasonCode: 'NO_CONFIGURED_FINDER' });

    const disabledExecutor = createBypassContactEnrichmentSafetyExecutor({
      prisma: prisma as never,
      env: { PROSPEO_API_KEY: 'test-prospeo' },
      broker: { checkSourcePolicy: vi.fn(), invoke: vi.fn() } as never,
      runWaterfall: vi.fn(),
    });
    const disabled = await disabledExecutor.executeHttp(
      { userId: 'u-1', workspaceId: W, roles: [], scopes: [] } as never,
      C,
      { lawfulBasis: { basis: 'legitimate_interest' } },
    );
    expect(disabled).toMatchObject({ admission: 'NOT_ADMITTED', reasonCode: 'NO_ENABLED_FINDER' });
  });

  it('enforces recovery scopes and reads historical execution safely in bypass mode', async () => {
    const prisma = createMockPrisma({ headRows: [] });
    const executor = createBypassContactEnrichmentSafetyExecutor({
      prisma: prisma as never,
      env: {},
      broker: { checkSourcePolicy: vi.fn(), invoke: vi.fn() } as never,
    });

    await expect(
      executor.recoverEnrichmentExecution(
        { userId: 'u-1', workspaceId: W, roles: [], scopes: ['acquisition:write'] } as never,
        C,
        REF,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      executor.recoverEnrichmentExecution(
        {
          userId: 'u-1',
          workspaceId: W,
          roles: [],
          scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'],
        } as never,
        C,
        REF,
      ),
    ).resolves.toBeNull();
  });
});
