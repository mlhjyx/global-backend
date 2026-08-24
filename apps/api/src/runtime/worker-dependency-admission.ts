import type { RuntimeComponentStatus } from './runtime-readiness-registry';

export interface WorkerDependencyAdmissionInput {
  check: () => Promise<RuntimeComponentStatus>;
  onBlocked: (code: string) => void;
  retryMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface PreCutoverWorkerDependencyAdmissionInput {
  readonly hardChecks: readonly RuntimeComponentStatus[];
  readonly authorityCapabilities: readonly RuntimeComponentStatus[];
}

/**
 * Authority capability probes are observe-only until the atomic cutover wires
 * both API and Worker admission. Keeping the parameter explicit makes that
 * temporary non-admitting behavior executable instead of a source-string claim.
 */
export function selectWorkerDependencyAdmissionBeforeAuthorityCutover(
  input: PreCutoverWorkerDependencyAdmissionInput,
): RuntimeComponentStatus {
  void input.authorityCapabilities;
  return (
    input.hardChecks.find((check) => check.status !== 'ok') ??
    Object.freeze({ status: 'ok' as const })
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
