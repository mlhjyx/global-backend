import { Client, Connection } from '@temporalio/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensurePlatformSchedules } from './ensure-schedules';
import { ACQ_SWEEP_SCHEDULE_ID, KB_RECOVERY_SWEEP_SCHEDULE_ID } from './understanding.constants';

vi.mock('@temporalio/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@temporalio/client')>();
  return {
    ...actual,
    Connection: { connect: vi.fn() },
    Client: vi.fn(),
  };
});

function temporalHarness(create: ReturnType<typeof vi.fn>) {
  const close = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const getHandle = vi.fn(() => ({ update }));
  vi.mocked(Connection.connect).mockResolvedValue({ close } as never);
  vi.mocked(Client).mockImplementation(
    function ClientMock() {
      return { schedule: { create, getHandle } };
    } as never,
  );
  return { close, update, getHandle };
}

describe('ensurePlatformSchedules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.TEMPORAL_ADDRESS;
    delete process.env.TEMPORAL_NAMESPACE;
    delete process.env.ACQ_SWEEP_EVERY;
  });

  it('connects with defaults and creates every bounded platform schedule', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const create = vi.fn(async () => undefined);
    const harness = temporalHarness(create);
    await ensurePlatformSchedules();
    expect(Connection.connect).toHaveBeenCalledWith({ address: '127.0.0.1:7233' });
    expect(Client).toHaveBeenCalledWith({ connection: expect.any(Object), namespace: 'default' });
    expect(create).toHaveBeenCalledTimes(8);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: ACQ_SWEEP_SCHEDULE_ID,
        spec: { intervals: [{ every: '10m' }] },
        action: expect.objectContaining({ args: [{}] }),
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: KB_RECOVERY_SWEEP_SCHEDULE_ID,
        action: expect.objectContaining({ args: [{ limit: 10 }], workflowExecutionTimeout: '22 minutes' }),
      }),
    );
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('honors explicit Temporal identity and cadence overrides', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.TEMPORAL_ADDRESS = 'temporal.internal:7233';
    process.env.TEMPORAL_NAMESPACE = 'pilot';
    process.env.ACQ_SWEEP_EVERY = '17m';
    const create = vi.fn(async () => undefined);
    temporalHarness(create);
    await ensurePlatformSchedules();
    expect(Connection.connect).toHaveBeenCalledWith({ address: 'temporal.internal:7233' });
    expect(Client).toHaveBeenCalledWith({ connection: expect.any(Object), namespace: 'pilot' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: ACQ_SWEEP_SCHEDULE_ID,
        spec: { intervals: [{ every: '17m' }] },
      }),
    );
  });

  it.each([
    Object.assign(new Error('already exists'), { name: 'ScheduleAlreadyRunning' }),
    new Error('schedule already running'),
  ])('reconciles only the code-owned KB action for an existing schedule', async (alreadyExists) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const create = vi.fn(async ({ scheduleId }: { scheduleId: string }) => {
      if (scheduleId === KB_RECOVERY_SWEEP_SCHEDULE_ID) throw alreadyExists;
    });
    const harness = temporalHarness(create);
    await ensurePlatformSchedules();
    expect(harness.getHandle).toHaveBeenCalledWith(KB_RECOVERY_SWEEP_SCHEDULE_ID);
    const updater = harness.update.mock.calls[0]?.[0] as (previous: Record<string, any>) => Record<string, any>;
    const previous = {
      spec: { intervals: [{ every: '99m' }] },
      action: { type: 'startWorkflow', args: [{}] },
      policies: { overlap: 'SKIP' },
      state: { paused: true },
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
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not reconcile non-KB schedules that already exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const create = vi.fn(async ({ scheduleId }: { scheduleId: string }) => {
      if (scheduleId === ACQ_SWEEP_SCHEDULE_ID) throw new Error('already exists');
    });
    const harness = temporalHarness(create);
    await ensurePlatformSchedules();
    expect(harness.getHandle).not.toHaveBeenCalled();
  });

  it('propagates unexpected failures and always closes the connection', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const create = vi.fn(async () => {
      throw new Error('temporal rejected action');
    });
    const harness = temporalHarness(create);
    await expect(ensurePlatformSchedules()).rejects.toThrow('temporal rejected action');
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
