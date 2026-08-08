import type { NativeConnection } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectNativeTemporal } from './native-connection';

afterEach(() => {
  vi.useRealTimers();
});

describe('connectNativeTemporal', () => {
  it('passes only supported native connection options and returns the connection', async () => {
    const connection = { close: vi.fn() } as unknown as NativeConnection;
    const connect = vi.fn(async () => connection);

    await expect(
      connectNativeTemporal({ connect }, { address: 'temporal:7233', timeoutMs: 3_000 }),
    ).resolves.toBe(connection);
    expect(connect).toHaveBeenCalledWith({ address: 'temporal:7233' });
  });

  it('fails within the admitted timeout and closes a connection that resolves late', async () => {
    vi.useFakeTimers();
    let resolveConnection!: (connection: NativeConnection) => void;
    const pending = new Promise<NativeConnection>((resolve) => {
      resolveConnection = resolve;
    });
    const close = vi.fn(async () => undefined);
    const result = connectNativeTemporal(
      { connect: vi.fn(() => pending) },
      { address: 'temporal:7233', timeoutMs: 1_000 },
    );
    const rejection = expect(result).rejects.toThrow(
      'TEMPORAL_NATIVE_CONNECT_TIMEOUT',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    resolveConnection({ close } as unknown as NativeConnection);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 60_001])(
    'rejects an invalid timeout before connecting: %s',
    async (timeoutMs) => {
      const connect = vi.fn();
      await expect(
        connectNativeTemporal(
          { connect },
          { address: 'temporal:7233', timeoutMs },
        ),
      ).rejects.toThrow('INVALID_TEMPORAL_NATIVE_CONNECT_TIMEOUT');
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
