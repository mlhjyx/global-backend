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
  const service = new ContactEnrichmentService(
    prisma as never,
    authority as never,
    budgetStore as never,
  );
  return { service, authority, budgetStore, auditCreates };
}

describe('ContactEnrichmentService.enrichContacts', () => {
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

  it('正确接线：Grant scope=purpose contact.enrich/subject company、预算=授权 cap、参数映射', async () => {
    const { service, authority, auditCreates } = makeService({ authorizedCapMicrousd: 250_000n });
    const result = await service.enrichContacts(
      CTX,
      COMPANY_ID,
      {
        lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42' },
        contactIds: ['c-1'],
        maxProviders: 2,
        maxProbe: 3,
        attemptId: 'attempt-1',
      },
      'grant-jws',
    );
    expect(result).toMatchObject({ attempted: 3 });

    const consumeArgs = authority.consumeWorkspaceGrant.mock.calls[0]?.[0] as {
      compactJws: string;
      scope: { purpose: string; subjectType: string; subjectId: string; requestSha256: string };
    };
    expect(consumeArgs.compactJws).toBe('grant-jws');
    expect(consumeArgs.scope).toMatchObject({
      purpose: 'contact.enrich',
      subjectType: 'company',
      subjectId: COMPANY_ID,
    });
    expect(consumeArgs.scope.requestSha256).toMatch(/^[0-9a-f]{64}$/u);

    const [deps, input] = mocks.enrichCompanyContacts.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      accountKey: 'acct-1',
      contactIds: ['c-1'],
      maxProvidersPerContact: 2,
      maxVerificationCalls: 3,
    });
    expect((input.lawfulBasis as { basis: string; recordedBy: string })).toMatchObject({
      basis: 'legitimate_interest',
      recordedBy: 'u1',
    });
    // 预算端口以授权 cap 为上限。
    expect((deps.budget as { remainingMicrousd(): number | undefined }).remainingMicrousd()).toBe(
      250_000,
    );

    // PII 访问审计与请求同留痕（purpose=contact_discovery、subjectCount=attempted）。
    expect(auditCreates[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actorId: 'u1',
      purpose: 'contact_discovery',
      companyId: COMPANY_ID,
      subjectCount: 3,
    });
  });

  it('attemptId 进入请求哈希：不同 attemptId → 不同 scope 哈希（同输入重放可复用）', async () => {
    const { service, authority } = makeService();
    await service.enrichContacts(CTX, COMPANY_ID, { lawfulBasis: { basis: 'consent' }, attemptId: 'a1' }, 'g1');
    await service.enrichContacts(CTX, COMPANY_ID, { lawfulBasis: { basis: 'consent' }, attemptId: 'a2' }, 'g2');
    const hashes = authority.consumeWorkspaceGrant.mock.calls.map(
      (call) => (call[0] as { scope: { requestSha256: string } }).scope.requestSha256,
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
