import { describe, expect, it, vi } from 'vitest';
import { TemporalClient } from './temporal.client';

describe('TemporalClient.probe', () => {
  it('reports not initialized before a connection exists', async () => {
    await expect(new TemporalClient().probe()).resolves.toEqual({
      connected: false,
      code: 'TEMPORAL_NOT_INITIALIZED',
    });
  });

  it('uses a bounded control-plane RPC without claiming worker health', async () => {
    const getSystemInfo = vi.fn(async () => ({ serverVersion: 'test' }));
    const withDeadline = vi.fn(async (_deadline: number, operation: () => Promise<unknown>) => operation());
    const client = new TemporalClient();
    Object.assign(client as object, {
      connection: { withDeadline, workflowService: { getSystemInfo } },
    });

    await expect(client.probe()).resolves.toEqual({ connected: true });
    expect(withDeadline).toHaveBeenCalledOnce();
    expect(getSystemInfo).toHaveBeenCalledWith({});
  });

  it('returns only a typed code when the RPC fails', async () => {
    const client = new TemporalClient();
    Object.assign(client as object, {
      connection: {
        withDeadline: vi.fn(async () => {
          throw new Error('temporal.internal.example:7233 credential');
        }),
        workflowService: { getSystemInfo: vi.fn() },
      },
    });
    const result = await client.probe();
    expect(result).toEqual({ connected: false, code: 'TEMPORAL_CONTROL_PLANE_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it('starts degraded without aborting Nest bootstrap and reconnects on probe', async () => {
    const client = new TemporalClient();
    const connect = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('temporal.internal:7233 secret'))
      .mockResolvedValue({
        withDeadline: vi.fn(async (_deadline: number, operation: () => Promise<unknown>) =>
          operation(),
        ),
        workflowService: { getSystemInfo: vi.fn(async () => ({})) },
      });
    Object.assign(client as object, { connect });

    await expect(client.onModuleInit()).resolves.toBeUndefined();
    await expect(client.probe()).resolves.toEqual({ connected: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
