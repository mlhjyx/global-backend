import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFailure, ApplicationFailure, TimeoutFailure, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { temporal as proto } from '@temporalio/proto';
import { failureConverter } from './diagnostic-failure-converter';

const temporal = vi.hoisted(() => ({
  cleanup: vi.fn(),
  sleep: vi.fn(async () => undefined),
  continueAsNew: vi.fn(async () => 'continued'),
  activityOptions: null as null | { startToCloseTimeout?: unknown },
}));

vi.mock('@temporalio/workflow', async () => {
  const common = await import('@temporalio/common');
  return {
    proxyActivities: (options: { startToCloseTimeout?: unknown }) => {
      temporal.activityOptions = options;
      return { cleanupPersonalArtifact: temporal.cleanup };
    },
    sleep: temporal.sleep,
    continueAsNew: temporal.continueAsNew,
    rootCause: common.rootCause,
    ActivityFailure: common.ActivityFailure,
    TimeoutFailure: common.TimeoutFailure,
  };
});

import { ERASE_TIME_BUDGET_MS } from '../durable-results/artifact/personal-artifact-cleanup.store';
import { personalArtifactCleanupWorkflow } from './personal-artifact-cleanup.workflow';

function activityTimeout(timeoutType: 'START_TO_CLOSE' | 'SCHEDULE_TO_CLOSE'): ActivityFailure {
  return new ActivityFailure('Activity task timed out', 'cleanupPersonalArtifact', '1', 'MAXIMUM_ATTEMPTS_REACHED', 'fixture',
    new TimeoutFailure('Activity task timed out', undefined, timeoutType));
}

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

  it.each([false, true])('resumes after an attempt that timed out instead of failing the only workflow (wire roundtrip=%s)', async (wire) => {
    let failure: Error = activityTimeout('START_TO_CLOSE');
    if (wire) {
      const outgoing = failureConverter.errorToFailure(failure, defaultPayloadConverter);
      failure = defaultFailureConverter.failureToError(
        proto.api.failure.v1.Failure.decode(proto.api.failure.v1.Failure.encode(outgoing).finish()),
        defaultPayloadConverter,
      );
    }
    temporal.cleanup.mockRejectedValueOnce(failure);
    // A worker that died or stalled mid-erasure leaves the command CLAIMED; the
    // next claim takes it again and the erasure itself is idempotent.
    await expect(personalArtifactCleanupWorkflow({ ...input, retryDelaySeconds: 120 })).resolves.toBe('continued');
    expect(temporal.sleep).toHaveBeenCalledExactlyOnceWith('120 seconds');
    expect(temporal.continueAsNew).toHaveBeenCalledExactlyOnceWith({ ...input, retryDelaySeconds: 240 });
  });

  it.each([
    ['a non-retriable activity failure', new ActivityFailure('Activity task failed', 'cleanupPersonalArtifact', '1', 'NON_RETRYABLE_FAILURE', 'fixture',
      ApplicationFailure.nonRetryable('INVALID_DURABLE_CLEANUP_COMMAND', 'Error'))],
    ['a timeout of another kind', activityTimeout('SCHEDULE_TO_CLOSE')],
  ])('still fails on %s', async (_label, failure) => {
    temporal.cleanup.mockRejectedValueOnce(failure);
    await expect(personalArtifactCleanupWorkflow(input)).rejects.toBe(failure);
    expect(temporal.sleep).not.toHaveBeenCalled();
    expect(temporal.continueAsNew).not.toHaveBeenCalled();
  });

  it('gives the activity room beyond the erasure time budget, so slow storage takes the durable retry path', () => {
    expect(temporal.activityOptions?.startToCloseTimeout).toBe('2 minutes');
    // The erasure ends itself at the budget; claim and the receipt write are bounded DB calls.
    expect(ERASE_TIME_BUDGET_MS * 2).toBeLessThanOrEqual(2 * 60_000);
  });
});
