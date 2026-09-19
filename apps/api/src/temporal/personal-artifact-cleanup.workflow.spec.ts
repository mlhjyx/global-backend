import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFailure, ApplicationFailure, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { temporal as proto } from '@temporalio/proto';
import { failureConverter } from './diagnostic-failure-converter';

const temporal = vi.hoisted(() => ({
  cleanup: vi.fn(),
  sleep: vi.fn(async () => undefined),
  continueAsNew: vi.fn(async () => 'continued'),
}));

vi.mock('@temporalio/workflow', async () => ({
  proxyActivities: () => ({ cleanupPersonalArtifact: temporal.cleanup }),
  sleep: temporal.sleep,
  continueAsNew: temporal.continueAsNew,
  rootCause: (await import('@temporalio/common')).rootCause,
}));

import { personalArtifactCleanupWorkflow } from './personal-artifact-cleanup.workflow';

const input = Object.freeze({
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  deletionRequestId: '00000000-0000-4000-8000-0000000000b2',
});

describe('personalArtifactCleanupWorkflow durable recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])('preserves bounded cleanup retry after failure wire roundtrip (cached=%s)', async (cached) => {
    const cause = ApplicationFailure.retryable('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE', 'Error');
    let failure: Error = new ActivityFailure('synthetic-cleanup-diagnostic', 'cleanupPersonalArtifact', '1', 'MAXIMUM_ATTEMPTS_REACHED', 'fixture', cause);
    if (cached) failure = defaultFailureConverter.failureToError(defaultFailureConverter.errorToFailure(failure, defaultPayloadConverter), defaultPayloadConverter);
    const outgoing = failureConverter.errorToFailure(failure, defaultPayloadConverter);
    const wire = proto.api.failure.v1.Failure.decode(proto.api.failure.v1.Failure.encode(outgoing).finish());
    expect(JSON.stringify(wire)).not.toContain('synthetic-cleanup-diagnostic');
    temporal.cleanup.mockRejectedValueOnce(defaultFailureConverter.failureToError(wire, defaultPayloadConverter));
    await expect(personalArtifactCleanupWorkflow(input)).resolves.toBe('continued');
    expect(temporal.sleep).toHaveBeenCalledExactlyOnceWith('30 seconds');
    expect(temporal.continueAsNew).toHaveBeenCalledExactlyOnceWith({ ...input, retryDelaySeconds: 60 });
  });

  it('continues as new with bounded backoff after store-unavailable instead of stranding RETRY', async () => {
    temporal.cleanup.mockRejectedValueOnce(
      new ActivityFailure('Activity task failed', 'cleanupPersonalArtifact', '1', 'MAXIMUM_ATTEMPTS_REACHED', 'fixture',
        ApplicationFailure.retryable('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE', 'Error')),
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
