import { ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-10a：ContactEnrichmentService 的契约钉（从 DiscoveryService 抽取后，原来的端点
 * 行为只能靠这一层测试保住）：
 *  - lawfulBasis 缺失 → 在**消耗 Grant 之前** 403（一次性 Grant 不被烧掉）；
 *  - 通过后 Grant scope 的 purpose/subject 正确、预算取授权 cap、审计与请求同留痕；
 *  - body 参数映射（contactIds / maxProviders→maxProvidersPerContact / maxProbe→maxVerificationCalls）。
 */
const mocks = vi.hoisted(() => ({
  enrichCompanyContacts: vi.fn(),
}));

vi.mock('../enrichment/waterfall/enrich-company-contacts', () => ({
  enrichCompanyContacts: mocks.enrichCompanyContacts,
}));

import { ContactEnrichmentService } from './enrich-contacts.service';
import type { RequestContext } from '../auth/request-context';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const CTX: RequestContext = { userId: 'u1', workspaceId: WORKSPACE_ID, roles: ['admin'] };

function makeService(options: { authorizedCapMicrousd?: bigint } = {}) {
  const auditCreates: Array<Record<string, unknown>> = [];
  const tx = {
    personalDataAccessAudit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditCreates.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (client: unknown) => Promise<unknown>) => fn(tx),
    ),
  };
  const authority = {
    consumeWorkspaceGrant: vi.fn(async () => ({
      authorityId: 'authority-1',
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: 'acct-1',
      purpose: 'contact.enrich',
      subjectType: 'company',
      subjectId: COMPANY_ID,
      requestSha256: 'a'.repeat(64),
    })),
  };
  const budgetStore = {
    attestAuthorized: vi.fn(async () => ({
      accountId: 'account-1',
      authorityId: 'authority-1',
      authorizedCapMicrousd: options.authorizedCapMicrousd ?? 250_000n,
      generation: 1,
    })),
  };
  const service = new ContactEnrichmentService(prisma as never);
  return { service, authority, budgetStore, auditCreates, prisma };
}

describe('ContactEnrichmentService.enrichContacts', () => {

  it('uses the safety lane when a composed service is injected, passing original body options and Grant', async () => {
    const x = makeService(); const executeHttp = vi.fn(async () => ({ companyId: COMPANY_ID, tier: 'B', attempted: 1, costMicrousd: 1780, deadlineHit: false, results: [], admission: 'ADMITTED', operationRef: 'd'.repeat(64), qualityCoverage: 'PREREQUISITE_ONLY' }));
    const safety = new ContactEnrichmentService(x.prisma as never, { executeHttp } as never);
    const result = await safety.enrichContacts(CTX, COMPANY_ID, { lawfulBasis: { basis: 'legitimate_interest' }, contactIds: ['c-1'], maxProviders: 2, maxProbe: 3, attemptId: 'attempt-1' }, 'grant-jws');
    expect(result).toMatchObject({ attempted: 1, costMicrousd: 1780 });
    expect(executeHttp).toHaveBeenCalledExactlyOnceWith(CTX, COMPANY_ID, expect.objectContaining({ lawfulBasis: expect.objectContaining({ basis: 'legitimate_interest', recordedBy: 'u1' }), contactIds: ['c-1'], maxProviders: 2, maxProbe: 3, attemptId: 'attempt-1' }), 'grant-jws');
    expect(x.authority.consumeWorkspaceGrant).not.toHaveBeenCalled(); expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });
  it('fails closed without legacy wire or Grant consumption when no safety service is composed', async () => {
    const x = makeService();
    await expect(x.service.enrichContacts(CTX, COMPANY_ID, { lawfulBasis: { basis: 'legitimate_interest' } }, 'grant-jws')).rejects.toMatchObject({ response: { error: { code: 'GOVERNANCE_PENDING' } } });
    expect(x.authority.consumeWorkspaceGrant).not.toHaveBeenCalled();
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    mocks.enrichCompanyContacts.mockReset();
    mocks.enrichCompanyContacts.mockResolvedValue({
      companyId: COMPANY_ID,
      tier: 'B',
      attempted: 3,
      costMicrousd: 4_200,
      deadlineHit: false,
      results: [],
    });
  });
  afterEach(() => {
    delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
  });

  it('lawfulBasis 缺失 → 403 且不消耗 Grant（一次性 Grant 不被烧掉）', async () => {
    const { service, authority } = makeService();
    await expect(
      service.enrichContacts(CTX, COMPANY_ID, { attemptId: 'attempt-1' }, 'grant-jws'),
    ).rejects.toMatchObject({
      response: { error: { code: 'CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED' } },
    });
    expect(authority.consumeWorkspaceGrant).not.toHaveBeenCalled();
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });

  it('passes mapped options to the safety lane and audits its attempted count without any Grant use', async () => {
    const x = makeService();
    const executeHttp = vi.fn(async () => ({ companyId: COMPANY_ID, tier: 'B', attempted: 3, costMicrousd: 4200, deadlineHit: false, results: [], admission: 'ADMITTED', operationRef: 'd'.repeat(64), qualityCoverage: 'PREREQUISITE_ONLY' }));
    const service = new ContactEnrichmentService(x.prisma as never, { executeHttp } as never);
    const result = await service.enrichContacts(CTX, COMPANY_ID, { lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42' }, contactIds: ['c-1'], maxProviders: 2, maxProbe: 3, attemptId: 'attempt-1' }, 'grant-jws');
    expect(result).toMatchObject({ attempted: 3 });
    expect(executeHttp).toHaveBeenCalledExactlyOnceWith(CTX, COMPANY_ID, expect.objectContaining({ lawfulBasis: expect.objectContaining({ basis: 'legitimate_interest', recordedBy: 'u1' }), contactIds: ['c-1'], maxProviders: 2, maxProbe: 3, attemptId: 'attempt-1' }), 'grant-jws');
    expect(x.authority.consumeWorkspaceGrant).not.toHaveBeenCalled();
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
    expect(x.auditCreates[0]).toMatchObject({ purpose: 'contact_discovery', companyId: COMPANY_ID, subjectCount: 3 });
  });
});
