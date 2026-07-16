import { beforeEach, describe, expect, it, vi } from 'vitest';

const temporal = vi.hoisted(() => ({
  cleanup: vi.fn(),
  sleep: vi.fn(async () => undefined),
  logError: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ cleanupStagingAssetObject: temporal.cleanup }),
  sleep: temporal.sleep,
  log: { error: temporal.logError },
  ApplicationFailure: class MockApplicationFailure extends Error {
    nonRetryable = true;
    type: string;
    constructor(message: string, type: string) {
      super(message);
      this.type = type;
    }
    static nonRetryable(message: string, type: string) {
      return new this(message, type);
    }
  },
}));

import { assetObjectCleanupWorkflow } from './asset-cleanup.workflow';

const INPUT = {
  eventId: '44444444-4444-4444-8444-444444444444',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  siteId: '22222222-2222-4222-8222-222222222222',
  assetId: '33333333-3333-4333-8333-333333333333',
  objectKey:
    'ws/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/uploads/33333333-3333-4333-8333-333333333333',
  objectClass: 'staging' as const,
  reason: 'commit_succeeded' as const,
  notBefore: '2026-07-17T08:15:00.000Z',
};

describe('assetObjectCleanupWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    temporal.cleanup.mockResolvedValue({ eventId: INPUT.eventId, deleted: true });
  });

  it('uses a durable Temporal timer until notBefore, then invokes the activity', async () => {
    vi.setSystemTime(new Date('2026-07-17T08:10:00.000Z'));

    await assetObjectCleanupWorkflow(INPUT);

    expect(temporal.sleep).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(temporal.cleanup).toHaveBeenCalledWith(INPUT);
    vi.useRealTimers();
  });

  it('does not sleep when redrive happens after notBefore', async () => {
    vi.setSystemTime(new Date('2026-07-17T08:20:00.000Z'));

    await assetObjectCleanupWorkflow(INPUT);

    expect(temporal.sleep).not.toHaveBeenCalled();
    expect(temporal.cleanup).toHaveBeenCalledWith(INPUT);
    vi.useRealTimers();
  });

  it('rejects canonical payload before timer or activity', async () => {
    await expect(
      assetObjectCleanupWorkflow({ ...INPUT, objectClass: 'canonical' } as never),
    ).rejects.toMatchObject({ nonRetryable: true });

    expect(temporal.sleep).not.toHaveBeenCalled();
    expect(temporal.cleanup).not.toHaveBeenCalled();
  });

  it('logs a minimal structured alert after activity exhaustion and rethrows', async () => {
    const failure = Object.assign(new Error('S3 secret and object key must not be logged'), {
      cause: { type: 'ASSET_CLEANUP_STORAGE_UNAVAILABLE' },
    });
    temporal.cleanup.mockRejectedValueOnce(failure);

    await expect(assetObjectCleanupWorkflow(INPUT)).rejects.toBe(failure);

    expect(temporal.logError).toHaveBeenCalledWith('asset staging cleanup failed', {
      eventId: INPUT.eventId,
      workspaceId: INPUT.workspaceId,
      objectClass: 'staging',
      errorCode: 'ASSET_CLEANUP_STORAGE_UNAVAILABLE',
    });
    expect(JSON.stringify(temporal.logError.mock.calls)).not.toContain(INPUT.objectKey);
    expect(JSON.stringify(temporal.logError.mock.calls)).not.toContain('S3 secret');
  });
});
