import { describe, expect, it, vi } from 'vitest';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { OutboxRelayService } from './outbox-relay.service';
import { INTERNAL_COMMANDS } from './event-registry';
import {
  NonRetryableOutboxCommandError,
} from './discovery-run-command';
import {
  REJUDGE_EXECUTION_TIMEOUT,
  REJUDGE_WORKFLOW,
  UNDERSTANDING_TASK_QUEUE,
} from '../temporal/understanding.constants';
import { parseRejudgeOutboxCommand } from './rejudge-command';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000002';
const REJUDGE_ID = '30000000-0000-4000-8000-000000000003';
const AUTHORITY_ID = '40000000-0000-4000-8000-000000000004';
const COMPANY_A = '50000000-0000-4000-8000-000000000005';
const REQUEST_SHA256 = 'a'.repeat(64);

const VALID_BINDING = Object.freeze({
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `icp.rejudge:icp:${ICP_ID}:${REQUEST_SHA256}`,
  purpose: 'icp.rejudge',
  subjectType: 'icp',
  subjectId: ICP_ID,
  requestSha256: REQUEST_SHA256,
});

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    eventId: '60000000-0000-4000-8000-000000000006',
    workspaceId: WORKSPACE_ID,
    eventType: 'LeadRejudgeRequested',
    schemaVersion: 2,
    aggregateType: 'ICP',
    aggregateId: ICP_ID,
    producer: 'api',
    correlationId: null,
    causationId: null,
    privacyClassification: 'green',
    occurredAt: new Date('2026-11-26T10:00:00.000Z'),
    publishedAt: null as Date | null,
    parkedAt: null as Date | null,
    payload: {
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: VALID_BINDING,
      batches: [{ index: 0, companyIds: [COMPANY_A] }],
      refreshCorroboration: true,
      refreshWebsiteProfile: false,
    },
    ...overrides,
  };
}

describe('LeadRejudgeRequested relay command', () => {
  it('registers LeadRejudgeRequested in INTERNAL_COMMANDS and parses valid commands', () => {
    expect(INTERNAL_COMMANDS.has('LeadRejudgeRequested')).toBe(true);
    const parsed = parseRejudgeOutboxCommand(makeEvent());
    expect(parsed).toEqual({
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: VALID_BINDING,
      batches: [{ index: 0, companyIds: [COMPANY_A] }],
      refreshCorroboration: true,
      refreshWebsiteProfile: false,
    });
  });

  it.each([
    ['legacy schemaVersion', { schemaVersion: 1 }],
    [
      'wrong purpose in budgetBinding',
      {
        payload: {
          rejudgeId: REJUDGE_ID,
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: {
            ...VALID_BINDING,
            purpose: 'discovery.run',
            accountKey: `discovery.run:icp:${ICP_ID}:${REQUEST_SHA256}`,
          },
          batches: [{ index: 0, companyIds: [COMPANY_A] }],
          refreshCorroboration: true,
          refreshWebsiteProfile: false,
        },
      },
    ],
    [
      'mismatched subjectId',
      {
        payload: {
          rejudgeId: REJUDGE_ID,
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: {
            ...VALID_BINDING,
            subjectId: COMPANY_A,
            accountKey: `icp.rejudge:icp:${COMPANY_A}:${REQUEST_SHA256}`,
          },
          batches: [{ index: 0, companyIds: [COMPANY_A] }],
          refreshCorroboration: true,
          refreshWebsiteProfile: false,
        },
      },
    ],
    [
      'empty batches',
      {
        payload: {
          rejudgeId: REJUDGE_ID,
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: VALID_BINDING,
          batches: [],
          refreshCorroboration: true,
          refreshWebsiteProfile: false,
        },
      },
    ],
    [
      'non-UUID rejudgeId',
      {
        payload: {
          rejudgeId: 'not-a-uuid',
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: VALID_BINDING,
          batches: [{ index: 0, companyIds: [COMPANY_A] }],
          refreshCorroboration: true,
          refreshWebsiteProfile: false,
        },
      },
    ],
  ])('throws NonRetryableOutboxCommandError on %s', (_label, overrides) => {
    expect(() => parseRejudgeOutboxCommand(makeEvent(overrides))).toThrow(
      NonRetryableOutboxCommandError,
    );
  });

  it('dispatches rejudgeWorkflow via OutboxRelayService with REJECT_DUPLICATE and parks invalid commands', async () => {
    const start = vi.fn(async () => undefined);
    const temporal = { client: { workflow: { start } } };
    const validEv = makeEvent();
    const invalidEv = makeEvent({ id: 2n, schemaVersion: 1 });
    const rows = new Map<bigint, ReturnType<typeof makeEvent>>([
      [1n, validEv],
      [2n, invalidEv],
    ]);
    const db = {
      outboxEvent: {
        update: vi.fn(async ({ where, data }: { where: { id: bigint }; data: Record<string, unknown> }) => {
          const row = rows.get(where.id)!;
          Object.assign(row, data);
          return row;
        }),
      },
    };
    const relay = new OutboxRelayService(temporal as never);
    (relay as unknown as { db: unknown }).db = db;

    await relay.routeEvent(validEv);
    expect(start).toHaveBeenCalledWith(REJUDGE_WORKFLOW, {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: `ws:${WORKSPACE_ID}:rejudge:${REJUDGE_ID}`,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowExecutionTimeout: REJUDGE_EXECUTION_TIMEOUT,
      args: [
        expect.objectContaining({
          rejudgeId: REJUDGE_ID,
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          executionContractVersion: 2,
          budgetBinding: VALID_BINDING,
        }),
      ],
    });
    expect(validEv.publishedAt).toBeInstanceOf(Date);
    expect(validEv.parkedAt).toBeNull();

    start.mockClear();
    await relay.routeEvent(invalidEv);
    expect(start).not.toHaveBeenCalled();
    expect(invalidEv.publishedAt).toBeNull();
    expect(invalidEv.parkedAt).toBeInstanceOf(Date);
  });
});
