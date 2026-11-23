import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createDeletionActivities } from './deletion.activities';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const SUBJECT_ID = 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72';
const DELETION_REQUEST_ID = '11d5ac4e-451e-4a89-b19f-c2f59e632dc9';

describe('deletion artifact subject freeze', () => {
  it('tombstones the exact subject before publishing FROZEN state', async () => {
    const order: string[] = [];
    let enrichmentHeadSql = '';
    const queryRaw = vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
      const text = 'strings' in query
        ? query.strings.join('')
        : Array.from(query).join('');
      if (text.includes(
        'tombstone_workspace_generic_operation_artifact_subject_v1',
      )) {
        order.push('artifact-tombstone');
        return [{
          workspace_id: WORKSPACE_ID,
          subject_type: 'contact',
          subject_id: SUBJECT_ID,
          deletion_request_id: DELETION_REQUEST_ID,
          tombstoned_at: new Date('2026-08-24T02:01:00.000Z'),
          artifact_count: 0,
          replay: false,
        }];
      }
      if (text.includes('enqueue_workspace_personal_artifact_cleanup_v1')) {
        order.push('cleanup-command');
        return [{
          command_count: 1,
          shared_hold_count: 0,
          version_hold_count: 0,
        }];
      }
      if (text.includes('UPDATE public.contact_enrichment_execution_step') && text.includes('domain_state=')) {
        order.push('enrichment-steps-redact');
        return [{ redacted: 0 }];
      }
      if (text.includes('UPDATE public.contact_enrichment_execution') && text.includes('target_snapshot')) {
        enrichmentHeadSql = text;
        order.push('enrichment-heads-redact');
        return [{ redacted: 0 }];
      }
      order.push('policy-lock');
      return [];
    });
    const tx = {
      $queryRaw: queryRaw,
      canonicalContact: { findUnique: vi.fn(async () => null) },
      deletionRequest: {
        updateMany: vi.fn(async () => {
          order.push('frozen');
          return { count: 1 };
        }),
      },
      outboxEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => {
          order.push('cleanup-outbox');
          return {};
        }),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
    };

    const activities = createDeletionActivities({ prisma: prisma as never });
    await expect(activities.freezeSubject({
      workspaceId: WORKSPACE_ID,
      deletionRequestId: DELETION_REQUEST_ID,
      subjectType: 'contact',
      subjectId: SUBJECT_ID,
    })).resolves.toMatchObject({
      subjectType: 'contact',
      subjectId: SUBJECT_ID,
      contactIds: [],
    });

    expect(order).toEqual([
      'policy-lock',
      'artifact-tombstone',
      'cleanup-command',
      'cleanup-outbox',
      'enrichment-heads-redact',
      'enrichment-steps-redact',
      'frozen',
    ]);
    expect(enrichmentHeadSql).toContain('result_snapshot=jsonb_build_object');
    expect(enrichmentHeadSql).toContain("'contacts','[]'::jsonb");
    expect(enrichmentHeadSql).toContain("'newCandidatePoints'");
    expect(enrichmentHeadSql).toContain("'targetCount'");
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        eventType: 'PersonalArtifactCleanupRequested',
        aggregateType: 'DeletionRequest',
        aggregateId: DELETION_REQUEST_ID,
        privacyClassification: 'RESTRICTED',
        payload: {
          deletionRequestId: DELETION_REQUEST_ID,
        },
      },
    });
  });

  it.each(['company_profile', '', 'schedule'])(
    'refuses a subject kind the DSR API does not accept (%j) before any write',
    async (subjectType) => {
      // The artifact subject functions accept the seller company_profile kind (2026-10-14), so a
      // DSR request is no longer refused by the database tombstone for that kind: the deletion
      // workflow itself admits only contact | company, the kinds its API and DeletionCompleted name.
      const prisma = { withWorkspace: vi.fn() };
      const activities = createDeletionActivities({ prisma: prisma as never });

      await expect(activities.freezeSubject({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: subjectType as never,
        subjectId: SUBJECT_ID,
      })).rejects.toMatchObject({
        name: 'ApplicationFailure',
        type: 'DELETION_SUBJECT_TYPE_INVALID',
        nonRetryable: true,
      });
      expect(prisma.withWorkspace).not.toHaveBeenCalled();
    },
  );
});


describe('DSR enrichment head/step redaction in the existing freeze transaction', () => {
  function world(options: { heads?: number; steps?: number; fail?: boolean } = {}) {
    const order: string[] = []; const calls: Array<{ sql: string; values: unknown[] }> = [];
    const queryRaw = vi.fn(async (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      const isPrismaSql = 'strings' in query;
      const text = isPrismaSql ? (query as Prisma.Sql).strings.join('') : Array.from(query as unknown as readonly string[]).join('');
      const rawVals = isPrismaSql ? ((query as Prisma.Sql).values as unknown) : values;
      const vals = typeof rawVals === 'function' ? (rawVals as () => unknown[])() : ((rawVals ?? []) as unknown[]);
      if (text.includes('tombstone_workspace_generic_operation_artifact_subject_v1')) { order.push('artifact-tombstone'); return [{ workspace_id: WORKSPACE_ID, subject_type: String(vals[1] ?? 'contact'), subject_id: SUBJECT_ID, deletion_request_id: DELETION_REQUEST_ID, tombstoned_at: new Date('2026-08-24T02:01:00.000Z'), artifact_count: 0, replay: false }]; }
      if (text.includes('enqueue_workspace_personal_artifact_cleanup_v1')) { order.push('cleanup-command'); return [{ command_count: 1, shared_hold_count: 0, version_hold_count: 0 }]; }
      if (text.includes('UPDATE public.contact_enrichment_execution_step') && text.includes('domain_state=')) {
        order.push('enrichment-steps-redact'); calls.push({ sql: text, values: vals });
        if (options.fail) throw new Error('synthetic_dsr_step_redact_failure');
        return [{ redacted: options.steps ?? 2 }];
      }
      if (text.includes('UPDATE public.contact_enrichment_execution') && text.includes('target_snapshot')) {
        order.push('enrichment-heads-redact'); calls.push({ sql: text, values: vals });
        if (options.fail) throw new Error('synthetic_dsr_head_redact_failure');
        return [{ redacted: options.heads ?? 1 }];
      }
      order.push('policy-lock'); return [];
    });
    const tx = { $queryRaw: queryRaw, canonicalContact: { findUnique: vi.fn(async () => null) }, canonicalCompany: { findUnique: vi.fn(async () => null) }, deletionRequest: { updateMany: vi.fn(async () => { order.push('frozen'); return { count: 1 }; }) }, outboxEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => { order.push('cleanup-outbox'); return {}; }) } };
    const prisma = { withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => Promise<unknown>) => callback(tx)) };
    return { activities: createDeletionActivities({ prisma: prisma as never }), order, calls, tx };
  }
  it('redacts both head snapshots and step live associations before publishing FROZEN', async () => {
    const x = world(); await x.activities.freezeSubject({ workspaceId: WORKSPACE_ID, deletionRequestId: DELETION_REQUEST_ID, subjectType: 'contact', subjectId: SUBJECT_ID });
    expect(x.order.indexOf('enrichment-steps-redact')).toBeGreaterThan(x.order.indexOf('artifact-tombstone')); expect(x.order.indexOf('enrichment-heads-redact')).toBeGreaterThan(x.order.indexOf('artifact-tombstone')); expect(x.order.indexOf('frozen')).toBeGreaterThan(x.order.indexOf('enrichment-heads-redact'));
    expect(x.order).toContain('cleanup-command');
  });
  it('uses scoped parameterized statements and keeps original budget audit plus unknown holds untouched', async () => {
    const x = world(); await x.activities.freezeSubject({ workspaceId: WORKSPACE_ID, deletionRequestId: DELETION_REQUEST_ID, subjectType: 'contact', subjectId: SUBJECT_ID });
    for (const call of x.calls) {
      expect(call.values).toEqual(expect.arrayContaining([WORKSPACE_ID, SUBJECT_ID])); expect(call.sql).not.toMatch(/budget_operation_id\s*=|DELETE FROM|reserved_microusd\s*=|charged_microusd\s*=/);
    }
    const stepCall = x.calls.find((call) => call.sql.includes('SET contact_id=NULL'))!;
    expect(stepCall.sql).toMatch(/contact_id\s*=\s*NULL/); expect(stepCall.sql).toMatch(/candidate_ref\s*=\s*NULL/); expect(stepCall.sql).toMatch(/input_fingerprint\s*=\s*NULL/);
    const headCall = x.calls.find((call) => call.sql.includes('target_snapshot'))!;
    expect(headCall.sql).toMatch(/target_snapshot\s*=\s*'\[\]'::jsonb/); expect(headCall.sql).toMatch(/status\s*=\s*'REDACTED'/);
  });
  it('propagates a redaction failure so the freeze transaction cannot publish a half-redacted FROZEN', async () => {
    const x = world({ fail: true }); await expect(x.activities.freezeSubject({ workspaceId: WORKSPACE_ID, deletionRequestId: DELETION_REQUEST_ID, subjectType: 'contact', subjectId: SUBJECT_ID })).rejects.toThrow(); expect(x.order).not.toContain('frozen');
  });
  it('supports company DSR scope without touching contact-only head semantics', async () => {
    const x = world(); await x.activities.freezeSubject({ workspaceId: WORKSPACE_ID, deletionRequestId: DELETION_REQUEST_ID, subjectType: 'company', subjectId: SUBJECT_ID });
    expect(x.calls.every((call) => call.values.includes('company'))).toBe(true);
  });
});
