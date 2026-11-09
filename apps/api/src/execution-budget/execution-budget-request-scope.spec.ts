import { describe, expect, it } from 'vitest';
import {
  discoverContactsExecutionBudgetRequestScope,
  guessEmailsExecutionBudgetRequestScope,
  verifyContactPointExecutionBudgetRequestScope,
  workspaceExecutionBudgetRequestScope,
  type WorkspaceExecutionBudgetRequest,
} from './execution-budget-request-scope';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const POINT_ID = '55555555-5555-4555-8555-555555555555';
const LEAD_ID = '66666666-6666-4666-8666-666666666666';

const cases = [
  {
    request: {
      operation: 'POST /companies',
      body: { website: 'https://acme.test', name: 'Acme' },
    },
    expected: {
      purpose: 'understanding.run',
      subjectType: 'company',
      subjectId:
        'request:1b4033428567bc7332718ae3930d25967a621d521f3c8fe36c45eb75daa11c58',
      requestSha256:
        '1b4033428567bc7332718ae3930d25967a621d521f3c8fe36c45eb75daa11c58',
    },
  },
  {
    request: {
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId: COMPANY_ID,
      body: { attemptId: '7e6f6f43-8f8d-4c2a-9b1e-2a3b4c5d6e7f' },
    },
    expected: {
      purpose: 'understanding.run',
      subjectType: 'company',
      subjectId: COMPANY_ID,
      requestSha256:
        '5bcc5f858ba0f89e1a71a89debab5dfa67b847691ee69c5b2c11cfaef6879d89',
    },
  },
  {
    request: {
      operation: 'POST /companies/:companyId/icps',
      companyId: COMPANY_ID,
    },
    expected: {
      purpose: 'icp.design',
      subjectType: 'company',
      subjectId: COMPANY_ID,
      requestSha256:
        'aa2de82e04df5250d6e616e5a92b4f928ed55b793c5e8c2f4b88868ee6a2982d',
    },
  },
  {
    request: {
      operation: 'POST /companies/:companyId/icps',
      companyId: COMPANY_ID,
      body: { attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    },
    expected: {
      purpose: 'icp.design',
      subjectType: 'company',
      subjectId: COMPANY_ID,
      requestSha256:
        '81d596bf8a472e3ec91439c96f07e285291284a5614d32108678241dc0fa9acb',
    },
  },
  {
    request: {
      operation: 'POST /icps/:icpId/query-plans',
      icpId: ICP_ID,
    },
    expected: {
      purpose: 'icp.query_plan',
      subjectType: 'icp',
      subjectId: ICP_ID,
      requestSha256:
        '258de2b957b0a75a2379fbc70bbb3b49cf1beb142357315159acb1549158b3b7',
    },
  },
  {
    request: {
      operation: 'POST /icps/:icpId/query-plans',
      icpId: ICP_ID,
      body: { attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    },
    expected: {
      purpose: 'icp.query_plan',
      subjectType: 'icp',
      subjectId: ICP_ID,
      requestSha256:
        '07ccd26d081c04933361aaf8a9349dede4e20cc54bb3b15daa213b9ea8fb9385',
    },
  },
  {
    request: {
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    },
    expected: {
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
      subjectId:
        'request:3358f06f16eb5fc6a1afe5aa048fe3fba46aaef9f06b04c5d943abde8574754b',
      requestSha256:
        '3358f06f16eb5fc6a1afe5aa048fe3fba46aaef9f06b04c5d943abde8574754b',
    },
  },
  {
    request: {
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
      body: { attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    },
    expected: {
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
      subjectId:
        'request:34c02d1307a14f659414c3a7dacf6ccd4b47385b6a918a464d3d16ac515e84ae',
      requestSha256:
        '34c02d1307a14f659414c3a7dacf6ccd4b47385b6a918a464d3d16ac515e84ae',
    },
  },
  {
    request: {
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: CANONICAL_COMPANY_ID,
    },
    expected: {
      purpose: 'discovery.run',
      subjectType: 'company',
      subjectId: CANONICAL_COMPANY_ID,
      requestSha256:
        'e9570e7b625591bb1cbc601c49e45e41e3c93e3619fec2380ca537bb29b18a3f',
    },
  },
  {
    request: {
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: CANONICAL_COMPANY_ID,
      body: { attemptId: '7e6f6f43-8f8d-4c2a-9b1e-2a3b4c5d6e7f' },
    },
    expected: {
      purpose: 'discovery.run',
      subjectType: 'company',
      subjectId: CANONICAL_COMPANY_ID,
      requestSha256:
        '1f4adbb5fdcbf99b63844a6d011a1e11316f81098f287d069b8689efd57386c4',
    },
  },
  {
    request: {
      operation: 'POST /canonical-companies/:id/enrich-contacts',
      companyId: CANONICAL_COMPANY_ID,
    },
    expected: {
      purpose: 'contact.enrich',
      subjectType: 'company',
      subjectId: CANONICAL_COMPANY_ID,
      requestSha256:
        '69fea2c44d1655679b7d43a449ee9f69d03bb3ffae512e180252d53c289d058f',
    },
  },
  {
    request: {
      operation: 'POST /canonical-companies/:id/enrich-contacts',
      companyId: CANONICAL_COMPANY_ID,
      body: { attemptId: '7e6f6f43-8f8d-4c2a-9b1e-2a3b4c5d6e7f' },
    },
    expected: {
      purpose: 'contact.enrich',
      subjectType: 'company',
      subjectId: CANONICAL_COMPANY_ID,
      requestSha256:
        '9701c5bfda2fff61265a0192d4e8a3d4f618ffc0b96a8207ef3eb37df7cdaf24',
    },
  },
  {
    request: {
      operation: 'POST /canonical-companies/:id/guess-emails',
      companyId: CANONICAL_COMPANY_ID,
      body: undefined,
    },
    expected: {
      purpose: 'discovery.run',
      subjectType: 'company',
      subjectId: CANONICAL_COMPANY_ID,
      requestSha256:
        '3b7b9965187c2033681830c9317483f139fe0b49b24797e03d5826c05b9cd41f',
    },
  },
  {
    request: {
      operation: 'POST /campaigns/:campaignId/plan-drafts',
      campaignId: '77777777-7777-4777-8777-777777777777',
      body: { jobId: '88888888-8888-4888-8888-888888888888' },
    },
    expected: {
      purpose: 'campaign.plan',
      subjectType: 'campaign',
      subjectId: '77777777-7777-4777-8777-777777777777',
      requestSha256:
        'fab93609345121a416482e4f85b0712cf43297f05790efee7910f81e6721ca5b',
    },
  },
  {
    request: {
      operation: 'POST /contact-points/:pointId/verify',
      pointId: POINT_ID,
      body: undefined,
    },
    expected: {
      purpose: 'contact.verify',
      subjectType: 'contact_point',
      subjectId: POINT_ID,
      requestSha256:
        'dc357eeb06f031ee9ef0a511c1aaa0561755e2def93e8a7f9518714c2cd19de8',
    },
  },
  {
    request: {
      operation: 'POST /leads/:leadId/outreach-drafts',
      leadId: LEAD_ID,
    },
    expected: {
      purpose: 'outreach.draft',
      subjectType: 'lead',
      subjectId: LEAD_ID,
      requestSha256:
        '8d2035ba21b03d35f3a3f0708d1bf547c101b131c3510174e275abb4f9d10c62',
    },
  },
] as const satisfies readonly {
  request: WorkspaceExecutionBudgetRequest;
  expected: Readonly<{
    purpose: string;
    subjectType: string;
    subjectId: string;
    requestSha256: string;
  }>;
}[];

describe('workspaceExecutionBudgetRequestScope', () => {
  it.each(cases)('locks $request.operation to the exact authority scope', ({ request, expected }) => {
    const scope = workspaceExecutionBudgetRequestScope(request);

    expect(scope).toEqual(expected);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('canonicalizes object key order but binds every semantic request field', () => {
    const first = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: { website: 'https://acme.test', name: 'Acme' },
    });
    const reordered = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: { name: 'Acme', website: 'https://acme.test' },
    });
    const changed = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: { name: 'Other', website: 'https://acme.test' },
    });

    expect(reordered).toEqual(first);
    expect(changed.requestSha256).not.toBe(first.requestSha256);
    expect(changed.subjectId).toBe(`request:${changed.requestSha256}`);
  });

  it('normalizes an omitted optional body to null and rejects non-JSON values', () => {
    expect(
      workspaceExecutionBudgetRequestScope({
        operation: 'POST /contact-points/:pointId/verify',
        pointId: POINT_ID,
      }),
    ).toEqual(
      cases.find((c) => c.request.operation === 'POST /contact-points/:pointId/verify')!.expected,
    );

    expect(() =>
      workspaceExecutionBudgetRequestScope({
        operation: 'POST /contact-points/:pointId/verify',
        pointId: POINT_ID,
        body: { invalid: 1n } as never,
      }),
    ).toThrow('EXECUTION_BUDGET_REQUEST_INVALID');
  });

  it('hashes Discover Contacts from attemptId while preserving the legacy hash when absent', () => {
    expect(discoverContactsExecutionBudgetRequestScope(CANONICAL_COMPANY_ID)).toEqual(
      cases.find(
        (c) =>
          c.request.operation === 'POST /canonical-companies/:id/discover-contacts' &&
          !('body' in c.request),
      )!.expected,
    );

    expect(
      discoverContactsExecutionBudgetRequestScope(CANONICAL_COMPANY_ID, {
        attemptId: '7e6f6f43-8f8d-4c2a-9b1e-2a3b4c5d6e7f',
      }),
    ).toEqual(
      cases.find(
        (c) =>
          c.request.operation === 'POST /canonical-companies/:id/discover-contacts' &&
          'body' in c.request,
      )!.expected,
    );
  });

  it('hashes Guess Emails from the exact public HTTP DTO before lawful-basis reshaping', () => {
    const scope = guessEmailsExecutionBudgetRequestScope(CANONICAL_COMPANY_ID, {
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-42',
      lawfulBasisNote: 'note',
      allowPersonalWithoutBasis: true,
      maxContacts: 5,
      maxProbe: 3,
    });

    expect(scope.requestSha256).toBe(
      '4aa3896784fc0f919c55eb5527452f2fa270e2b58c5a646ef86043dc08208952',
    );
  });

  it('hashes Verify from the exact public HTTP DTO before lawful-basis reshaping', () => {
    const scope = verifyContactPointExecutionBudgetRequestScope(POINT_ID, {
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-42',
      lawfulBasisNote: 'note',
      allowPersonalWithoutBasis: true,
    });

    expect(scope.requestSha256).toBe(
      'ff1319d2ec607743ccf3eb6cb9d251739bffed5a9ec5a1ba49cd5b1635c634ca',
    );
  });
});
