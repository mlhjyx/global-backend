import { describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityService } from '../runtime/runtime-admission';
import {
  TemporalClient,
  type TemporalClientDriver,
} from './temporal.client';

function runtime(): RuntimeIdentityService {
  return {
    getProcessSnapshot: () => ({
      safety: {
        temporal: {
          address: 'temporal.internal:7233',
          namespace: 'global-pilot',
          connectTimeoutMs: 3_000,
        },
      },
    }),
  } as unknown as RuntimeIdentityService;
}

function driver(options: {
  connect?: ReturnType<typeof vi.fn>;
  getSystemInfo?: ReturnType<typeof vi.fn>;
} = {}): {
  driver: TemporalClientDriver;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getSystemInfo: ReturnType<typeof vi.fn>;
  withDeadline: ReturnType<typeof vi.fn>;
  withAbortSignal: ReturnType<typeof vi.fn>;
  createClient: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const getSystemInfo =
    options.getSystemInfo ?? vi.fn().mockResolvedValue({ capabilities: {} });
  const withAbortSignal = vi.fn(
    async (_signal: AbortSignal, fn: () => Promise<unknown>) => fn(),
  );
  const withDeadline = vi.fn(
    async (_deadline: number, fn: () => Promise<unknown>) => fn(),
  );
  const connection = {
    close,
    workflowService: { getSystemInfo },
    withAbortSignal,
    withDeadline,
  };
  const connect =
    options.connect ?? vi.fn().mockResolvedValue(connection);
  const createClient = vi.fn().mockReturnValue({ workflow: {} });
  return {
    driver: { connect, createClient } as unknown as TemporalClientDriver,
    connect,
    close,
    getSystemInfo,
    withDeadline,
    withAbortSignal,
    createClient,
  };
}

describe('TemporalClient hard startup dependency', () => {
  it('eagerly connects with the frozen address and a finite timeout before lifecycle succeeds', async () => {
    const fake = driver();
    const client = new TemporalClient(runtime(), fake.driver);

    await expect(client.onModuleInit()).resolves.toBeUndefined();
    expect(fake.connect).toHaveBeenCalledWith({
      address: 'temporal.internal:7233',
      connectTimeout: 3_000,
    });
    expect(fake.createClient).toHaveBeenCalledWith({
      connection: expect.any(Object),
      namespace: 'global-pilot',
    });
  });

  it('propagates cold-start connection failure and never creates a usable client', async () => {
    const fake = driver({
      connect: vi.fn().mockRejectedValue(new Error('temporal unavailable')),
    });
    const client = new TemporalClient(runtime(), fake.driver);

    await expect(client.onModuleInit()).rejects.toThrow('temporal unavailable');
    expect(fake.createClient).not.toHaveBeenCalled();
    expect(client.isInitialized()).toBe(false);
  });

  it('fails closed before the Temporal connection is initialized', async () => {
    const fake = driver();
    await expect(
      new TemporalClient(runtime(), fake.driver).checkSystemInfo({
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/not initialized/i);
  });

  it('issues a bounded getSystemInfo request without exposing server details', async () => {
    const fake = driver();
    const client = new TemporalClient(runtime(), fake.driver);
    await client.onModuleInit();
    const signal = new AbortController().signal;

    await expect(
      client.checkSystemInfo({ timeoutMs: 25, signal }),
    ).resolves.toBeUndefined();
    expect(fake.withDeadline).toHaveBeenCalledTimes(1);
    expect(fake.withAbortSignal).toHaveBeenCalledWith(
      signal,
      expect.any(Function),
    );
    expect(fake.getSystemInfo).toHaveBeenCalledWith({});
  });

  it('closes only a successfully initialized connection', async () => {
    const fake = driver();
    const client = new TemporalClient(runtime(), fake.driver);
    await client.onModuleDestroy();
    expect(fake.close).not.toHaveBeenCalled();
    await client.onModuleInit();
    await client.onModuleDestroy();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
