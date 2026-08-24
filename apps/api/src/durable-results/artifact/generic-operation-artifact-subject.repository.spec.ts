import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  GenericOperationArtifactSubjectRepository,
  parseGenericOperationArtifactSubjectRef,
} from './generic-operation-artifact-subject.repository';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const ARTIFACT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';
const SUBJECT_ID = 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72';
const DELETION_REQUEST_ID = '11d5ac4e-451e-4a89-b19f-c2f59e632dc9';

describe('GenericOperationArtifactSubjectRepository', () => {
  it('accepts only a closed bounded rights-flow subject reference', () => {
    expect(parseGenericOperationArtifactSubjectRef({
      subjectType: 'contact',
      subjectId: SUBJECT_ID,
    })).toEqual({ subjectType: 'contact', subjectId: SUBJECT_ID });

    for (const value of [
      { subjectType: 'contact_point', subjectId: SUBJECT_ID },
      { subjectType: 'contact', subjectId: 'person@example.test' },
      { subjectType: 'contact', subjectId: SUBJECT_ID, email: 'forbidden' },
      { subjectType: 'company', subjectId: SUBJECT_ID, body: 'forbidden' },
      { subjectType: 'company', subjectId: SUBJECT_ID, prompt: 'forbidden' },
      { subjectType: 'company', subjectId: SUBJECT_ID, credentials: 'forbidden' },
    ]) {
      expect(() => parseGenericOperationArtifactSubjectRef(value)).toThrow(
        'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
      );
    }
  });

  it('uses exact workspace, type and UUID subject lookup without free text', async () => {
    const queryRaw = vi.fn(async () => [{
      artifact_id: ARTIFACT_ID,
      workspace_id: WORKSPACE_ID,
      subject_type: 'contact',
      subject_id: SUBJECT_ID,
      created_at: new Date('2026-08-24T02:00:00.000Z'),
    }]);
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(repository.findBySubject(
      { $queryRaw: queryRaw } as never,
      {
        workspaceId: WORKSPACE_ID,
        subjectRef: { subjectType: 'contact', subjectId: SUBJECT_ID },
      },
    )).resolves.toEqual([{
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
      subjectType: 'contact',
      subjectId: SUBJECT_ID,
      createdAt: '2026-08-24T02:00:00.000Z',
    }]);

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.strings.join('')).toContain(
      'find_workspace_generic_operation_artifacts_by_subject_v1',
    );
    expect(sql.values).toEqual([
      WORKSPACE_ID,
      'contact',
      SUBJECT_ID,
    ]);
  });

  it('appends the subject tombstone with the exact DSR request binding', async () => {
    const queryRaw = vi.fn(async () => [{
      workspace_id: WORKSPACE_ID,
      subject_type: 'company',
      subject_id: SUBJECT_ID,
      deletion_request_id: DELETION_REQUEST_ID,
      tombstoned_at: new Date('2026-08-24T02:01:00.000Z'),
      artifact_count: 2,
      replay: false,
    }]);
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(repository.tombstoneSubject(
      { $queryRaw: queryRaw } as never,
      {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectRef: { subjectType: 'company', subjectId: SUBJECT_ID },
      },
    )).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      subjectType: 'company',
      subjectId: SUBJECT_ID,
      deletionRequestId: DELETION_REQUEST_ID,
      tombstonedAt: '2026-08-24T02:01:00.000Z',
      artifactCount: 2,
      replay: false,
    });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.strings.join('')).toContain(
      'tombstone_workspace_generic_operation_artifact_subject_v1',
    );
    expect(sql.values).toEqual([
      WORKSPACE_ID,
      'company',
      SUBJECT_ID,
      DELETION_REQUEST_ID,
    ]);
  });
});
