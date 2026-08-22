import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACQ_SWEEP_SCHEDULE_ID,
  INTENT_SWEEP_SCHEDULE_ID,
  KB_RECOVERY_SWEEP_SCHEDULE_ID,
  PATENTS_CACHE_REFRESH_SCHEDULE_ID,
  SANCTIONS_REFRESH_SCHEDULE_ID,
  SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID,
} from "./understanding.constants";
import { ensurePlatformSchedules } from "./ensure-schedules";
import {
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  platformScheduleWorkflowInput,
} from './platform-schedule-authority';

const { connect, close, create, getHandle } = vi.hoisted(() => {
  return {
    connect: vi.fn(),
    close: vi.fn(),
    create: vi.fn(),
    getHandle: vi.fn(),
  };
});
const { MockClient } = vi.hoisted(() => {
  class MockClient {
    schedule = {
      create,
      getHandle,
    };

    // keep constructor explicit so `new Client()` works in implementation code
    constructor() {}
  }

  return { MockClient };
});

const scheduleAlreadyRunning = Object.assign(new Error("schedule already"), {
  name: "ScheduleAlreadyRunning",
});

vi.mock("@temporalio/client", () => ({
  Connection: {
    connect: connect.mockImplementation(async () => ({
      close,
    })),
  },
  Client: MockClient,
  ScheduleOverlapPolicy: {
    SKIP: "SKIP",
  },
}));

describe("ensurePlatformSchedules", () => {
  beforeEach(() => {
    connect.mockClear();
    close.mockClear();
    create.mockClear();
    getHandle.mockClear();
  });

  it("reconciles existing KB recovery and cost-reconciliation schedule actions", async () => {
    const updates: Record<
      string,
      {
        spec: Record<string, unknown>;
        action: {
          args?: unknown[];
          workflowExecutionTimeout?: string;
          [k: string]: unknown;
        };
      }
    > = {};

    const makeHandle = (scheduleId: string) => ({
      update: vi.fn(async (updateFn: (previous: unknown) => unknown) => {
        const previous =
          scheduleId === KB_RECOVERY_SWEEP_SCHEDULE_ID
            ? {
                spec: { intervals: [{ every: "5m" }] },
                action: {
                  type: "startWorkflow",
                  workflowType: "kb-recovery",
                  args: [{ limit: 1 }],
                  workflowExecutionTimeout: "1 minute",
                  taskQueue: "legacy",
                },
                policies: { overlap: "SKIP" },
                state: { notes: "legacy" },
                searchAttributes: { from: ["legacy"] },
                typedSearchAttributes: {},
              }
            : {
                spec: { intervals: [{ every: "1m" }] },
                action: {
                  type: "startWorkflow",
                  workflowType: "cost-reconciliation",
                  args: [{ limit: 5 }],
                  taskQueue: "legacy",
                },
                policies: { overlap: "SKIP" },
                state: { notes: "legacy" },
                searchAttributes: { from: ["legacy"] },
                typedSearchAttributes: {},
              };
        updates[scheduleId] = (updateFn(previous as never) as {
          spec: { intervals: { every: string }[] };
          action: {
            type: string;
            workflowType: string;
            args?: unknown[];
            workflowExecutionTimeout?: string;
            [k: string]: unknown;
          };
          policies: unknown;
          state: unknown;
          searchAttributes: unknown;
          typedSearchAttributes: unknown;
        }) as {
          spec: Record<string, unknown>;
          action: {
            args?: unknown[];
            workflowExecutionTimeout?: string;
            [k: string]: unknown;
          };
        };
        return updates[scheduleId];
      }),
    });

    getHandle.mockImplementation((id: string) => {
      if (id === KB_RECOVERY_SWEEP_SCHEDULE_ID || id === SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID) {
        return makeHandle(id);
      }
      throw new Error(`unexpected handle lookup ${id}`);
    });

    create.mockImplementation(async (payload: { scheduleId: string }) => {
      if (
        payload.scheduleId === KB_RECOVERY_SWEEP_SCHEDULE_ID ||
        payload.scheduleId === SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID
      ) {
        throw scheduleAlreadyRunning;
      }
      return {};
    });

    await ensurePlatformSchedules();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(9);
    expect(getHandle).toHaveBeenCalledTimes(2);
    expect(updates[KB_RECOVERY_SWEEP_SCHEDULE_ID]).toMatchObject({
      action: {
        args: [{ limit: 10 }],
        workflowExecutionTimeout: "22 minutes",
      },
    });
    expect(updates[SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID]).toMatchObject({
      action: {
        args: [{ limit: 50 }],
        workflowExecutionTimeout: "3 minutes",
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: KB_RECOVERY_SWEEP_SCHEDULE_ID,
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID,
      }),
    );
  });

  it('creates every authority-managed schedule with its fixed token-free request envelope', async () => {
    create.mockResolvedValue(undefined);

    await ensurePlatformSchedules();

    for (const scheduleId of [
      ACQ_SWEEP_SCHEDULE_ID,
      INTENT_SWEEP_SCHEDULE_ID,
      SANCTIONS_REFRESH_SCHEDULE_ID,
      PATENTS_CACHE_REFRESH_SCHEDULE_ID,
    ] as const) {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        scheduleId,
        action: expect.objectContaining({
          args: [platformScheduleWorkflowInput(scheduleId)],
        }),
      }));
    }
    const authorityActions = create.mock.calls
      .map(([value]) => value as { scheduleId: string; action: unknown })
      .filter(({ scheduleId }) => Object.hasOwn(PLATFORM_SCHEDULE_AUTHORITY_SCOPES, scheduleId));
    expect(JSON.stringify(authorityActions)).not.toMatch(/jws|token|workspace|cap/i);
  });

  it('reconciles a pre-cutover authority schedule action while preserving cadence and pause state', async () => {
    const update = vi.fn(async (updateFn: (previous: unknown) => unknown) => updateFn({
      spec: { intervals: [{ every: '17m' }] },
      action: {
        type: 'startWorkflow',
        workflowType: 'acquisitionSweepWorkflow',
        taskQueue: 'legacy-queue',
        args: [{}],
      },
      policies: { overlap: 'SKIP' },
      state: { paused: true, notes: 'ops hold' },
      searchAttributes: { source: ['legacy'] },
      typedSearchAttributes: {},
    }));
    create.mockImplementation(async (payload: { scheduleId: string }) => {
      if (payload.scheduleId === ACQ_SWEEP_SCHEDULE_ID) throw scheduleAlreadyRunning;
      return undefined;
    });
    getHandle.mockImplementation((scheduleId: string) => {
      if (scheduleId !== ACQ_SWEEP_SCHEDULE_ID) throw new Error('unexpected handle');
      return { update };
    });

    await ensurePlatformSchedules();

    expect(update).toHaveBeenCalledOnce();
    const updated = update.mock.results[0]?.value;
    await expect(updated).resolves.toMatchObject({
      spec: { intervals: [{ every: '17m' }] },
      action: {
        taskQueue: 'understanding',
        args: [platformScheduleWorkflowInput(ACQ_SWEEP_SCHEDULE_ID)],
      },
      state: { paused: true, notes: 'ops hold' },
      searchAttributes: { source: ['legacy'] },
    });
  });
});
