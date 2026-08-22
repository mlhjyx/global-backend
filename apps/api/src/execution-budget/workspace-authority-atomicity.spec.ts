import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { CompanyService } from '../company/company.service';
import { DiscoveryService } from '../discovery/discovery.service';
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { workspaceExecutionBudgetRequestScope } from './execution-budget-request-scope';

vi.mock('../adapters/url-guard', () => ({
  assertPublicHttpUrl: vi.fn(async (raw: string) => new URL(raw)),
}));

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = '20000000-0000-4000-8000-000000000002';
const CTX = {
  workspaceId: WORKSPACE_ID,
  userId: '30000000-0000-4000-8000-000000000003',
  roles: ['admin'],
} as RequestContext;

function verified(tokenSha256: string): VerifiedExecutionBudgetAuthority {
  return {
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.example.test/',
    audience: 'global-backend:execution-budget',
    jti: AUTHORITY_ID,
    purpose: 'understanding.run',
    workspaceId: WORKSPACE_ID,
    subjectType: 'company',
    subjectId: `request:${'a'.repeat(64)}`,
    requestSha256: 'a'.repeat(64),
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: 1_000_000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256,
    issuedAt: 1_787_270_400,
    notBefore: 1_787_270_400,
    expiresAt: 1_787_270_700,
  };
}

describe('workspace authority transaction and replay semantics', () => {
  it('commits execute authority/account, preallocated run and outbox in one workspace transaction', async () => {
    const order: string[] = [];
    const transaction = {
      discoveryQueryPlan: {
        findUnique: vi.fn(async () => {
          order.push('plan');
          return { id: 'plan-1', status: 'READY', icpId: 'icp-1' };
        }),
      },
      discoveryRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('run');
          return { ...data, status: 'QUEUED' };
        }),
      },
      outboxEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          order.push('outbox');
          return data;
        }),
      },
    };
    const verifiedAuthority = verified('b'.repeat(64));
    const binding = {
      authorityId: AUTHORITY_ID,
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
      purpose: 'discovery.run' as const,
      subjectType: 'discovery_run',
      subjectId: `request:${'c'.repeat(64)}`,
    };
    const authority = {
      verifyWorkspaceGrant: vi.fn(async () => {
        order.push('verify');
        return verifiedAuthority;
      }),
      consumeVerifiedWorkspaceGrantInTransaction: vi.fn(async (input, tx) => {
        expect(input).toBe(verifiedAuthority);
        expect(tx).toBe(transaction);
        order.push('consume');
        return binding;
      }),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, callback) => {
        order.push('transaction');
        return callback(transaction);
      }),
    };
    const service = new DiscoveryService(
      prisma as never,
      {} as never,
      authority as never,
    );

    const result = await service.executePlan(CTX, 'plan-1', 'grant');

    expect(result).toMatchObject({ status: 'QUEUED' });
    expect(order).toEqual(['verify', 'transaction', 'consume', 'plan', 'run', 'outbox']);
    expect(transaction.discoveryRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        workspaceId: WORKSPACE_ID,
      }),
    });
    expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        payload: expect.objectContaining({
          executionBudget: {
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
            purpose: binding.purpose,
            subjectType: binding.subjectType,
            subjectId: binding.subjectId,
          },
        }),
      }),
    });
  });

  it('returns an existing company for a valid new grant without consuming it', async () => {
    const firstToken = 'first.header.payload.signature';
    const nextToken = 'next.header.payload.signature';
    let prior: { response: unknown; requestHash: string | null } | null = null;
    const company = {
      id: '40000000-0000-4000-8000-000000000004',
      workspaceId: WORKSPACE_ID,
      name: 'Acme',
      website: 'https://93.184.216.34',
      status: 'DRAFT',
      version: 1,
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    };
    const tx = {
      idempotencyKey: {
        findUnique: vi.fn(async () => prior),
        create: vi.fn(async ({ data }: { data: typeof prior }) => {
          prior = data;
          return data;
        }),
      },
      workspace: { upsert: vi.fn(async () => ({})) },
      companyProfile: { create: vi.fn(async () => company) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const consume = vi.fn(async () => ({
      authorityId: AUTHORITY_ID,
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: 'understanding.run:company:request',
      purpose: 'understanding.run',
      subjectType: 'company',
      subjectId: 'request',
    }));
    const authority = {
      verifyWorkspaceGrant: vi.fn(async ({ compactJws }: { compactJws?: string }) =>
        verified(
          createHash('sha256')
            .update(compactJws ?? '')
            .digest('hex'),
        ),
      ),
      consumeVerifiedWorkspaceGrantInTransaction: consume,
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
    };
    const service = new CompanyService(prisma as never, authority as never);

    const first = await service.create(
      CTX,
      { website: company.website, name: company.name },
      'idem-1',
      firstToken,
    );
    const replay = await service.create(
      CTX,
      { website: company.website, name: company.name },
      'idem-1',
      nextToken,
    );

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ company, replayed: true });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(tx.companyProfile.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('allows only the exact consumed token to replay after expiry', async () => {
    const exactToken = 'exact.header.payload.signature';
    const input = { website: 'https://93.184.216.34', name: 'Acme' };
    const requestHash = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: input,
    }).requestSha256;
    const company = {
      id: '40000000-0000-4000-8000-000000000004',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    };
    const prior = {
      requestHash,
      response: {
        schemaVersion: 'company-authority-replay/v1',
        requestSha256: requestHash,
        authorityTokenSha256: createHash('sha256').update(exactToken).digest('hex'),
        company,
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, callback) =>
        callback({ idempotencyKey: { findUnique: vi.fn(async () => prior) } }),
      ),
    };
    const authority = {
      verifyWorkspaceGrant: vi.fn(async () => {
        throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_EXPIRED');
      }),
      consumeVerifiedWorkspaceGrantInTransaction: vi.fn(),
    };
    const service = new CompanyService(prisma as never, authority as never);

    await expect(
      service.create(CTX, input, 'idem-1', exactToken),
    ).resolves.toMatchObject({ replayed: true, company: { id: company.id } });
    await expect(
      service.create(CTX, input, 'idem-1', 'different.token'),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
    expect(authority.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
  });
});
