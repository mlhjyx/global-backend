import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import type { PrismaService } from '../prisma/prisma.service';
import { CompanyService } from './company.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const REQUEST_SHA = 'e4a4d55a5edaf24769beabeaef26b31c501c9ee50c61bbdb1167b063dd6f87bb';

const BINDING: ExecutionBudgetBinding = {
  authorityId: '90000000-0000-4000-8000-000000000009',
  replay: false,
  scopeKey: CTX.workspaceId,
  accountKey: `understanding.run:company:request:${REQUEST_SHA}:${REQUEST_SHA}`,
  purpose: 'understanding.run',
  subjectType: 'company',
  subjectId: COMPANY_ID,
  requestSha256: REQUEST_SHA,
} as ExecutionBudgetBinding;

function fixture(company: Record<string, unknown> | null) {
  const outboxCreate = vi.fn(async () => ({ id: 'event-1' }));
  const tx = {
    companyProfile: { findUnique: vi.fn(async () => company) },
    outboxEvent: { create: outboxCreate },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const consume = vi.fn(async () => BINDING);
  const verify = vi.fn(async () => ({ tokenSha256: 'a'.repeat(64) }));
  const authority = {
    verifyWorkspaceGrant: verify,
    consumeVerifiedWorkspaceGrantInTransaction: consume,
  };
  const service = new CompanyService(
    prisma as unknown as PrismaService,
    authority as unknown as ExecutionBudgetAuthorityService,
  );
  return { service, outboxCreate, consume, verify, tx };
}

const FAILED_COMPANY = {
  id: COMPANY_ID,
  workspaceId: CTX.workspaceId,
  name: '具安科技',
  website: 'https://example.test',
  status: 'DRAFT',
  understandingFailedAt: new Date('2026-11-01T13:53:51Z'),
  understandingLastError: 'extract:ProviderHttpError',
};

describe('CompanyService.retryUnderstanding', () => {
  it('requires a workspace grant for the retry operation itself', async () => {
    const { service, verify } = fixture(FAILED_COMPANY);
    await service.retryUnderstanding(CTX, COMPANY_ID, 'jws');
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        compactJws: 'jws',
        identity: CTX,
        scope: expect.objectContaining({
          purpose: 'understanding.run',
          subjectType: 'company',
          subjectId: COMPANY_ID,
          requestSha256: REQUEST_SHA,
        }),
      }),
    );
  });

  it('rejects a company outside the workspace with 404 before consuming the grant', async () => {
    const { service, consume } = fixture(null);
    await expect(service.retryUnderstanding(CTX, COMPANY_ID, 'jws')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects retries when the profile is not a failed DRAFT', async () => {
    const enriching = { ...FAILED_COMPANY, status: 'ENRICHING' };
    const first = fixture(enriching);
    await expect(first.service.retryUnderstanding(CTX, COMPANY_ID, 'jws')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(first.consume).not.toHaveBeenCalled();

    const neverFailed = { ...FAILED_COMPANY, understandingFailedAt: null };
    const second = fixture(neverFailed);
    await expect(second.service.retryUnderstanding(CTX, COMPANY_ID, 'jws')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(second.consume).not.toHaveBeenCalled();
  });

  it('consumes the grant and re-emits the CompanyProfileCreated event for the same company', async () => {
    const { service, outboxCreate, consume } = fixture(FAILED_COMPANY);
    const result = await service.retryUnderstanding(CTX, COMPANY_ID, 'jws');
    expect(result.company).toBe(FAILED_COMPANY);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: CTX.workspaceId,
        eventType: 'CompanyProfileCreated',
        schemaVersion: 2,
        aggregateType: 'CompanyProfile',
        aggregateId: COMPANY_ID,
        payload: expect.objectContaining({
          website: 'https://example.test',
          executionBudget: expect.objectContaining({
            purpose: 'understanding.run',
          }),
        }),
      }),
    });
  });
});
