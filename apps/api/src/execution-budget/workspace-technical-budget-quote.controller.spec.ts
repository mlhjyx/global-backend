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

  it('keeps incomplete physical envelopes fail-closed as 503', () => {
    expect(() =>
      controller().quote(CTX, {
        operation: 'POST /companies',
        body: { website: 'https://example.test' },
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
  });
});
