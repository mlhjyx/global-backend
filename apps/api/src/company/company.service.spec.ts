import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

// 单测不依赖真实 DNS/网络：URL 守卫只做协议层校验（生产路径仍走完整 net-guard）。
vi.mock('../adapters/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/url-guard')>();
  return {
    ...actual,
    assertPublicHttpUrl: vi.fn(async (raw: string) => new URL(raw)),
  };
});
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
const ATTEMPT_ID = '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
const REQUEST_SHA = '3dc3a2999f48c19806265db8cc7941af75a496c4f65a630ec4f2c62fcb68d8fd';

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
  const companyCreate = vi.fn(async () => company);
  const offeringCreateMany = vi.fn(async () => ({ count: 0 }));
  const tx = {
    companyProfile: {
      findUnique: vi.fn(async () => company),
      create: companyCreate,
    },
    offering: { createMany: offeringCreateMany },
    workspace: { upsert: vi.fn(async () => ({})) },
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
  return {
    service,
    outboxCreate,
    consume,
    verify,
    tx,
    companyCreate,
    offeringCreateMany,
  };
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

describe('CompanyService.create（D16/D17：注册引导字段与无官网建档）', () => {
  const created = {
    id: COMPANY_ID,
    workspaceId: CTX.workspaceId,
    name: '具安科技',
    website: null,
    status: 'DRAFT',
    industry: 'isic-2813',
    targetMarkets: ['DE', 'US'],
    businessEmail: 'sales@example.test',
    version: 1,
    createdAt: new Date('2026-11-02T00:00:00Z'),
    updatedAt: new Date('2026-11-02T00:00:00Z'),
  };

  it('无官网建档：不发 CompanyProfileCreated、不消费 Grant', async () => {
    const { service, consume, outboxCreate } = fixture(created);
    const result = await service.create(
      CTX,
      {
        name: '具安科技',
        industry: 'isic-2813',
        targetMarkets: ['DE', 'US'],
        businessEmail: 'sales@example.test',
      },
      undefined,
      'jws',
    );
    expect(result.understanding).toBe('not_started');
    expect(result.company).toBe(created);
    expect(consume).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('有官网建档照常触发理解并消费 Grant', async () => {
    const web = { ...created, website: 'https://93.184.216.34' };
    const { service, consume, outboxCreate } = fixture(web);
    const result = await service.create(
      CTX,
      { website: 'https://93.184.216.34' },
      undefined,
      'jws',
    );
    expect(result.understanding).toBe('started');
    expect(consume).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
  });

  it('注册引导的主营产品落 Offering（source=onboarding，幂等跳过重名）', async () => {
    const web = { ...created, website: 'https://93.184.216.34' };
    const { service, offeringCreateMany } = fixture(web);
    await service.create(
      CTX,
      { website: 'https://93.184.216.34', products: ['精密轴承', 'CNC 加工件'] },
      undefined,
      'jws',
    );
    expect(offeringCreateMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: CTX.workspaceId,
          companyId: COMPANY_ID,
          name: '精密轴承',
          source: 'onboarding',
        },
        {
          workspaceId: CTX.workspaceId,
          companyId: COMPANY_ID,
          name: 'CNC 加工件',
          source: 'onboarding',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('website 与 name 都缺省时 400，且不验签', async () => {
    const { service, verify } = fixture(created);
    await expect(
      service.create(CTX, {}, undefined, 'jws'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('CompanyService.retryUnderstanding', () => {
  it('requires a workspace grant for the retry operation itself', async () => {
    const { service, verify } = fixture(FAILED_COMPANY);
    await service.retryUnderstanding(CTX, COMPANY_ID, ATTEMPT_ID, 'jws');
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
    await expect(service.retryUnderstanding(CTX, COMPANY_ID, ATTEMPT_ID, 'jws')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects retries when the profile is not a failed DRAFT', async () => {
    const enriching = { ...FAILED_COMPANY, status: 'ENRICHING' };
    const first = fixture(enriching);
    await expect(first.service.retryUnderstanding(CTX, COMPANY_ID, ATTEMPT_ID, 'jws')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(first.consume).not.toHaveBeenCalled();

    const neverFailed = { ...FAILED_COMPANY, understandingFailedAt: null };
    const second = fixture(neverFailed);
    await expect(second.service.retryUnderstanding(CTX, COMPANY_ID, ATTEMPT_ID, 'jws')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(second.consume).not.toHaveBeenCalled();
  });

  it('consumes the grant and re-emits the CompanyProfileCreated event for the same company', async () => {
    const { service, outboxCreate, consume } = fixture(FAILED_COMPANY);
    const result = await service.retryUnderstanding(CTX, COMPANY_ID, ATTEMPT_ID, 'jws');
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
