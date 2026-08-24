import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { CompanyService } from '../company/company.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { IcpService } from '../icp/icp.service';
import type { ExecutionBudgetAuthorityService } from './execution-budget-authority.service';
import {
  ExecutionBudgetGrantError,
  executionBudgetGrantErrorHttpStatus,
} from './execution-budget-authority.types';
import { executionBudgetGrantHttpException } from './execution-budget-grant.decorator';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const POINT_ID = '55555555-5555-4555-8555-555555555555';
const CTX = Object.freeze({
  workspaceId: WORKSPACE_ID,
  userId: '77777777-7777-4777-8777-777777777777',
  roles: ['admin'],
}) as RequestContext;

function rejectingHarness(code: ExecutionBudgetGrantError['code']) {
  const withWorkspace = vi.fn();
  const failure = new ExecutionBudgetGrantError(code);
  const consumeWorkspaceGrant = vi.fn().mockRejectedValue(failure);
  const verifyWorkspaceGrant = vi.fn().mockRejectedValue(failure);
  const consumeVerifiedWorkspaceGrantInTransaction = vi.fn();
  const authority = {
    consumeWorkspaceGrant,
    verifyWorkspaceGrant,
    consumeVerifiedWorkspaceGrantInTransaction,
  } as unknown as ExecutionBudgetAuthorityService;
  const prisma = { withWorkspace } as never;
  const providers = {
    routeContactDiscovery: vi.fn(),
    routeEmailVerification: vi.fn(),
  };
  const budget = {
    open: vi.fn(),
    openAuthorized: vi.fn(),
    close: vi.fn(),
    closeMicrousd: vi.fn(),
  };
  return {
    authority,
    budget,
    consumeWorkspaceGrant,
    verifyWorkspaceGrant,
    providers,
    withWorkspace,
    company: new CompanyService(prisma, authority),
    icp: new IcpService(prisma, {} as never, {} as never, authority, budget as never),
    discovery: new DiscoveryService(prisma, providers as never, authority, budget as never),
  };
}

describe('workspace HTTP authority cutover', () => {
  it.each([
    'EXECUTION_BUDGET_GRANT_REQUIRED',
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  ] as const)('rejects %s before every business/provider side effect', async (code) => {
    const harness = rejectingHarness(code);
    const calls = [
      () =>
        harness.company.create(
          CTX,
          { website: 'https://acme.test', name: 'Acme' },
          undefined,
          'grant',
        ),
      () => harness.icp.generateFromCompany(CTX, COMPANY_ID, 'grant'),
      () => harness.icp.generateQueryPlan(CTX, ICP_ID, 'grant'),
      () => harness.discovery.executePlan(CTX, PLAN_ID, 'grant'),
      () => harness.discovery.discoverContacts(CTX, COMPANY_ID, 'grant'),
      () => harness.discovery.guessEmailsForCompany(CTX, COMPANY_ID, undefined, 'grant'),
      () => harness.discovery.verifyContactPoint(CTX, POINT_ID, undefined, 'grant'),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code });
    }

    expect(harness.consumeWorkspaceGrant).toHaveBeenCalledTimes(5);
    expect(harness.verifyWorkspaceGrant).toHaveBeenCalledTimes(2);
    expect(harness.withWorkspace).not.toHaveBeenCalled();
    expect(harness.providers.routeContactDiscovery).not.toHaveBeenCalled();
    expect(harness.providers.routeEmailVerification).not.toHaveBeenCalled();
    expect(harness.budget.open).not.toHaveBeenCalled();
    expect(harness.budget.openAuthorized).not.toHaveBeenCalled();
  });

  it('rejects an exact consumed-token replay before discovery DB/provider work', async () => {
    const withWorkspace = vi.fn();
    const providers = { routeContactDiscovery: vi.fn() };
    const authority = {
      consumeWorkspaceGrant: vi.fn(async () => ({
        authorityId: '88888888-8888-4888-8888-888888888888',
        replay: true,
        scopeKey: WORKSPACE_ID,
        accountKey: `discovery.run:company:${COMPANY_ID}:${'a'.repeat(64)}`,
        purpose: 'discovery.run',
        subjectType: 'company',
        subjectId: COMPANY_ID,
      })),
    };
    const service = new DiscoveryService(
      { withWorkspace } as never,
      providers as never,
      authority as never,
    );

    await expect(
      service.discoverContacts(CTX, COMPANY_ID, 'consumed-grant'),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_REUSED' });
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(providers.routeContactDiscovery).not.toHaveBeenCalled();
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_REQUIRED',
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    'EXECUTION_BUDGET_GRANT_REUSED',
    'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
  ] as const)('maps %s to a stable public HTTP envelope', (code) => {
    const error = executionBudgetGrantHttpException(
      new ExecutionBudgetGrantError(code),
    );

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(executionBudgetGrantErrorHttpStatus(code));
    expect(error.getResponse()).toEqual({
      error: { code, message: code },
    });
  });
});
