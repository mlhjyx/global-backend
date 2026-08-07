import { ScheduleOverlapPolicy } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_SCHEDULES,
  desiredScheduleOptions,
  reconcilePlatformSchedules,
  scheduleCodeHash,
} from "./schedule-governance";
import { ACQUISITION_TASK_QUEUE } from "./worker-topology";

function existingSchedule(overrides: Record<string, unknown> = {}) {
  return {
    scheduleId: "external-intent-sweep",
    spec: { intervals: [{ every: 42 * 60_000, offset: 0 }] },
    action: {
      type: "startWorkflow",
      workflowType: "wrongWorkflow",
      taskQueue: "understanding",
      args: [{}],
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: 60_000,
      pauseOnFailure: false,
    },
    state: { paused: true, note: "ops incident", remainingActions: 7 },
    searchAttributes: {},
    typedSearchAttributes: {},
    info: {
      recentActions: [],
      nextActionTimes: [],
      numActionsTaken: 0,
      numActionsMissedCatchupWindow: 0,
      numActionsSkippedOverlap: 0,
      createdAt: new Date(0),
      lastUpdatedAt: undefined,
      runningActions: [],
    },
    raw: {},
    ...overrides,
  };
}

function fakeClient(
  descriptions: Map<string, ReturnType<typeof existingSchedule>>,
) {
  const creates: unknown[] = [];
  const updates: { id: string; next: unknown }[] = [];
  const handles = new Map<
    string,
    { describe: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  >();
  const getHandle = vi.fn((id: string) => {
    const current = descriptions.get(id);
    if (!current)
      throw Object.assign(new Error("not found"), {
        name: "ScheduleNotFoundError",
      });
    const handle = {
      describe: vi.fn().mockResolvedValue(current),
      update: vi.fn(async (fn: (previous: typeof current) => unknown) => {
        updates.push({ id, next: fn(current) });
      }),
    };
    handles.set(id, handle);
    return handle;
  });
  return {
    client: {
      schedule: {
        getHandle,
        create: vi.fn(async (options: unknown) => {
          creates.push(options);
        }),
      },
    },
    creates,
    updates,
    handles,
  };
}

describe("schedule governance", () => {
  it("defines code-owned workflow type, task queue, args, timeout and schema version for every schedule", () => {
    expect(PLATFORM_SCHEDULES.length).toBeGreaterThanOrEqual(8);
    for (const contract of PLATFORM_SCHEDULES) {
      expect(contract.schemaVersion).toBe(1);
      expect(contract.workflowType).toMatch(/Workflow$/);
      expect(contract.taskQueue).toMatch(
        /^(acquisition|site-builder|maintenance)$/,
      );
      expect(contract.args).toEqual([
        expect.objectContaining({
          runtimeContract: { scheduleSchemaVersion: 1 },
        }),
      ]);
      expect(scheduleCodeHash(contract)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("creates a missing schedule from the code contract", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const fake = fakeClient(new Map());
    const append = vi.fn().mockResolvedValue(undefined);

    await reconcilePlatformSchedules({
      client: fake.client as never,
      contracts: [target],
      receipts: { append },
      env: {},
    });

    expect(fake.creates).toEqual([desiredScheduleOptions(target, {})]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: target.id,
        disposition: "CREATED",
        desiredHash: scheduleCodeHash(target),
        changedFields: ["missing"],
      }),
    );
  });

  it("reconciles only code-owned action fields and preserves pause, note, remaining actions and cadence override", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const current = existingSchedule();
    const fake = fakeClient(new Map([[target.id, current]]));
    const append = vi.fn().mockResolvedValue(undefined);

    await reconcilePlatformSchedules({
      client: fake.client as never,
      contracts: [target],
      receipts: { append },
      env: {},
    });

    expect(fake.creates).toHaveLength(0);
    expect(fake.updates).toHaveLength(1);
    const next = fake.updates[0]!.next as Record<string, any>;
    expect(next.spec).toBe(current.spec);
    expect(next.state).toBe(current.state);
    expect(next.state).toEqual({
      paused: true,
      note: "ops incident",
      remainingActions: 7,
    });
    expect(next.action.workflowType).toBe(target.workflowType);
    expect(next.action.taskQueue).toBe(ACQUISITION_TASK_QUEUE);
    expect(next.action.args).toEqual(target.args);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "RECONCILED",
        changedFields: expect.arrayContaining([
          "workflowType",
          "taskQueue",
          "args",
          "schemaVersion",
        ]),
      }),
    );
  });

  it("does not overwrite an ops cadence override or paused state when code fields are already current", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const desired = desiredScheduleOptions(target, {});
    const current = existingSchedule({ action: desired.action });
    const fake = fakeClient(new Map([[target.id, current]]));
    const append = vi.fn().mockResolvedValue(undefined);

    await reconcilePlatformSchedules({
      client: fake.client as never,
      contracts: [target],
      receipts: { append },
      env: {},
    });

    expect(fake.updates).toHaveLength(0);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "IN_SYNC", changedFields: [] }),
    );
  });

  it("records a failed drift repair and rethrows instead of silently claiming self-heal", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const current = existingSchedule();
    const fake = fakeClient(new Map([[target.id, current]]));
    fake.client.schedule
      .getHandle(target.id)
      .update.mockRejectedValueOnce(new Error("temporal down"));
    const append = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcilePlatformSchedules({
        client: fake.client as never,
        contracts: [target],
        receipts: { append },
        env: {},
      }),
    ).rejects.toThrow("temporal down");
    expect(append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        disposition: "FAILED",
        errorCode: "SCHEDULE_RECONCILE_FAILED",
      }),
    );
  });
});
