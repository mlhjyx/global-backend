import { describe, expect, it } from 'vitest';
import {
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
    ).toEqual(cases[6]!.expected);

    expect(() =>
      workspaceExecutionBudgetRequestScope({
        operation: 'POST /contact-points/:pointId/verify',
        pointId: POINT_ID,
        body: { invalid: 1n } as never,
      }),
    ).toThrow('EXECUTION_BUDGET_REQUEST_INVALID');
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
