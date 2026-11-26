import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../adapters/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/url-guard')>();
  return { ...actual, assertPublicHttpUrl: vi.fn(async (raw: string) => new URL(raw)) };
});

import type { RequestContext } from '../auth/request-context';
import type { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import type { PrismaService } from '../prisma/prisma.service';
import { CompanyService } from './company.service';
import { CompanyDto } from './dto/company.dto';
import { UnderstandingPreviewService } from './understanding-preview.service';
import { IcpService } from '../icp/icp.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { LangfuseRuntimeTelemetryService } from '../model-runtime';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write', 'acquisition:review'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const ICP_ID = '40000000-0000-4000-8000-000000000004';
const BINDING = {
  authorityId: '90000000-0000-4000-8000-000000000009',
  replay: false,
  scopeKey: CTX.workspaceId,
  accountKey: 'understanding.run:company:test',
  purpose: 'understanding.run',
  subjectType: 'company',
  subjectId: COMPANY_ID,
  requestSha256: 'a'.repeat(64),
} as ExecutionBudgetBinding;

describe('multimodal seller cold-start & multi-ICP activation', () => {
  it('admits 1688 storefront URL + productDescription and rejects generic 1688 homepage', async () => {
    const claimCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c-1', ...data }));
    const companyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: COMPANY_ID,
      workspaceId: CTX.workspaceId,
      createdAt: new Date('2026-11-26T00:00:00Z'),
      updatedAt: new Date('2026-11-26T00:00:00Z'),
      ...data,
    }));
    const tx = {
      workspace: { upsert: vi.fn(async () => ({})) },
      companyProfile: { create: companyCreate },
      offering: { createMany: vi.fn(async () => ({ count: 1 })) },
      claim: { findMany: vi.fn(async () => []), create: claimCreate },
      evidence: { create: vi.fn(async () => ({ id: 'ev-1' })) },
      knowledgeSource: { findFirst: vi.fn(async () => ({ id: 'ks-1' })) },
      outboxEvent: { create: vi.fn(async () => ({ id: 'ob-1' })) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const authority = {
      verifyWorkspaceGrant: vi.fn(async () => ({ tokenSha256: 'a'.repeat(64) })),
      consumeVerifiedWorkspaceGrantInTransaction: vi.fn(async () => BINDING),
    } as unknown as ExecutionBudgetAuthorityService;

    const service = new CompanyService(prisma, authority);

    await expect(
      service.create(CTX, { name: 'Bad Store', website: 'https://www.1688.com/' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const res = await service.create(CTX, {
      name: 'Wuxi Solar Factory',
      website: 'https://wuxisolar.1688.com/',
      productDescription: '专注 HJT 700W+ 光伏组件出口欧洲与拉美，通过 TÜV 与 IEC 61215 认证。',
    });
    const dto = CompanyDto.from(res.company as never);
    expect(dto.websiteChannel).toBe('alibaba_1688');
    expect(dto.summary).toContain('HJT 700W+');
    expect(claimCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'company_fact', status: 'NEEDS_REVIEW' }),
      }),
    );
  });

  it('UnderstandingPreviewService surfaces provenance-isolated PDF documents and extracted claims', async () => {
    const tx = {
      companyProfile: {
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          name: 'Wuxi Solar Factory',
          website: 'https://wuxisolar.en.alibaba.com/',
          summary: 'HJT solar module factory',
          status: 'DRAFT',
          industry: 'Solar',
          industryCode: null,
          understandingFailedAt: null,
          understandingLastError: null,
          deletedAt: null,
          updatedAt: new Date('2026-11-26T00:00:00Z'),
        })),
      },
      knowledgeSource: { findMany: vi.fn(async () => []) },
      canonicalTaxonomy: { findMany: vi.fn(async () => []) },
      termAlias: { findMany: vi.fn(async () => []) },
      offering: { findMany: vi.fn(async () => []) },
      sellerDocument: {
        findMany: vi.fn(async () => [
          {
            id: 'doc-1',
            filename: 'hjt-brochure-2026.pdf',
            status: 'ready',
            mime: 'application/pdf',
            createdAt: new Date('2026-11-26T00:00:00Z'),
            _count: { chunks: 14 },
          },
        ]),
      },
      claim: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'claim-doc-1',
              type: 'certification',
              statement: '通过 IEC 61215 与 TÜV 认证',
              status: 'NEEDS_REVIEW',
              documentClaimEvidence: [{ documentId: 'doc-1', document: { filename: 'hjt-brochure-2026.pdf' } }],
            },
          ]),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;

    const preview = await new UnderstandingPreviewService(prisma).get(CTX, COMPANY_ID);
    expect(preview.websiteChannel).toBe('alibaba_intl');
    expect(preview.summary).toBe('HJT solar module factory');
    expect(preview.documents.total).toBe(1);
    expect(preview.documents.ready).toBe(1);
    expect(preview.documents.items[0]?.chunkCount).toBe(14);
    expect(preview.documents.extractedClaims[0]?.claimId).toBe('claim-doc-1');
  });

  it('IcpService.activate supports keepExistingActive=true for multi-ICP coexistence without superseding siblings', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const update = vi.fn(async () => ({ id: ICP_ID, status: 'ACTIVE' }));
    const fullRow = {
      id: ICP_ID,
      workspaceId: CTX.workspaceId,
      companyId: COMPANY_ID,
      name: '德国储能分销商 ICP',
      status: 'HYPOTHESIS',
      version: 1,
      personas: [],
      roles: [],
      rules: [],
    };
    const tx = {
      icpDefinition: {
        findUnique: vi.fn(async () => fullRow),
        updateMany,
        update,
      },
      outboxEvent: { create: vi.fn(async () => ({ id: 'ev-1' })) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new IcpService(
      prisma,
      {} as ModelGateway,
      {} as LangfuseRuntimeTelemetryService,
      {} as ExecutionBudgetAuthorityService,
      {} as DiscoveryProviderRegistry,
    );

    await service.activate(CTX, ICP_ID, { keepExistingActive: true });
    expect(updateMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);

    await service.activate(CTX, ICP_ID, { keepExistingActive: false });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
