import type { RuntimeComponentStatus } from './runtime-readiness-registry';

export interface WorkerDependencyAdmissionInput {
  check: () => Promise<RuntimeComponentStatus>;
  onBlocked: (code: string) => void;
  retryMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
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
    const result = await input.check();
    if (result.status === 'ok') return;
    input.onBlocked(result.code);
    await sleep(retryMs);
  }
}
