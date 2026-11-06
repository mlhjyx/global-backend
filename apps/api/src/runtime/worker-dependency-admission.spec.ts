import { describe, expect, it, vi } from 'vitest';
import { MigrationRevisionMismatchError } from './runtime-process-lease';
import {
  migrationCheckFailure,
  migrationMismatchFailure,
  selectWorkerDependencyAdmission,
  waitForWorkerDependencyAdmission,
} from './worker-dependency-admission';

describe('migrationMismatchFailure', () => {
  it('marks a migration revision mismatch as an immediate drain, not a tolerated probe failure', () => {
    // The mismatch is a deterministic fact read from the database; polling on a
    // schema the image does not match must stop at the first probe.
    expect(migrationMismatchFailure()).toEqual({
      status: 'failed',
      code: 'MIGRATION_REVISION_MISMATCH',
      drainImmediately: true,
    });
  });

  it('keeps a transport failure on the tolerated path', () => {
    expect(
      migrationCheckFailure(new Error('boom'), 'WORKER_DATABASE_UNAVAILABLE'),
    ).toEqual({ status: 'failed', code: 'WORKER_DATABASE_UNAVAILABLE' });
    // Only the sentinel type drains at once; a plain error that merely carries
    // the code text is still a probe failure to tolerate.
    expect(
      migrationCheckFailure(
        new Error('MIGRATION_REVISION_MISMATCH'),
        'WORKER_DATABASE_UNAVAILABLE',
      ),
    ).toEqual({ status: 'failed', code: 'WORKER_DATABASE_UNAVAILABLE' });
    expect(
      migrationCheckFailure(
        new MigrationRevisionMismatchError(),
        'WORKER_DATABASE_UNAVAILABLE',
      ),
    ).toEqual({
      status: 'failed',
      code: 'MIGRATION_REVISION_MISMATCH',
      drainImmediately: true,
    });
  });
});

describe('waitForWorkerDependencyAdmission', () => {
  it('fails Worker admission when an authority capability is unavailable after cutover', () => {
    expect(
      selectWorkerDependencyAdmission({
        hardChecks: [{ status: 'ok' }, { status: 'ok' }],
        authorityCapabilities: [
          {
            status: 'failed',
            code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE',
          },
        ],
      }),
    ).toEqual({
      status: 'failed',
      code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE',
    });

    expect(
      selectWorkerDependencyAdmission({
        hardChecks: [
          { status: 'ok' },
          { status: 'failed', code: 'REDIS_UNAVAILABLE' },
        ],
        authorityCapabilities: [
          { status: 'failed', code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE' },
        ],
      }),
    ).toEqual({ status: 'failed', code: 'REDIS_UNAVAILABLE' });
  });

  it('keeps polling disabled and retries a transient managed dependency until it becomes ready', async () => {
    const check = vi
      .fn<() => Promise<{ status: 'ok' } | { status: 'failed'; code: string }>>()
      .mockResolvedValueOnce({ status: 'failed', code: 'REDIS_UNAVAILABLE' })
      .mockResolvedValueOnce({ status: 'ok' });
    const onBlocked = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await waitForWorkerDependencyAdmission({ check, onBlocked, sleep, retryMs: 1 });

    expect(onBlocked).toHaveBeenCalledWith('REDIS_UNAVAILABLE');
    expect(sleep).toHaveBeenCalledWith(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('treats a rejected probe as transiently unproven instead of terminating the worker', async () => {
    const check = vi
      .fn<() => Promise<{ status: 'ok' }>>()
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValueOnce({ status: 'ok' });
    const onBlocked = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForWorkerDependencyAdmission({ check, onBlocked, sleep, retryMs: 1 }),
    ).resolves.toBeUndefined();

    expect(onBlocked).toHaveBeenCalledWith('WORKER_DEPENDENCY_UNAVAILABLE');
    expect(sleep).toHaveBeenCalledWith(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
