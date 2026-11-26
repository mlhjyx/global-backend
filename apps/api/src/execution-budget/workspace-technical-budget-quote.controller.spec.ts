import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { WorkspaceTechnicalBudgetQuoteController } from './workspace-technical-budget-quote.controller';
import { WorkspaceTechnicalBudgetQuoteService } from './workspace-technical-budget-quote';
import { resolveWorkspaceTechnicalBudgetEnvelope } from './workspace-technical-budget-envelope';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};

function controller(): WorkspaceTechnicalBudgetQuoteController {
  return new WorkspaceTechnicalBudgetQuoteController(
    new WorkspaceTechnicalBudgetQuoteService({
      now: () => new Date('2026-08-26T12:00:00.000Z'),
      resolveEnvelope: resolveWorkspaceTechnicalBudgetEnvelope,
    }),
  );
}

describe('WorkspaceTechnicalBudgetQuoteController', () => {
  it('returns a zero-side-effect ICP quote bound to the authenticated workspace', () => {
    expect(
      controller().quote(CTX, {
        operation: 'POST /companies/:companyId/icps',
        companyId: '30000000-0000-4000-8000-000000000003',
      }),
    ).toEqual({
      data: expect.objectContaining({
        schemaVersion: 'execution-budget-technical-quote/v1',
        authorityKind: 'WORKSPACE_GRANT',
        workspaceId: CTX.workspaceId,
        purpose: 'icp.design',
        requiredCapMicrousd: '800000',
      }),
    });
  });

  it('quotes an understanding retry for the addressed company', () => {
    expect(
      controller().quote(CTX, {
        operation: 'POST /companies/:companyId/understanding/retry',
        companyId: '30000000-0000-4000-8000-000000000003',
        body: { attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' },
      }),
    ).toEqual({
      data: expect.objectContaining({
        schemaVersion: 'execution-budget-technical-quote/v1',
        authorityKind: 'WORKSPACE_GRANT',
        purpose: 'understanding.run',
        requiredCapMicrousd: '5800000',
      }),
    });
  });

  it('binds the attempt id into the quote hash for plan generation (P1 attempt 维度)', () => {
    const base = {
      operation: 'POST /icps/:icpId/query-plans',
      icpId: '40000000-0000-4000-8000-000000000004',
    };
    const without = controller().quote(CTX, base).data.requestSha256;
    const withAttempt = controller().quote(CTX, {
      ...base,
      body: { attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    }).data.requestSha256;
    expect(withAttempt).toMatch(/^[0-9a-f]{64}$/);
    expect(withAttempt).not.toBe(without);
    // 同一 attempt 幂等：重复 quoting 同一请求得到同一哈希（同一 Grant 作用域，重放会被 GRANT_REUSED 拒绝）。
    expect(
      controller().quote(CTX, {
        ...base,
        body: { attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      }).data.requestSha256,
    ).toBe(withAttempt);
  });

  it('rejects a malformed attempt id instead of hashing it', () => {
    expect(() =>
      controller().quote(CTX, {
        operation: 'POST /query-plans/:planId/execute',
        planId: '50000000-0000-4000-8000-000000000005',
        body: { attemptId: 'not-a-uuid' },
      }),
    ).toThrow(/EXECUTION_BUDGET_QUOTE_INVALID/);
  });

  it('rejects unknown top-level fields instead of hashing a silently stripped request', () => {
    expect(() =>
      controller().quote(CTX, {
        operation: 'POST /companies/:companyId/icps',
        companyId: '30000000-0000-4000-8000-000000000003',
        clientCapMicrousd: '1',
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });

  it('rejects malformed nested email fields before producing a request hash', () => {
    expect(() =>
      controller().quote(CTX, {
        operation: 'POST /canonical-companies/:id/guess-emails',
        companyId: '30000000-0000-4000-8000-000000000003',
        body: { maxContacts: 2, maxProbe: 2, customerBalance: 100 },
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });

  it('quotes a discovery run bound to a request-scoped discovery_run subject', () => {
    expect(
      controller().quote(CTX, {
        operation: 'POST /query-plans/:planId/execute',
        planId: '50000000-0000-4000-8000-000000000005',
      }),
    ).toEqual({
      data: expect.objectContaining({
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
        // Capped-mode fit ceiling aligned with Run 2 pool cap (500) + right-sized Flash task ceilings + Batch 1.4-B L0 search tools (self-hosted crawl4ai priced at 0c).
        requiredCapMicrousd: '573380000',
      }),
    });
  });

  it('quotes company creation for the understanding run', () => {
    expect(
      controller().quote(CTX, {
        operation: 'POST /companies',
        body: { website: 'https://example.test' },
      }),
    ).toEqual({
      data: expect.objectContaining({
        purpose: 'understanding.run',
        subjectType: 'company',
        requiredCapMicrousd: '5800000',
      }),
    });
  });

  it('quotes on-demand contact discovery bound to the company subject', () => {
    expect(
      controller().quote(CTX, {
        operation: 'POST /canonical-companies/:id/discover-contacts',
        companyId: '30000000-0000-4000-8000-000000000003',
      }),
    ).toEqual({
      data: expect.objectContaining({
        purpose: 'discovery.run',
        subjectType: 'company',
        subjectId: '30000000-0000-4000-8000-000000000003',
        requiredCapMicrousd: '2400000',
      }),
    });
  });

  it('quotes on-demand contact discovery with a client attemptId', () => {
    const quote = controller().quote(CTX, {
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: '30000000-0000-4000-8000-000000000003',
      body: { attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' },
    });

    expect(quote).toEqual({
      data: expect.objectContaining({
        purpose: 'discovery.run',
        subjectType: 'company',
        subjectId: '30000000-0000-4000-8000-000000000003',
        requiredCapMicrousd: '2400000',
        requestSha256:
          'dc8a43b2754f37639a57df618ab09e857364052abd7f1eca46b06da212ea18c6',
      }),
    });
  });

  it('rejects a discover attemptId that is not a UUID', () => {
    expect(() =>
      controller().quote(CTX, {
        operation: 'POST /canonical-companies/:id/discover-contacts',
        companyId: '30000000-0000-4000-8000-000000000003',
        body: { attemptId: 'not-a-uuid' },
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });
});


describe('static market generation quote and its exact closed request boundary', () => {
  const exact = { operation: 'POST /market-candidate-generations/:generationId/execute', generationId: '66666666-6666-4666-8666-666666666666', body: { intentDigest: 'a'.repeat(64) } };
  it('returns a static market generation quote without proving ownership or consuming a grant', () => {
    expect(controller().quote(CTX, exact)).toEqual({ data: expect.objectContaining({ workspaceId: CTX.workspaceId, purpose: 'market.candidates.generate', subjectType: 'market_candidate_generation', subjectId: exact.generationId, requiredCapMicrousd: '800000', requestSha256: 'd387987f983216a733a11c7b48b74cd9b66aab8d17a268f00005e143d26460c3' }) });
  });
  it.each([
    { ...exact, generationId: 'not-a-uuid' },
    { ...exact, body: {} },
    { ...exact, body: { intentDigest: 'A'.repeat(64) } },
    { ...exact, body: { intentDigest: 'a'.repeat(64), authorityId: '77777777-7777-4777-8777-777777777777' } },
    { ...exact, capMicrousd: '1' },
  ])('rejects a noncanonical or authority-shaped input rather than silently stripping it: %j', request => {
    expect(() => controller().quote(CTX, request)).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });
});

describe('manufacturer execution quote canonical boundary',()=>{
  const planId='30000000-0000-4000-8000-000000000003';
  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'] as const)('quotes %s revision-only first execution and preserves legacy cap/hash',(revision)=>{
    const old=controller().quote(CTX,{operation:'POST /query-plans/:planId/execute',planId}).data;
    const next=controller().quote(CTX,{operation:'POST /query-plans/:planId/execute',planId,body:{manufacturerNetworkRevision:revision}}).data;
    // Self-hosted searxng.search + crawl4ai.fetch carry 0c external cost; policyRevision and requestSha256 still change.
    expect(BigInt(next.requiredCapMicrousd)-BigInt(old.requiredCapMicrousd)).toBe(0n);
    expect(next.requestSha256).not.toBe(old.requestSha256);expect(next.policyRevision).not.toBe(old.policyRevision);
  });
  it.each([{}, {manufacturerNetworkRevision:'manufacturer-network/v3'},{manufacturerNetworkRevision:null},{manufacturerNetworkRevision:'manufacturer-network/v1',unexpected:true}])('rejects invalid request body before quote resolution',body=>{
    expect(()=>controller().quote(CTX,{operation:'POST /query-plans/:planId/execute',planId,body})).toThrow();
  });
});
