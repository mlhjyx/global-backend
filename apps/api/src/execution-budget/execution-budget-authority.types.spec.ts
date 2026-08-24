import { describe, expect, it } from 'vitest';
import {
  assertAuthorityPurposeShape,
  assertCanonicalMicrousd,
  executionBudgetGrantErrorHttpStatus,
  ExecutionBudgetGrantError,
} from './execution-budget-authority.types';

describe('execution budget authority claim types', () => {
  it.each([
    ['0'],
    ['-1'],
    ['1.0'],
    ['01'],
    ['9223372036854775808'],
  ])('rejects non-canonical microusd %s', (value) => {
    expect(() => assertCanonicalMicrousd(value)).toThrow(
      'EXECUTION_BUDGET_GRANT_INVALID',
    );
  });

  it('parses a positive PostgreSQL BIGINT microusd amount', () => {
    expect(assertCanonicalMicrousd('9223372036854775807')).toBe(
      9_223_372_036_854_775_807n,
    );
  });

  it('rejects workspace claims without workspace, request hash and subject binding', () => {
    expect(() =>
      assertAuthorityPurposeShape({
        authorityKind: 'WORKSPACE_GRANT',
        purpose: 'icp.design',
        workspaceId: null,
        requestSha256: null,
        subjectType: 'company',
        subjectId: 'company-1',
        scheduleId: null,
        capMicrousd: 1n,
        capPerRunMicrousd: null,
        campaignCapMicrousd: null,
        maxRuns: null,
      }),
    ).toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });

  it.each([
    ['understanding.run', 'company'],
    ['icp.design', 'company'],
    ['icp.query_plan', 'icp'],
    ['discovery.run', 'discovery_run'],
    ['discovery.run', 'company'],
    ['contact.verify', 'contact_point'],
  ] as const)(
    'accepts the workspace purpose and subject pair %s / %s',
    (purpose, subjectType) => {
      expect(() =>
        assertAuthorityPurposeShape({
          authorityKind: 'WORKSPACE_GRANT',
          purpose,
          workspaceId: 'workspace-1',
          requestSha256: 'a'.repeat(64),
          subjectType,
          subjectId: 'subject-1',
          scheduleId: null,
          capMicrousd: 1n,
          capPerRunMicrousd: null,
          campaignCapMicrousd: null,
          maxRuns: null,
        }),
      ).not.toThrow();
    },
  );

  it('rejects workspace claims with platform-only fields or a wrong subject pair', () => {
    expect(() =>
      assertAuthorityPurposeShape({
        authorityKind: 'WORKSPACE_GRANT',
        purpose: 'icp.design',
        workspaceId: 'workspace-1',
        requestSha256: 'a'.repeat(64),
        subjectType: 'icp',
        subjectId: 'subject-1',
        scheduleId: 'schedule-1',
        capMicrousd: 1n,
        capPerRunMicrousd: 1n,
        campaignCapMicrousd: 1n,
        maxRuns: 1n,
      }),
    ).toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });

  it.each([
    'platform.acquisition',
    'platform.intent_watch',
    'platform.sanctions',
  ] as const)('accepts platform authority purpose %s with campaign fields', (purpose) => {
    expect(() =>
      assertAuthorityPurposeShape({
        authorityKind: 'PLATFORM_GRANT',
        purpose,
        workspaceId: null,
        requestSha256: null,
        subjectType: 'schedule',
        subjectId: 'schedule-1',
        scheduleId: 'schedule-1',
        capMicrousd: null,
        capPerRunMicrousd: 1n,
        campaignCapMicrousd: 2n,
        maxRuns: 3n,
      }),
    ).not.toThrow();
  });

  it('rejects platform claims with workspace-only fields or no campaign fields', () => {
    expect(() =>
      assertAuthorityPurposeShape({
        authorityKind: 'PLATFORM_GRANT',
        purpose: 'platform.acquisition',
        workspaceId: 'workspace-1',
        requestSha256: 'a'.repeat(64),
        subjectType: 'schedule',
        subjectId: 'schedule-1',
        scheduleId: null,
        capMicrousd: 1n,
        capPerRunMicrousd: null,
        campaignCapMicrousd: null,
        maxRuns: null,
      }),
    ).toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });

  it('keeps the canonical error code and HTTP mapping separate from the error object', () => {
    const error = new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );

    expect(error).toMatchObject({
      name: 'ExecutionBudgetGrantError',
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      message: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
    expect(executionBudgetGrantErrorHttpStatus(error.code)).toBe(503);
    expect(
      executionBudgetGrantErrorHttpStatus(
        'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
      ),
    ).toBe(403);
    expect(executionBudgetGrantErrorHttpStatus('EXECUTION_BUDGET_GRANT_REUSED')).toBe(
      409,
    );
    expect(
      executionBudgetGrantErrorHttpStatus(
        'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
      ),
    ).toBe(402);
  });
});
