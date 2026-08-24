import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createDeletionActivities } from './deletion.activities';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const SUBJECT_ID = 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72';
const DELETION_REQUEST_ID = '11d5ac4e-451e-4a89-b19f-c2f59e632dc9';

describe('deletion artifact subject freeze', () => {
  it('tombstones the exact subject before publishing FROZEN state', async () => {
    const order: string[] = [];
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
      'frozen',
    ]);
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
});
