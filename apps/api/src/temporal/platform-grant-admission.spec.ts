import { describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';
import { PlatformGrantAdmission } from './platform-grant-admission';

const quote = {
  execution_envelope_sha256: 'e'.repeat(64),
  required_cap_per_run_microusd: '1',
  required_campaign_cap_microusd: '1',
};

function admission(overrides: {
  quote?: () => unknown;
  issue?: (request: unknown) => Promise<{ token: string; expiresAt: number }>;
  ingest?: (input: unknown) => Promise<{ authorityId: string; replay: boolean }>;
} = {}) {
  const issue = vi.fn(overrides.issue ?? (async () => ({ token: 'a.b.c', expiresAt: 1 })));
  const ingest = vi.fn(
    overrides.ingest ?? (async () => ({ authorityId: 'auth-1', replay: false })),
  );
  const quoteFn = vi.fn(overrides.quote ?? (() => quote));
  const port = new PlatformGrantAdmission({
    quoteService: { quote: quoteFn } as never,
    ingestion: { ingestAndAdmit: ingest } as never,
    client: { issue } as never,
  });
  return { port, issue, ingest, quoteFn };
}

describe('平台运行准入（quote → Grant → ingest/admit）', () => {
  it('把 quote 的金额与包络摘要绑定到 Grant 请求与期望值', async () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
    const { port, issue, ingest } = admission();
    await expect(
      port.admit({ executionScope: scope, workflowId: 'acq-sweep-workflow', workflowRunId: 'run-1' }),
    ).resolves.toEqual({ authorityId: 'auth-1', replay: false });
    expect(issue).toHaveBeenCalledWith({
      scheduleId: 'acq-sweep',
      purpose: 'platform.acquisition',
      workflowId: 'acq-sweep-workflow',
      workflowRunId: 'run-1',
      scheduleRequestSha256: scope.requestSha256,
      technicalPolicyRevision: quote.execution_envelope_sha256,
      capPerRunMicrousd: '1',
      campaignCapMicrousd: '1',
    });
    expect(ingest).toHaveBeenCalledWith({
      compactJws: 'a.b.c',
      expected: {
        purpose: 'platform.acquisition',
        subjectType: 'schedule',
        subjectId: 'acq-sweep',
        scheduleId: 'acq-sweep',
        scheduleRequestSha256: scope.requestSha256,
        workflowId: 'acq-sweep-workflow',
        workflowRunId: 'run-1',
        technicalPolicyRevision: quote.execution_envelope_sha256,
      },
    });
  });

  it('quote 不可用 → EXECUTION_BUDGET_GRANT_INVALID；Grant 被拒错误原样上抛', async () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
    const failing = admission({ quote: () => { throw new Error('drift'); } });
    await expect(
      failing.port.admit({ executionScope: scope, workflowId: 'w', workflowRunId: 'r' }),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
    const denied = admission({
      issue: async () => { throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'); },
    });
    await expect(
      denied.port.admit({ executionScope: scope, workflowId: 'w', workflowRunId: 'r' }),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
  });
});
