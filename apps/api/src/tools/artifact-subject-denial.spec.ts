import { describe, expect, it } from 'vitest';
import { ToolPolicyDenied } from './tool-broker';
import { artifactSubjectSkipReason } from './artifact-subject-denial';
import { isExecutionControlError } from '../execution-budget/execution-control-error';

describe('artifactSubjectSkipReason (G3 5.2)', () => {
  it.each([
    'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD',
    'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
    'GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED',
    'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID',
  ])('recognizes the prohibition-class denial %s as a per-company skip', (reason) => {
    expect(artifactSubjectSkipReason(new ToolPolicyDenied('crawl4ai.fetch', reason))).toBe(reason);
  });

  it('recognizes the denial through Error.cause wrappers', () => {
    const denied = new ToolPolicyDenied('crawl4ai.fetch', 'GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED');
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: denied }) });
    expect(artifactSubjectSkipReason(wrapped)).toBe('GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED');
  });

  it.each([
    ['storage unavailable stays a control error', new ToolPolicyDenied('crawl4ai.fetch', 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE')],
    ['suppression action gate', new ToolPolicyDenied('crawl4ai.fetch', 'suppression_action_gate')],
    ['source policy', new ToolPolicyDenied('crawl4ai.fetch', 'domain x is SUSPENDED')],
    ['budget', Object.assign(new Error('budget'), { code: 'BUDGET_EXCEEDED' })],
    ['look-alike without the ToolPolicyDenied brand', Object.assign(new Error('x'), { reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED' })],
    ['non-errors', 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED'],
  ])('does not treat %s as skippable', (_label, error) => {
    expect(artifactSubjectSkipReason(error)).toBeNull();
  });

  it('leaves the discovery-stage control classification unchanged', () => {
    // No-subject HOLD in discovery keeps failing the query, exactly as before 5.2.
    expect(isExecutionControlError(
      new ToolPolicyDenied('crawl4ai.fetch', 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD'),
    )).toBe(true);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(artifactSubjectSkipReason(a)).toBeNull();
  });
});
