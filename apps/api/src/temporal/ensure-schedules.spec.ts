import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRuntimeProcessSnapshot } from '../runtime/runtime-admission';
import {
  ensurePlatformSchedules,
  resolvePlatformScheduleConfiguration,
  type PlatformScheduleDriver,
} from './ensure-schedules';
import {
  ACQ_SWEEP_SCHEDULE_ID,
  KB_RECOVERY_SWEEP_SCHEDULE_ID,
} from './understanding.constants';

afterEach(() => {
  vi.restoreAllMocks();
});

function runtime() {
  return resolveRuntimeProcessSnapshot({
    DEPLOYMENT_STAGE: 'development',
    NODE_ENV: 'test',
    AUTH_ALLOW_DEV_TOKENS: 'true',
    TEMPORAL_ADDRESS: 'temporal.internal:7233',
    TEMPORAL_NAMESPACE: 'pilot-acquisition',
    TEMPORAL_CONNECT_TIMEOUT_MS: '4321',
    ACQ_SWEEP_EVERY: '17m',
  });
}

function fakeDriver(
  create: ReturnType<typeof vi.fn>,
  update: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
) {
  const close = vi.fn(async () => undefined);
  const connection = { close };
  const getHandle = vi.fn(() => ({ update }));
  const client = { schedule: { create, getHandle } };
  const connect = vi.fn(async () => connection);
  const createClient = vi.fn(() => client);
  return {
    close,
    connect,
    createClient,
    create,
    getHandle,
    update,
    driver: { connect, createClient } as unknown as PlatformScheduleDriver,
  };
}

describe('platform schedule immutable runtime boundary', () => {
  it('derives Temporal identity and explicit cadence overrides from one frozen snapshot', () => {
    const snapshot = runtime();
    const configuration = resolvePlatformScheduleConfiguration(snapshot);

    expect(configuration.temporal).toBe(snapshot.safety.temporal);
    expect(configuration.temporal).toMatchObject({
      address: 'temporal.internal:7233',
      namespace: 'pilot-acquisition',
    });
    expect(
      configuration.schedules.find(
        (schedule) => schedule.id === ACQ_SWEEP_SCHEDULE_ID,
      )?.every,
    ).toBe('17m');
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.schedules)).toBe(true);
    expect(Object.isFrozen(configuration.schedules[0])).toBe(true);
  });

  it('rejects a non-canonical cadence override before any Temporal construction', () => {
    const snapshot = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'test',
      AUTH_ALLOW_DEV_TOKENS: 'true',
      ACQ_SWEEP_EVERY: ' 17m',
    });

    expect(() => resolvePlatformScheduleConfiguration(snapshot)).toThrow(
      /ACQ_SWEEP_EVERY.*canonical/i,
    );
  });

  it('does not read mutable process.env inside the schedule reconciler', () => {
    const scheduleSource = readFileSync(
      resolve(process.cwd(), 'src/temporal/ensure-schedules.ts'),
      'utf8',
    );
    const workerSource = readFileSync(
      resolve(process.cwd(), 'src/temporal/worker.ts'),
      'utf8',
    );

    expect(scheduleSource).not.toContain('process.env');
    expect(workerSource).toMatch(/ensurePlatformSchedules\(runtime,\s*\{/u);
  });

  it('connects and creates every schedule from the resolved snapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = fakeDriver(vi.fn(async () => undefined));

    await ensurePlatformSchedules(runtime(), fake.driver);

    expect(fake.connect).toHaveBeenCalledWith({
      address: 'temporal.internal:7233',
      connectTimeout: 4_321,
    });
    expect(fake.createClient).toHaveBeenCalledWith({
      connection: expect.any(Object),
      namespace: 'pilot-acquisition',
    });
    expect(fake.create).toHaveBeenCalledTimes(8);
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: ACQ_SWEEP_SCHEDULE_ID,
        spec: { intervals: [{ every: '17m' }] },
        policies: expect.objectContaining({ catchupWindow: '1 minute' }),
      }),
    );
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('reconciles only the code-owned KB action while preserving ops fields', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const alreadyExists = Object.assign(new Error('exists'), {
      name: 'ScheduleAlreadyRunning',
    });
    const fake = fakeDriver(vi.fn(async () => Promise.reject(alreadyExists)));

    await ensurePlatformSchedules(runtime(), fake.driver);

    expect(fake.getHandle).toHaveBeenCalledOnce();
    expect(fake.getHandle).toHaveBeenCalledWith(KB_RECOVERY_SWEEP_SCHEDULE_ID);
    const updater = fake.update.mock.calls[0]?.[0] as (previous: {
      spec: object;
      action: object;
      policies: object;
      state: object;
      searchAttributes: object;
      typedSearchAttributes: object;
    }) => Record<string, unknown>;
    const previous = {
      spec: { intervals: [{ every: '99m' }] },
      action: { type: 'startWorkflow', args: [{}] },
      policies: { overlap: 'SKIP' },
      state: { paused: true, note: 'ops pause' },
      searchAttributes: { environment: ['pilot'] },
      typedSearchAttributes: { typed: true },
    };

    expect(updater(previous)).toEqual({
      ...previous,
      action: {
        ...previous.action,
        args: [{ limit: 10 }],
        workflowExecutionTimeout: '22 minutes',
      },
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('closes the connection and propagates an unexpected reconciliation error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = fakeDriver(
      vi.fn(async () => Promise.reject(new Error('temporal rejected action'))),
    );

    await expect(
      ensurePlatformSchedules(runtime(), fake.driver),
    ).rejects.toThrow('temporal rejected action');
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
