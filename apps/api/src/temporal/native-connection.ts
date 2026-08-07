import type {
  NativeConnection,
  NativeConnectionOptions,
} from '@temporalio/worker';

export interface NativeTemporalConnectionDriver {
  connect(options: NativeConnectionOptions): Promise<NativeConnection>;
}

/**
 * NativeConnection does not accept the client SDK's `connectTimeout` option.
 * Keep the admitted startup bound outside the SDK call and close any
 * connection that resolves after the caller has already failed closed.
 */
export async function connectNativeTemporal(
  driver: NativeTemporalConnectionDriver,
  options: { readonly address: string; readonly timeoutMs: number },
): Promise<NativeConnection> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 60_000
  ) {
    throw new Error('INVALID_TEMPORAL_NATIVE_CONNECT_TIMEOUT');
  }

  let timedOut = false;
  const pending = driver.connect({ address: options.address });
  void pending
    .then(async (connection) => {
      if (timedOut) await connection.close().catch(() => undefined);
    })
    .catch(() => undefined);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error('TEMPORAL_NATIVE_CONNECT_TIMEOUT'));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
