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
    const cached = handles.get(id);
    if (cached) return cached;
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

  it("treats a concurrent ScheduleAlreadyRunning create as a race and reconciles the winner", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const desired = desiredScheduleOptions(target, {});
    let describeCalls = 0;
    const update = vi.fn();
    const client = {
      schedule: {
        getHandle: vi.fn(() => ({
          describe: vi.fn(async () => {
            describeCalls += 1;
            if (describeCalls === 1) {
              throw Object.assign(new Error("missing"), {
                name: "ScheduleNotFoundError",
              });
            }
            return existingSchedule({ action: desired.action });
          }),
          update,
        })),
        create: vi.fn(async () => {
          throw Object.assign(new Error("winner created it"), {
            name: "ScheduleAlreadyRunning",
          });
        }),
      },
    };
    const append = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcilePlatformSchedules({
        client: client as never,
        contracts: [target],
        receipts: { append },
        env: {},
      }),
    ).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(append).toHaveBeenLastCalledWith(
      expect.objectContaining({ disposition: "IN_SYNC" }),
    );
  });

  it.each(["", " 1h", "1 hour", "unbounded", "0m"])(
    "rejects invalid code-default or override cadence %s before a Temporal call",
    (cadence) => {
      const target = PLATFORM_SCHEDULES[0]!;
      expect(() =>
        desiredScheduleOptions(target, { [target.cadenceEnv]: cadence }),
      ).toThrow("INVALID_SCHEDULE_CADENCE");
    },
  );

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
    const next = fake.updates[0]!.next as {
      spec: unknown;
      state: unknown;
      action: { workflowType: string; taskQueue: string; args: unknown[] };
    };
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

  it("records bounded runtime observations while excluding the operator note and cadence", async () => {
    const target = PLATFORM_SCHEDULES.find(
      (item) => item.id === "external-intent-sweep",
    )!;
    const desired = desiredScheduleOptions(target, {});
    const current = existingSchedule({
      action: desired.action,
      info: {
        ...existingSchedule().info,
        nextActionTimes: [new Date("2026-08-07T12:05:00.000Z")],
        numActionsMissedCatchupWindow: 2,
        numActionsSkippedOverlap: 3,
      },
    });
    const fake = fakeClient(new Map([[target.id, current]]));
    const append = vi.fn().mockResolvedValue(undefined);

    await reconcilePlatformSchedules({
      client: fake.client as never,
      contracts: [target],
      receipts: { append },
      env: {},
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        paused: true,
        nextActionAt: new Date("2026-08-07T12:05:00.000Z"),
        missedCatchupCount: 2,
        skippedOverlapCount: 3,
      }),
    );
    expect(JSON.stringify(append.mock.calls)).not.toMatch(/ops incident|42m/i);
  });

  it("persists a FAILED receipt when the first schedule description fails unexpectedly", async () => {
    const target = PLATFORM_SCHEDULES[0]!;
    const failure = Object.assign(new Error("transport details"), {
      name: "ConnectionError",
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const client = {
      schedule: {
        getHandle: vi.fn(() => ({
          describe: vi.fn().mockRejectedValue(failure),
          update: vi.fn(),
        })),
        create: vi.fn(),
      },
    };

    await expect(
      reconcilePlatformSchedules({
        client: client as never,
        contracts: [target],
        receipts: { append },
        env: {},
      }),
    ).rejects.toBe(failure);
    expect(append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        disposition: "FAILED",
        changedFields: ["describe"],
        errorCode: "SCHEDULE_DESCRIBE_FAILED",
      }),
    );
    expect(JSON.stringify(append.mock.calls)).not.toContain("transport details");
  });
});
