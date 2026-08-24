import { describe, expect, it, vi } from 'vitest';
import {
  PrismaPersonalArtifactCleanupCommandRepository,
  PersonalArtifactCleanupEnqueuer,
  personalArtifactCleanupPersistence,
  type PersonalArtifactCleanupPersistence,
} from './personal-artifact-cleanup.repository';

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000b2';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000c3';
const COMMAND_ID = '00000000-0000-4000-8000-0000000000d4';
const ARTIFACT_ID = '00000000-0000-4000-8000-0000000000e5';
const SHA256 = 'ab'.repeat(32);
const VERSION_ID = 'version-exact-1';

const row = Object.freeze({
  command_id: COMMAND_ID,
  workspace_id: WORKSPACE_ID,
  deletion_request_id: REQUEST_ID,
  artifact_id: ARTIFACT_ID,
  sha256: SHA256,
  object_version_id: VERSION_ID,
  tombstoned_at: new Date('2026-08-24T08:00:00.000Z'),
  attempt: 1,
  status: 'CLAIMED',
  object_status: null,
});

function persistence(overrides: Partial<PersonalArtifactCleanupPersistence> = {}) {
  return {
    claim: vi.fn(async () => [row]),
    complete: vi.fn(async () => [{ ...row, status: 'COMPLETED', object_status: 'ABSENT' }]),
    retry: vi.fn(async () => [{ ...row, status: 'RETRY', attempt: 2 }]),
    inspect: vi.fn(async () => [{ fence_committed: true, shared_hold: false, version_hold: false }]),
    ...overrides,
  } satisfies PersonalArtifactCleanupPersistence;
}

describe('PrismaPersonalArtifactCleanupCommandRepository', () => {
  it('claims only the workspace/request-bound command after the committed fence', async () => {
    const db = persistence();
    const repository = new PrismaPersonalArtifactCleanupCommandRepository(db);

    await expect(repository.claimCommitted({
      workspaceId: WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
    })).resolves.toEqual({
      status: 'CLAIMED',
      command: {
        schemaVersion: 'personal-artifact-cleanup-command/v1',
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        deletionRequestId: REQUEST_ID,
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        versionId: VERSION_ID,
        tombstonedAt: '2026-08-24T08:00:00.000Z',
        attempt: 1,
      },
    });
    expect(db.claim).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, deletionRequestId: REQUEST_ID });
  });

  it('denies cross-workspace before a command can be claimed', async () => {
    const db = persistence({ claim: vi.fn(async () => []), inspect: vi.fn(async () => []) });
    const repository = new PrismaPersonalArtifactCleanupCommandRepository(db);

    await expect(repository.claimCommitted({
      workspaceId: OTHER_WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
    })).resolves.toEqual({ status: 'CROSS_WORKSPACE_DENIED' });
  });

  it.each([
    ['uncommitted fence', { fence_committed: false, shared_hold: false, version_hold: false }, 'TOMBSTONE_FENCE_NOT_COMMITTED'],
    ['shared live reference', { fence_committed: true, shared_hold: true, version_hold: false }, 'SHARED_OBJECT_STILL_REFERENCED'],
    ['missing exact version', { fence_committed: true, shared_hold: false, version_hold: true }, 'EXACT_OBJECT_VERSION_UNAVAILABLE'],
  ])('returns HOLD for %s', async (_case, inspection, status) => {
    const db = persistence({ claim: vi.fn(async () => []), inspect: vi.fn(async () => [inspection]) });
    const repository = new PrismaPersonalArtifactCleanupCommandRepository(db);
    await expect(repository.claimCommitted({ workspaceId: WORKSPACE_ID, deletionRequestId: REQUEST_ID }))
      .resolves.toEqual({ status });
  });

  it('durably records ABSENT completion and bounded retry without provider details', async () => {
    const db = persistence();
    const repository = new PrismaPersonalArtifactCleanupCommandRepository(db);
    const claim = await repository.claimCommitted({ workspaceId: WORKSPACE_ID, deletionRequestId: REQUEST_ID });
    if (claim.status !== 'CLAIMED') throw new Error('expected claim');

    await repository.complete(claim.command, 'ABSENT');
    await repository.scheduleRetry(claim.command, {
      code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
      retriable: true,
    });

    expect(db.complete).toHaveBeenCalledWith({ command: claim.command, objectStatus: 'ABSENT' });
    expect(db.retry).toHaveBeenCalledWith({
      command: claim.command,
      code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    });
    expect(JSON.stringify(vi.mocked(db.retry).mock.calls)).not.toContain('provider');
  });

  it('does not let an earlier completed command hide a remaining shared-reference HOLD', async () => {
    const db = persistence({
      claim: vi.fn(async () => [{ ...row, status: 'COMPLETED', object_status: 'DELETED' }]),
      inspect: vi.fn(async () => [{ fence_committed: true, shared_hold: true, version_hold: false }]),
    });
    const repository = new PrismaPersonalArtifactCleanupCommandRepository(db);
    await expect(repository.claimCommitted({
      workspaceId: WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
    })).resolves.toEqual({ status: 'SHARED_OBJECT_STILL_REFERENCED' });
  });
});

describe('personal artifact cleanup Prisma persistence', () => {
  it('scopes every command transition through withWorkspace', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ fence_committed: true, shared_hold: false, version_hold: false }])
      .mockResolvedValueOnce([{ ...row, status: 'COMPLETED', object_status: 'DELETED' }])
      .mockResolvedValueOnce([{ ...row, status: 'RETRY', attempt: 2 }]);
    const withWorkspace = vi.fn(async (_workspaceId, callback) =>
      callback({ $queryRaw: queryRaw }),
    );
    const target = personalArtifactCleanupPersistence({ withWorkspace } as never);
    const command = {
      schemaVersion: 'personal-artifact-cleanup-command/v1' as const,
      commandId: COMMAND_ID,
      workspaceId: WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
      artifactId: ARTIFACT_ID,
      sha256: SHA256,
      versionId: VERSION_ID,
      tombstonedAt: '2026-08-24T08:00:00.000Z',
      attempt: 1,
    };

    await target.claim({ workspaceId: WORKSPACE_ID, deletionRequestId: REQUEST_ID });
    await target.inspect({ workspaceId: WORKSPACE_ID, deletionRequestId: REQUEST_ID });
    await target.complete({ command, objectStatus: 'DELETED' });
    await target.retry({ command, code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE' });

    expect(withWorkspace).toHaveBeenCalledTimes(4);
    expect(withWorkspace.mock.calls.every(([workspace]) => workspace === WORKSPACE_ID)).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('replays enqueue without duplicating an Outbox event and exposes counts only', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{
        command_count: 1,
        shared_hold_count: 2,
        version_hold_count: 3,
      }]),
      outboxEvent: {
        findFirst: vi.fn(async () => ({ eventId: COMMAND_ID })),
        create: vi.fn(),
      },
    };
    const result = await new PersonalArtifactCleanupEnqueuer().enqueue(tx as never, {
      workspaceId: WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
    });
    expect(result).toEqual({ commandCount: 1, sharedHoldCount: 2, versionHoldCount: 3 });
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('artifactId');
    expect(result).not.toHaveProperty('otherWorkspaceId');
  });

  it('emits a durable command event for HOLD-only cleanup without leaking the held reference', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{
        command_count: 0,
        shared_hold_count: 1,
        version_hold_count: 0,
      }]),
      outboxEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
    };
    await new PersonalArtifactCleanupEnqueuer().enqueue(tx as never, {
      workspaceId: WORKSPACE_ID,
      deletionRequestId: REQUEST_ID,
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'PersonalArtifactCleanupRequested',
        aggregateId: REQUEST_ID,
        payload: { deletionRequestId: REQUEST_ID },
      }),
    });
    expect(JSON.stringify(tx.outboxEvent.create.mock.calls)).not.toContain(SHA256);
  });
});
