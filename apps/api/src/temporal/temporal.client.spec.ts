import { describe, expect, it, vi } from 'vitest';
import { TemporalClient } from './temporal.client';

describe('TemporalClient.checkSystemInfo', () => {
  it('fails closed before the Temporal connection is initialized', async () => {
    await expect(
      new TemporalClient().checkSystemInfo({ timeoutMs: 10 }),
    ).rejects.toThrow(/not initialized/i);
  });

  it('issues a bounded getSystemInfo request without exposing server details', async () => {
    const getSystemInfo = vi
      .fn()
      .mockResolvedValue({ capabilities: { usefulServerInfo: true } });
    const withAbortSignal = vi.fn(
      async (_signal: AbortSignal, fn: () => Promise<unknown>) => fn(),
    );
    const withDeadline = vi.fn(
      async (_deadline: number, fn: () => Promise<unknown>) => fn(),
    );
    const client = new TemporalClient();
    Object.assign(client as object, {
      connection: {
        workflowService: { getSystemInfo },
        withAbortSignal,
        withDeadline,
      },
    });
    const signal = new AbortController().signal;

    await expect(
      client.checkSystemInfo({ timeoutMs: 25, signal }),
    ).resolves.toBeUndefined();
    expect(withDeadline).toHaveBeenCalledTimes(1);
    expect(withAbortSignal).toHaveBeenCalledWith(signal, expect.any(Function));
    expect(getSystemInfo).toHaveBeenCalledWith({});
  });
});
