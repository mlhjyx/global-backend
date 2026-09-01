import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_EXECUTION_QUOTE_OPERATIONS,
  resolveWorkspaceTechnicalBudgetEnvelope,
} from './workspace-technical-budget-envelope';
import type { WorkspaceExecutionBudgetRequest } from './execution-budget-request-scope';

const COMPANY_ID = '20000000-0000-4000-8000-000000000002';
const ICP_ID = '30000000-0000-4000-8000-000000000003';
const POINT_ID = '40000000-0000-4000-8000-000000000004';

describe('workspace execution technical envelope catalog', () => {
  it('machine-enumerates all and only the seven workspace operations', () => {
    expect(WORKSPACE_EXECUTION_QUOTE_OPERATIONS).toEqual([
      'POST /companies',
      'POST /companies/:companyId/icps',
      'POST /icps/:icpId/query-plans',
      'POST /query-plans/:planId/execute',
      'POST /canonical-companies/:id/discover-contacts',
      'POST /canonical-companies/:id/guess-emails',
      'POST /contact-points/:pointId/verify',
    ]);
  });

  it('quotes ICP design from one bounded structured task and its exact wire cap', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /companies/:companyId/icps',
      companyId: COMPANY_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'icp.design',
        logicalInvocations: 1,
        structuredWireUpperBound: 2,
        maxCostCents: 40,
        maxOutputTokens: 4_096,
      }),
    ]);
    expect(envelope.policy.tools).toEqual([]);
  });

  it('quotes query planning with both bounded taxonomy passes and refinements', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /icps/:icpId/query-plans',
      icpId: ICP_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'discovery.query_plan',
        logicalInvocations: 1,
      }),
      expect.objectContaining({
        taskId: 'taxonomy.normalize',
        logicalInvocations: 138,
      }),
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      industryTermsPerPass: 64,
      targetCountries: 8,
      taxonomyIndustryPasses: 2,
      taxonomyProductRefinements: 2,
    });
  });

  it('quotes email guess and verify as zero-priced bounded tool operations with a positive representation minimum', () => {
    const guess = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /canonical-companies/:id/guess-emails',
      companyId: COMPANY_ID,
      body: { maxContacts: 3, maxProbe: 2 },
    });
    const verify = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /contact-points/:pointId/verify',
      pointId: POINT_ID,
    });

    expect(guess.policy.tools).toEqual([
      expect.objectContaining({
        toolId: 'smtp.rcpt_probe',
        maxPhysicalInvocations: 6,
        estimatedCents: 0,
      }),
    ]);
    expect(guess.policy.executionLimits).toMatchObject({
      contacts: 3,
      probesPerContact: 2,
      mxDnsReads: 6,
      smtpRcptCommands: 12,
    });
    expect(verify.policy.tools).toEqual([
      expect.objectContaining({
        toolId: 'smtp.rcpt_probe',
        maxPhysicalInvocations: 1,
        estimatedCents: 0,
      }),
    ]);
    expect(guess.policy.representationMinimumMicrousd).toBe('1');
  });

  it.each<WorkspaceExecutionBudgetRequest>([
    {
      operation: 'POST /companies',
      body: { website: 'https://example.test' },
    },
    {
      operation: 'POST /query-plans/:planId/execute',
      planId: '50000000-0000-4000-8000-000000000005',
    },
    {
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: COMPANY_ID,
    },
  ])('fails closed for $operation while its physical envelope remains incomplete', (request) => {
    expect(() => resolveWorkspaceTechnicalBudgetEnvelope(request)).toThrow(
      'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
    );
  });

  it.each([
    [{ maxContacts: 26 }, 'contacts'],
    [{ maxProbe: 9 }, 'probes'],
  ])('rejects an invalid email-guess %s boundary without inventing a quote', (body) => {
    expect(() =>
      resolveWorkspaceTechnicalBudgetEnvelope({
        operation: 'POST /canonical-companies/:id/guess-emails',
        companyId: COMPANY_ID,
        body,
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });
});
