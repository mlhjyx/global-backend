import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOpsWriter,
  buildWorkerIdentity,
  buildWorkerIdentityFromAttestation,
  sanitizeRuntimeStats,
} from "./runtime-ops.service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const BUILD_SHA = "a".repeat(40);

function fakeDb() {
  return {
    workflowRunReceipt: { create: vi.fn().mockResolvedValue({}) },
    workerHeartbeat: { upsert: vi.fn().mockResolvedValue({}) },
    scheduleDriftReceipt: { create: vi.fn().mockResolvedValue({}) },
  };
}

describe("RuntimeOpsWriter", () => {
  it("writes an append-only, idempotent workflow receipt without workflow args or error text", async () => {
    const db = fakeDb();
    const writer = new RuntimeOpsWriter(db as never, { buildSha: BUILD_SHA });

    await writer.appendWorkflowReceipt({
      workspaceId: WORKSPACE_ID,
      workflowId: "discovery-33333333-3333-4333-8333-333333333333",
      runId: RUN_ID,
      workflowType: "discoveryWorkflow",
      taskQueue: "acquisition",
      phase: "FAILED",
      stage: "qualification",
      stats: { candidates: 12, accepted: 3 },
      errorCode: "BUDGET_EXHAUSTED",
      budgetTruncated: true,
      retryAttempt: 2,
    });

    expect(db.workflowRunReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        workflowId: "discovery-33333333-3333-4333-8333-333333333333",
        runId: RUN_ID,
        workerBuildSha: BUILD_SHA,
        phase: "FAILED",
        stats: { candidates: 12, accepted: 3 },
        errorCode: "BUDGET_EXHAUSTED",
        budgetTruncated: true,
        retryAttempt: 2,
        receiptKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    const persisted = db.workflowRunReceipt.create.mock.calls[0]![0].data;
    expect(persisted).not.toHaveProperty("args");
    expect(persisted).not.toHaveProperty("error");
    expect(JSON.stringify(persisted)).not.toContain("secret");
  });

  it("treats a duplicate receipt key as successful replay but propagates other database failures", async () => {
    const duplicateDb = fakeDb();
    duplicateDb.workflowRunReceipt.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    await expect(
      new RuntimeOpsWriter(duplicateDb as never, {
        buildSha: BUILD_SHA,
      }).appendWorkflowReceipt({
        workspaceId: null,
        workflowId: "acq-sweep-2026-08-07",
        runId: RUN_ID,
        workflowType: "acquisitionSweepWorkflow",
        taskQueue: "acquisition",
        phase: "STARTED",
        stage: "started",
        stats: {},
        errorCode: null,
        budgetTruncated: false,
        retryAttempt: 1,
      }),
    ).resolves.toBeUndefined();

    const failedDb = fakeDb();
    failedDb.workflowRunReceipt.create.mockRejectedValueOnce(
      new Error("db unavailable"),
    );
    await expect(
      new RuntimeOpsWriter(failedDb as never, {
        buildSha: BUILD_SHA,
      }).appendWorkflowReceipt({
        workspaceId: null,
        workflowId: "acq-sweep-2026-08-07",
        runId: RUN_ID,
        workflowType: "acquisitionSweepWorkflow",
        taskQueue: "acquisition",
        phase: "STARTED",
        stage: "started",
        stats: {},
        errorCode: null,
        budgetTruncated: false,
        retryAttempt: 1,
      }),
    ).rejects.toThrow("db unavailable");
  });

  it("rejects free text, PII-shaped stats, invalid identifiers and unbounded counters", async () => {
    expect(() => sanitizeRuntimeStats({ email: "person@example.com" })).toThrow(
      "INVALID_RUNTIME_STATS",
    );
    expect(() => sanitizeRuntimeStats({ candidates: -1 })).toThrow(
      "INVALID_RUNTIME_STATS",
    );
    expect(() => sanitizeRuntimeStats({ candidates: 1.5 })).toThrow(
      "INVALID_RUNTIME_STATS",
    );
    expect(() =>
      sanitizeRuntimeStats(
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])),
      ),
    ).toThrow("INVALID_RUNTIME_STATS");

    const writer = new RuntimeOpsWriter(fakeDb() as never, {
      buildSha: BUILD_SHA,
    });
    await expect(
      writer.appendWorkflowReceipt({
        workspaceId: "not-a-uuid",
        workflowId: "x",
        runId: RUN_ID,
        workflowType: "discoveryWorkflow",
        taskQueue: "acquisition",
        phase: "STARTED",
        stage: "started",
        stats: {},
        errorCode: null,
        budgetTruncated: false,
        retryAttempt: 1,
      }),
    ).rejects.toThrow("INVALID_RUNTIME_RECEIPT");
  });

  it.each([
    { field: "runId", value: "not-a-uuid" },
    { field: "workflowId", value: "person@example.com" },
    { field: "workflowType", value: "bad/type" },
    { field: "taskQueue", value: "unknown" },
    { field: "phase", value: "RUNNING" },
    { field: "stage", value: "Bad Stage" },
    { field: "errorCode", value: "free text" },
    { field: "retryAttempt", value: 0 },
  ])("rejects an invalid workflow receipt $field", async ({ field, value }) => {
    const writer = new RuntimeOpsWriter(fakeDb() as never, {
      buildSha: BUILD_SHA,
    });
    const input = {
      workspaceId: null,
      workflowId: "discovery-run",
      runId: RUN_ID,
      workflowType: "discoveryWorkflow",
      taskQueue: "acquisition",
      phase: "STARTED",
      stage: "started",
      stats: {},
      errorCode: null,
      budgetTruncated: false,
      retryAttempt: 1,
      [field]: value,
    };

    await expect(writer.appendWorkflowReceipt(input as never)).rejects.toThrow(
      "INVALID_RUNTIME_RECEIPT",
    );
  });

  it("upserts a bounded worker heartbeat keyed by worker instance and task queue", async () => {
    const db = fakeDb();
    const writer = new RuntimeOpsWriter(db as never, { buildSha: BUILD_SHA });
    const observedAt = new Date("2026-08-07T12:00:00.000Z");

    await writer.recordWorkerHeartbeat({
      workerInstanceId: "33333333-3333-4333-8333-333333333333",
      taskQueue: "acquisition",
      status: "POLLING",
      observedAt,
      activityConcurrency: 8,
      workflowConcurrency: 8,
    });

    expect(db.workerHeartbeat.upsert).toHaveBeenCalledWith({
      where: {
        workerInstanceId_taskQueue: {
          workerInstanceId: "33333333-3333-4333-8333-333333333333",
          taskQueue: "acquisition",
        },
      },
      create: expect.objectContaining({
        workerBuildSha: BUILD_SHA,
        lastSeenAt: observedAt,
      }),
      update: expect.objectContaining({
        workerBuildSha: BUILD_SHA,
        lastSeenAt: observedAt,
      }),
    });
  });

  it("appends bounded schedule runtime observations without operator notes or cadence payloads", async () => {
    const db = fakeDb();
    const writer = new RuntimeOpsWriter(db as never, { buildSha: BUILD_SHA });
    const nextActionAt = new Date("2026-08-07T12:05:00.000Z");

    await writer.appendScheduleDriftReceipt({
      scheduleId: "external-intent-sweep",
      disposition: "IN_SYNC",
      desiredHash: "b".repeat(64),
      observedHash: "b".repeat(64),
      changedFields: [],
      errorCode: null,
      paused: true,
      nextActionAt,
      missedCatchupCount: 2,
      skippedOverlapCount: 1,
    });

    expect(db.scheduleDriftReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scheduleId: "external-intent-sweep",
        paused: true,
        nextActionAt,
        missedCatchupCount: 2,
        skippedOverlapCount: 1,
        workerBuildSha: BUILD_SHA,
      }),
    });
    expect(JSON.stringify(db.scheduleDriftReceipt.create.mock.calls)).not.toMatch(
      /note|cadence|ops incident/i,
    );
  });

  it("rejects malformed build identities, heartbeat state, and schedule observations", async () => {
    expect(
      () => new RuntimeOpsWriter(fakeDb() as never, { buildSha: "dirty" }),
    ).toThrow("WORKER_BUILD_IDENTITY_REQUIRED");
    const writer = new RuntimeOpsWriter(fakeDb() as never, {
      buildSha: BUILD_SHA,
    });
    await expect(
      writer.recordWorkerHeartbeat({
        workerInstanceId: "not-a-uuid",
        taskQueue: "acquisition",
        status: "POLLING",
        observedAt: new Date(),
        activityConcurrency: 8,
        workflowConcurrency: 8,
      }),
    ).rejects.toThrow("INVALID_RUNTIME_RECEIPT");
    await expect(
      writer.recordWorkerHeartbeat({
        workerInstanceId: "33333333-3333-4333-8333-333333333333",
        taskQueue: "acquisition",
        status: "POLLING",
        observedAt: new Date("invalid"),
        activityConcurrency: 8,
        workflowConcurrency: 8,
      }),
    ).rejects.toThrow("INVALID_RUNTIME_RECEIPT");
    await expect(
      writer.appendScheduleDriftReceipt({
        scheduleId: "external-intent-sweep",
        disposition: "IN_SYNC",
        desiredHash: "b".repeat(64),
        observedHash: null,
        changedFields: [],
        errorCode: null,
        paused: false,
        nextActionAt: null,
        missedCatchupCount: -1,
        skippedOverlapCount: 0,
      }),
    ).rejects.toThrow("INVALID_RUNTIME_RECEIPT");
  });
});

describe("buildWorkerIdentity", () => {
  it("requires an attested sha in pilot/production and allows an explicit development sentinel only in development", () => {
    expect(
      buildWorkerIdentity({ DEPLOYMENT_STAGE: "pilot", BUILD_SHA }),
    ).toEqual({
      buildSha: BUILD_SHA,
    });
    expect(() => buildWorkerIdentity({ DEPLOYMENT_STAGE: "pilot" })).toThrow(
      "WORKER_BUILD_IDENTITY_REQUIRED",
    );
    expect(buildWorkerIdentity({ DEPLOYMENT_STAGE: "development" })).toEqual({
      buildSha: "development-unattested",
    });
    expect(() =>
      buildWorkerIdentity({
        DEPLOYMENT_STAGE: "production",
        BUILD_SHA: "dirty",
      }),
    ).toThrow("WORKER_BUILD_IDENTITY_REQUIRED");
    expect(
      buildWorkerIdentity({ NODE_ENV: "production", BUILD_SHA }),
    ).toEqual({ buildSha: BUILD_SHA });
    expect(() =>
      buildWorkerIdentity({ DEPLOYMENT_STAGE: "staging", BUILD_SHA }),
    ).toThrow("WORKER_BUILD_IDENTITY_REQUIRED");
  });

  it('binds pilot and production identity to a verified artifact receipt', () => {
    expect(
      buildWorkerIdentityFromAttestation('pilot', {
        status: 'VERIFIED',
        buildSha: BUILD_SHA,
      }),
    ).toEqual({ buildSha: BUILD_SHA });
    expect(
      buildWorkerIdentityFromAttestation('development', {
        status: 'UNVERIFIED',
        buildSha: null,
      }),
    ).toEqual({ buildSha: 'development-unattested' });
    for (const stage of ['pilot', 'production'] as const) {
      expect(() =>
        buildWorkerIdentityFromAttestation(stage, {
          status: 'UNVERIFIED',
          buildSha: BUILD_SHA,
        }),
      ).toThrow('WORKER_BUILD_ATTESTATION_REQUIRED');
    }
  });
});
