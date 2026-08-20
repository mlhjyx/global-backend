export interface WorkerQueueLeaseInspector {
  inspectWorkerQueue(
    taskQueue: string,
    options: { requireReady?: boolean },
  ): Promise<
    | Readonly<{ status: 'ok' }>
    | Readonly<{ status: 'failed'; code: string }>
  >;
}

export interface WorkerQueueAdmissionInput {
  leases: WorkerQueueLeaseInspector;
  taskQueue: string;
  retryMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onBlocked: (code: string) => void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A mixed-digest queue is expected briefly during drain-and-swap. Keep the
 * new Worker unpolled and STARTING, then re-inspect until the stale lease ages
 * out instead of requiring an operator restart.
 */
export async function waitForWorkerQueueAdmission(
  input: WorkerQueueAdmissionInput,
): Promise<void> {
  const retryMs = input.retryMs ?? 30_000;
  const sleep = input.sleep ?? delay;
  for (;;) {
    const result = await input.leases.inspectWorkerQueue(input.taskQueue, {
      requireReady: false,
    });
    if (result.status === 'ok') return;
    input.onBlocked(result.code);
    await sleep(retryMs);
  }
}
