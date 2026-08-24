import { describe, expect, it, vi } from 'vitest';
import { createPersonalArtifactCleanupActivities } from './personal-artifact-cleanup.activities';

const input = Object.freeze({
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  deletionRequestId: '00000000-0000-4000-8000-0000000000b2',
});

describe('personal artifact cleanup activity', () => {
  it('returns bounded terminal state and never transports object key/body/PII', async () => {
    const cleanup = vi.fn(async () => ({
      status: 'COMPLETED' as const,
      commandId: '00000000-0000-4000-8000-0000000000c3',
      objectStatus: 'ABSENT' as const,
      replay: false,
    }));
    const activities = createPersonalArtifactCleanupActivities({ service: { cleanup } });

    await expect(activities.cleanupPersonalArtifact(input)).resolves.toEqual({
      status: 'COMPLETED',
      commandId: '00000000-0000-4000-8000-0000000000c3',
      objectStatus: 'ABSENT',
      replay: false,
    });
    expect(cleanup).toHaveBeenCalledWith(input);
    expect(Reflect.ownKeys(cleanup.mock.calls[0]?.[0] ?? {})).toEqual([
      'workspaceId',
      'deletionRequestId',
    ]);
  });

  it('throws only the bounded retriable store-unavailable marker', async () => {
    const cleanup = vi.fn(async () => ({
      status: 'RETRY_SCHEDULED' as const,
      commandId: '00000000-0000-4000-8000-0000000000c3',
      reason: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE' as const,
      retriable: true as const,
    }));
    const activities = createPersonalArtifactCleanupActivities({ service: { cleanup } });

    await expect(activities.cleanupPersonalArtifact(input)).rejects.toThrow(
      'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    );
  });

  it('maps transient durable database failures to the same bounded retry marker', async () => {
    const cleanup = vi.fn(async () => {
      throw Object.assign(new Error('database endpoint must not escape'), {
        name: 'PrismaClientInitializationError',
        code: 'P1001',
      });
    });
    const activities = createPersonalArtifactCleanupActivities({ service: { cleanup } });
    await expect(activities.cleanupPersonalArtifact(input)).rejects.toThrow(
      'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    );
  });

  it('does not turn invariant violations into an infinite retry', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('INVALID_DURABLE_CLEANUP_COMMAND');
    });
    const activities = createPersonalArtifactCleanupActivities({ service: { cleanup } });
    await expect(activities.cleanupPersonalArtifact(input)).rejects.toThrow(
      'INVALID_DURABLE_CLEANUP_COMMAND',
    );
  });
});
