import { beforeEach, describe, expect, it, vi } from 'vitest';

const temporal = vi.hoisted(() => ({
  cleanup: vi.fn(),
  sleep: vi.fn(async () => undefined),
  continueAsNew: vi.fn(async () => 'continued'),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ cleanupPersonalArtifact: temporal.cleanup }),
  sleep: temporal.sleep,
  continueAsNew: temporal.continueAsNew,
  rootCause: (error: unknown): string | undefined => {
    let current = error;
    while (current instanceof Error && current.cause) current = current.cause;
    return current instanceof Error ? current.message : undefined;
  },
}));

import { personalArtifactCleanupWorkflow } from './personal-artifact-cleanup.workflow';

const input = Object.freeze({
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  deletionRequestId: '00000000-0000-4000-8000-0000000000b2',
});

describe('personalArtifactCleanupWorkflow durable recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('continues as new with bounded backoff after store-unavailable instead of stranding RETRY', async () => {
    temporal.cleanup.mockRejectedValueOnce(
      new Error('Activity task failed', {
        cause: new Error('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE'),
      }),
    );
    await personalArtifactCleanupWorkflow(input);
    expect(temporal.sleep).toHaveBeenCalledWith('30 seconds');
    expect(temporal.continueAsNew).toHaveBeenCalledWith({
      ...input,
      retryDelaySeconds: 60,
    });
  });

  it('keeps a shared-reference HOLD durably scheduled without deleting', async () => {
    temporal.cleanup.mockResolvedValueOnce({
      status: 'HOLD',
      reason: 'SHARED_OBJECT_STILL_REFERENCED',
    });
    await personalArtifactCleanupWorkflow({ ...input, retryDelaySeconds: 3_600 });
    expect(temporal.sleep).toHaveBeenCalledWith('3600 seconds');
    expect(temporal.continueAsNew).toHaveBeenCalledWith({
      ...input,
      retryDelaySeconds: 3_600,
    });
  });

  it('returns terminal no-action after another governed request removed the version', async () => {
    temporal.cleanup.mockResolvedValueOnce({
      status: 'NO_ACTION',
      reason: 'NO_CLEANUP_REQUIRED',
    });
    await expect(personalArtifactCleanupWorkflow(input)).resolves.toEqual({
      status: 'NO_ACTION',
      reason: 'NO_CLEANUP_REQUIRED',
    });
    expect(temporal.sleep).not.toHaveBeenCalled();
  });
});
