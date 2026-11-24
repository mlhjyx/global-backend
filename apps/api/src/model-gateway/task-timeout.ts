/**
 * Combines a caller-provided AbortSignal with the declared per-task `timeoutMs`
 * from `ai-tasks/task-registry.ts` so every model operation actually enforces
 * its registered timeout ceiling instead of waiting for the global 300s cap.
 */
export function withTaskTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return callerSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

export function withOptionalSignal<T extends { signal?: AbortSignal }>(
  input: T,
  signal: AbortSignal | undefined,
): T {
  return signal ? { ...input, signal } : input;
}
