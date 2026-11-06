import { MigrationRevisionMismatchError } from './runtime-process-lease';
import type { RuntimeComponentStatus } from './runtime-readiness-registry';

export interface WorkerDependencyAdmissionInput {
  check: () => Promise<RuntimeComponentStatus>;
  onBlocked: (code: string) => void;
  retryMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkerDependencyAdmissionSelectionInput {
  readonly hardChecks: readonly RuntimeComponentStatus[];
  readonly authorityCapabilities: readonly RuntimeComponentStatus[];
}

/**
 * Once platform authority is part of the managed runtime contract, its
 * capability probes are admission checks just like the hard dependencies.
 */
export function selectWorkerDependencyAdmission(
  input: WorkerDependencyAdmissionSelectionInput,
): RuntimeComponentStatus {
  return (
    [...input.hardChecks, ...input.authorityCapabilities].find(
      (check) => check.status !== 'ok',
    ) ?? Object.freeze({ status: 'ok' as const })
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A migration revision mismatch is a deterministic fact read from the
 * database, unlike a transport probe that can time out under load: continue
 * polling against a schema the image does not match is never right, so the
 * heartbeat must stop at the first observation instead of after its usual
 * consecutive-failure tolerance.
 */
export function migrationMismatchFailure(): RuntimeComponentStatus {
  return Object.freeze({
    status: 'failed' as const,
    code: 'MIGRATION_REVISION_MISMATCH',
    drainImmediately: true as const,
  });
}

/**
 * The migration probe can also throw a transport error. Only the deterministic
 * revision mismatch drains at once; an unreadable database stays on the
 * heartbeat's consecutive-failure tolerance under the caller's own code.
 */
export function migrationCheckFailure(
  error: unknown,
  fallbackCode: string,
): RuntimeComponentStatus {
  return error instanceof MigrationRevisionMismatchError
    ? migrationMismatchFailure()
    : Object.freeze({ status: 'failed' as const, code: fallbackCode });
}

/**
 * A managed dependency may be temporarily unavailable while the worker process
 * remains healthy. Keep polling disabled and re-check instead of requiring a
 * restart or silently proceeding with a synthetic fallback.
 */
export async function waitForWorkerDependencyAdmission(
  input: WorkerDependencyAdmissionInput,
): Promise<void> {
  const retryMs = input.retryMs ?? 30_000;
  const sleep = input.sleep ?? delay;
  for (;;) {
    try {
      const result = await input.check();
      if (result.status === 'ok') return;
      input.onBlocked(result.code);
    } catch {
      // A thrown transport/probe failure has no safe success interpretation.
      // Keep the worker STARTING and let the next bounded probe establish truth.
      input.onBlocked('WORKER_DEPENDENCY_UNAVAILABLE');
    }
    await sleep(retryMs);
  }
}
