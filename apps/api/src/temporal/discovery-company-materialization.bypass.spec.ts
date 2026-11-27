import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import { executeDiscoveryCompanyMaterialization } from './discovery-company-materialization';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const AUTHORITY_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_SHA256 = 'a'.repeat(64);
const SUBJECT_ID = `request:${REQUEST_SHA256}`;

const VALID_BINDING: ExecutionBudgetBinding = {
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: SUBJECT_ID,
  requestSha256: REQUEST_SHA256,
  accountKey: `discovery.run:discovery_run:${SUBJECT_ID}:${REQUEST_SHA256}`,
};

describe('executeDiscoveryCompanyMaterialization LEGACY_EXECUTION_BUDGET_MODE=bypass', () => {
  const prevMode = process.env.LEGACY_EXECUTION_BUDGET_MODE;

  afterEach(() => {
    if (prevMode === undefined) delete process.env.LEGACY_EXECUTION_BUDGET_MODE;
    else process.env.LEGACY_EXECUTION_BUDGET_MODE = prevMode;
  });

  it('delegates directly to canonicalizeLegacyDiscoveryRun under bypass mode without invoking governed admission', async () => {
    process.env.LEGACY_EXECUTION_BUDGET_MODE = 'bypass';
    const withWorkspace = vi.fn();
    const canonicalizeLegacyDiscoveryRun = vi.fn(async () => ({ companies: 231, suppressed: 2 }));
    const resolveSuppressionMatches = vi.fn();

    const result = await executeDiscoveryCompanyMaterialization(
      {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        executionContractVersion: 2,
        executionBudget: VALID_BINDING,
      },
      {
        prisma: { withWorkspace } as never,
        canonicalizeLegacyDiscoveryRun,
        resolveSuppressionMatches,
      },
    );

    expect(result).toEqual({ companies: 231, suppressed: 2 });
    expect(canonicalizeLegacyDiscoveryRun).toHaveBeenCalledTimes(1);
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('keeps governed admission mandatory under enforce mode', async () => {
    process.env.LEGACY_EXECUTION_BUDGET_MODE = 'enforce';
    const withWorkspace = vi.fn(async () => {
      throw new Error('governed admission reached');
    });
    const canonicalizeLegacyDiscoveryRun = vi.fn(async () => ({ companies: 0, suppressed: 0 }));

    await expect(
      executeDiscoveryCompanyMaterialization(
        {
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          executionContractVersion: 2,
          executionBudget: VALID_BINDING,
        },
        {
          prisma: { withWorkspace } as never,
          canonicalizeLegacyDiscoveryRun,
          resolveSuppressionMatches: vi.fn(),
        },
      ),
    ).rejects.toThrow('governed admission reached');
    expect(withWorkspace).toHaveBeenCalledTimes(1);
    expect(canonicalizeLegacyDiscoveryRun).not.toHaveBeenCalled();
  });
});
