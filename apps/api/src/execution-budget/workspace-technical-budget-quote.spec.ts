import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import {
  WorkspaceTechnicalBudgetQuoteService,
  type WorkspaceTechnicalBudgetEnvelope,
} from './workspace-technical-budget-quote';
import {
  workspaceExecutionBudgetRequestScope,
  type WorkspaceExecutionBudgetRequest,
} from './execution-budget-request-scope';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '20000000-0000-4000-8000-000000000002';
const CTX: RequestContext = {
  workspaceId: WORKSPACE_ID,
  userId: '30000000-0000-4000-8000-000000000003',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const REQUEST = Object.freeze({
  operation: 'POST /companies/:companyId/icps',
  companyId: COMPANY_ID,
}) satisfies WorkspaceExecutionBudgetRequest;

function envelope(
  overrides: Partial<WorkspaceTechnicalBudgetEnvelope> = {},
): WorkspaceTechnicalBudgetEnvelope {
  return Object.freeze({
    requiredCapMicrousd: 800_000n,
    policy: Object.freeze({
      schemaVersion: 'workspace-execution-envelope/v1',
      requestScopeVersion: 'workspace-execution-budget-request-scope/v1',
      operation: REQUEST.operation,
      costBasis: 'backend_reservation_ceiling',
      currency: 'USD',
      unit: 'microusd',
      microUsdPerCent: '10000',
      representationMinimumMicrousd: '1',
      models: Object.freeze([
        Object.freeze({
          taskId: 'icp.design',
          requestedAlias: 'deepseek-v4-pro',
          structuredWireUpperBound: 2,
          logicalInvocations: 1,
          maxCostCents: 40,
          maxOutputTokens: 4_096,
        }),
      ]),
      tools: Object.freeze([]),
      executionLimits: Object.freeze({ taskInvocationUpperBound: 1 }),
    }),
    ...overrides,
  });
}

describe('WorkspaceTechnicalBudgetQuoteService', () => {
  it('binds the bearer workspace and reuses the exact production request scope', () => {
    const resolveEnvelope = vi.fn(() => envelope());
    const service = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope,
    });

    const quote = service.quote(CTX, REQUEST);
    const scope = workspaceExecutionBudgetRequestScope(REQUEST);

    expect(quote).toEqual({
      schemaVersion: 'execution-budget-technical-quote/v1',
      authorityKind: 'WORKSPACE_GRANT',
      operation: REQUEST.operation,
      workspaceId: WORKSPACE_ID,
      purpose: scope.purpose,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      requestSha256: scope.requestSha256,
      currency: 'USD',
      unit: 'microusd',
      requiredCapMicrousd: '800000',
      policyRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: '2026-08-26T12:05:00.000Z',
    });
    expect(resolveEnvelope).toHaveBeenCalledOnce();
    expect(resolveEnvelope).toHaveBeenCalledWith(REQUEST);
  });

  it('changes policyRevision when the execution envelope changes', () => {
    const current = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope: () => envelope(),
    }).quote(CTX, REQUEST);
    const changed = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope: () =>
        envelope({
          policy: Object.freeze({
            ...envelope().policy,
            executionLimits: Object.freeze({ taskInvocationUpperBound: 2 }),
          }),
        }),
    }).quote(CTX, REQUEST);

    expect(changed.policyRevision).not.toBe(current.policyRevision);
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['PostgreSQL BIGINT overflow', 9_223_372_036_854_775_808n],
  ])('fails closed when the internal envelope has a %s cap', (_name, cap) => {
    const service = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope: () => envelope({ requiredCapMicrousd: cap }),
    });

    expect(() => service.quote(CTX, REQUEST)).toThrow(
      'EXECUTION_BUDGET_POLICY_DRIFT',
    );
  });

  it('fails closed when the resolver cap drifts from its closed policy formula', () => {
    const service = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope: () => envelope({ requiredCapMicrousd: 700_000n }),
    });

    expect(() => service.quote(CTX, REQUEST)).toThrow(
      'EXECUTION_BUDGET_POLICY_DRIFT',
    );
  });

  it('maps an unavailable internal envelope to a bounded 503 error', () => {
    const service = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope: () => {
        throw new Error('operator-only price catalog detail');
      },
    });

    expect(() => service.quote(CTX, REQUEST)).toThrow(
      'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
    );
  });

  it('rejects a missing workspace before resolving any execution envelope', () => {
    const resolveEnvelope = vi.fn(() => envelope());
    const service = new WorkspaceTechnicalBudgetQuoteService({
      now: () => NOW,
      resolveEnvelope,
    });

    expect(() =>
      service.quote({ ...CTX, workspaceId: '' }, REQUEST),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
    expect(resolveEnvelope).not.toHaveBeenCalled();
  });
});
