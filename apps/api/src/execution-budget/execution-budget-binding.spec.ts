import { describe, expect, it } from 'vitest';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from './execution-budget-binding';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = '20000000-0000-4000-8000-000000000002';
const REQUEST_SHA256 = 'a'.repeat(64);

const binding = Object.freeze({
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `understanding.run:company:request:${REQUEST_SHA256}:${REQUEST_SHA256}`,
  purpose: 'understanding.run',
  subjectType: 'company',
  subjectId: `request:${REQUEST_SHA256}`,
  requestSha256: REQUEST_SHA256,
}) satisfies ExecutionBudgetBinding;

describe('parseExecutionBudgetBinding', () => {
  it('returns an immutable exact copy for a fresh workspace binding', () => {
    const parsed = parseExecutionBudgetBinding(binding, {
      scopeKey: WORKSPACE_ID,
      purpose: 'understanding.run',
      subjectType: 'company',
    });

    expect(parsed).toEqual(binding);
    expect(parsed).not.toBe(binding);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['replayed', { ...binding, replay: true }],
    ['wrong workspace', { ...binding, scopeKey: '30000000-0000-4000-8000-000000000003' }],
    ['wrong account', { ...binding, accountKey: 'legacy-environment-cap-account' }],
    ['wrong request digest', { ...binding, requestSha256: 'b'.repeat(64) }],
    ['unknown field', { ...binding, compactJws: 'header.payload.signature' }],
  ])('rejects a %s binding before execution', (_case, value) => {
    expect(() =>
      parseExecutionBudgetBinding(value, {
        scopeKey: WORKSPACE_ID,
        purpose: 'understanding.run',
        subjectType: 'company',
      }),
    ).toThrow('EXECUTION_BUDGET_BINDING_INVALID');
  });
});
