import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  parsePlatformExecutionBudgetBinding,
  platformScheduleWorkflowInput,
} from './platform-schedule-authority';

const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';

describe('platform schedule authority contract', () => {
  it('binds every managed schedule to one fixed purpose, subject, schedule and request hash', () => {
    expect(PLATFORM_SCHEDULE_AUTHORITY_SCOPES).toEqual({
      'acq-sweep': {
        purpose: 'platform.acquisition',
        subjectType: 'schedule',
        subjectId: 'acq-sweep',
        scheduleId: 'acq-sweep',
        requestSha256: '5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e',
      },
      'intent-sweep': {
        purpose: 'platform.intent_watch',
        subjectType: 'schedule',
        subjectId: 'intent-sweep',
        scheduleId: 'intent-sweep',
        requestSha256: '9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a',
      },
      'sanctions-refresh': {
        purpose: 'platform.sanctions',
        subjectType: 'schedule',
        subjectId: 'sanctions-refresh',
        scheduleId: 'sanctions-refresh',
        requestSha256: '50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe',
      },
      'patents-cache-refresh': {
        purpose: 'platform.acquisition',
        subjectType: 'schedule',
        subjectId: 'patents-cache-refresh',
        scheduleId: 'patents-cache-refresh',
        requestSha256: '3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6',
      },
    });
  });

  it('builds schedule action input without a token, caller cap or workspace fallback', () => {
    const input = platformScheduleWorkflowInput('acq-sweep');
    expect(input).toEqual({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'],
    });
    expect(JSON.stringify(input)).not.toMatch(/jws|token|workspace|cap/i);
  });

  it('parses only the exact per-workflow-run platform binding', () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['intent-sweep'];
    const binding = {
      authorityId: AUTHORITY_ID,
      scopeKey: 'platform',
      accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
      purpose: scope.purpose,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      scheduleId: scope.scheduleId,
      requestSha256: scope.requestSha256,
      workflowRunId: 'workflow-run-1',
      admissionReplay: false,
    };
    expect(parsePlatformExecutionBudgetBinding(binding, {
      ...scope,
      workflowRunId: 'workflow-run-1',
    })).toEqual(binding);
    expect(Object.isFrozen(parsePlatformExecutionBudgetBinding(binding))).toBe(true);
  });

  it.each([
    ['scope fallback', { scopeKey: '10000000-0000-4000-8000-000000000001' }],
    ['purpose drift', { purpose: 'platform.sanctions' }],
    ['subject drift', { subjectId: 'another-schedule' }],
    ['schedule drift', { scheduleId: 'another-schedule' }],
    ['request drift', { requestSha256: 'a'.repeat(64) }],
    ['run drift', { workflowRunId: 'workflow-run-2' }],
    ['account drift', { accountKey: 'platform:wrong' }],
  ])('rejects %s before an activity can attest or execute', (_name, override) => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['intent-sweep'];
    const binding = {
      authorityId: AUTHORITY_ID,
      scopeKey: 'platform',
      accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
      purpose: scope.purpose,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      scheduleId: scope.scheduleId,
      requestSha256: scope.requestSha256,
      workflowRunId: 'workflow-run-1',
      admissionReplay: false,
      ...override,
    };
    expect(() => parsePlatformExecutionBudgetBinding(binding, {
      ...scope,
      workflowRunId: 'workflow-run-1',
    })).toThrow('PLATFORM_EXECUTION_BUDGET_BINDING_INVALID');
  });

  it('accepts an admission replay for the same run without changing its account identity', () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['sanctions-refresh'];
    const binding = {
      authorityId: AUTHORITY_ID,
      scopeKey: 'platform',
      accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
      purpose: scope.purpose,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      scheduleId: scope.scheduleId,
      requestSha256: scope.requestSha256,
      workflowRunId: 'workflow-run-1',
      admissionReplay: true,
    };
    expect(parsePlatformExecutionBudgetBinding(binding)).toMatchObject({
      accountKey: binding.accountKey,
      admissionReplay: true,
    });
  });
});
