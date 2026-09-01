export const RUNTIME_LIFECYCLE_SETTLEMENT_TIMEOUT_MS = 5_000;

export async function settlesWithin(
  operation: Promise<void>,
  timeoutMs = RUNTIME_LIFECYCLE_SETTLEMENT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function completesWithin(
  operation: Promise<unknown>,
  timeoutMs = RUNTIME_LIFECYCLE_SETTLEMENT_TIMEOUT_MS,
): Promise<boolean> {
  return settlesWithin(
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeoutMs,
  );
}
