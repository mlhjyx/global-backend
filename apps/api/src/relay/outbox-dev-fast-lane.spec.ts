import { WorkflowIdReusePolicy } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxRelayService } from "./outbox-relay.service";
import {
  DEV_FAST_LANE_ACQUISITION_COMMANDS,
  devFastLaneRoute,
  resolveDevFastLane,
  type DevFastLane,
} from "../runtime/dev-fast-lane";
import {
  DELETION_WORKFLOW,
  DISCOVERY_WORKFLOW,
  PERSONAL_ARTIFACT_CLEANUP_WORKFLOW,
  QUALIFY_WORKFLOW,
  UNDERSTANDING_WORKFLOW,
} from "../temporal/understanding.constants";

/**
 * Development fast lane routing in the relay. Pure unit tests with an
 * in-memory outbox and mocked Temporal clients; no database or network.
 */

const LANE_WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const LANE_QUEUE = `understanding-dev-fast-lane-${LANE_WS}`;
const REQUEST_SHA256 = "a".repeat(64);

function budget(workspaceId: string, purpose: string, subjectType: string) {
  return {
    authorityId: "33333333-3333-4333-8333-333333333333",
    replay: false,
    scopeKey: workspaceId,
    accountKey: `${purpose}:${subjectType}:request:${REQUEST_SHA256}:${REQUEST_SHA256}`,
    purpose,
    subjectType,
    subjectId: `request:${REQUEST_SHA256}`,
    requestSha256: REQUEST_SHA256,
  };
}

interface Row {
  id: bigint;
  eventId: string;
  workspaceId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  causationId: string | null;
  privacyClassification: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  publishedAt: Date | null;
  parkedAt: Date | null;
}

function command(
  eventType: string,
  workspaceId: string,
  id: bigint,
  aggregateId = `agg-${id}`,
): Row {
  const payloads: Record<string, [number, Record<string, unknown>]> = {
    CompanyProfileCreated: [
      2,
      {
        website: "https://acme.example/",
        executionBudget: budget(workspaceId, "understanding.run", "company"),
      },
    ],
    DiscoveryRunRequested: [
      2,
      {
        planId: "plan-1",
        icpId: "icp-1",
        executionBudget: budget(workspaceId, "discovery.run", "discovery_run"),
      },
    ],
    QualifyRequested: [1, {}],
    DeletionRequested: [1, { subjectType: "contact", subjectId: "contact-1" }],
    PersonalArtifactCleanupRequested: [1, { deletionRequestId: aggregateId }],
  };
  const [schemaVersion, payload] = payloads[eventType]!;
  return {
    id,
    eventId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
    workspaceId,
    eventType,
    schemaVersion,
    aggregateType: "Aggregate",
    aggregateId,
    producer: "global-backend",
    correlationId: null,
    causationId: null,
    privacyClassification: "CONFIDENTIAL",
    payload,
    occurredAt: new Date("2026-10-14T08:00:00.000Z"),
    publishedAt: null,
    parkedAt: null,
  };
}

type Where = {
  publishedAt: null;
  parkedAt: null;
  workspaceId?: string;
  eventType?: { in: string[] };
  NOT?: { workspaceId: string; eventType: { in: string[] } };
};

/** Honors exactly the filters the relay uses, so batch starvation is observable. */
function makeDb(rows: Row[]) {
  const matches = (row: Row, where: Where) =>
    row.publishedAt === null &&
    row.parkedAt === null &&
    (where.workspaceId === undefined ||
      row.workspaceId === where.workspaceId) &&
    (where.eventType === undefined ||
      where.eventType.in.includes(row.eventType)) &&
    (where.NOT === undefined ||
      !(
        row.workspaceId === where.NOT.workspaceId &&
        where.NOT.eventType.in.includes(row.eventType)
      ));
  return {
    outboxEvent: {
      findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
        rows
          .filter((row) => matches(row, where))
          .sort((a, b) => Number(a.id - b.id))
          .slice(0, take),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: bigint };
          data: Partial<Row>;
        }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      ),
      create: vi.fn(async () => ({})),
    },
    claim: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    outboxDelivery: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  };
}

function managedTemporal(startImpl?: () => Promise<unknown>) {
  return {
    client: { workflow: { start: vi.fn(startImpl ?? (async () => ({}))) } },
  };
}

function laneClient(lane: DevFastLane, startImpl?: () => Promise<unknown>) {
  const workflow = { start: vi.fn(startImpl ?? (async () => ({}))) };
  return {
    lane,
    workflow: vi.fn(async () => workflow),
    route: (eventType: string, workspaceId: string) =>
      devFastLaneRoute(lane, eventType, workspaceId),
    started: workflow.start,
  };
}

function laneFor(workspaceId: string): DevFastLane {
  return resolveDevFastLane("development", {
    RUNTIME_DEV_FAST_LANE_WORKSPACE_ID: workspaceId,
    RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS: "127.0.0.1:7233",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function makeService(
  db: unknown,
  temporal: unknown,
  lane?: ReturnType<typeof laneClient>,
): AnyService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (OutboxRelayService as any)(
    temporal,
    db,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    lane,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("relay routing with the development fast lane", () => {
  it("starts the lane workspace's discovery run on its queue of the development Temporal with a bounded execution", async () => {
    // Arrange
    const ev = command("DiscoveryRunRequested", LANE_WS, 1n, "run-1");
    const temporal = managedTemporal();
    const lane = laneClient(laneFor(LANE_WS));
    const db = makeDb([ev]);

    // Act
    await makeService(db, temporal, lane).routeEvent(ev);

    // Assert
    expect(temporal.client.workflow.start).not.toHaveBeenCalled();
    expect(lane.started).toHaveBeenCalledWith(DISCOVERY_WORKFLOW, {
      taskQueue: LANE_QUEUE,
      workflowId: "discovery-run-1",
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowExecutionTimeout: "185 minutes",
      args: [
        {
          workspaceId: LANE_WS,
          runId: "run-1",
          planId: "plan-1",
          icpId: "icp-1",
          executionContractVersion: 2,
          executionBudget: budget(LANE_WS, "discovery.run", "discovery_run"),
        },
      ],
    });
    expect(ev.publishedAt).toBeInstanceOf(Date);
  });

  it("routes understanding and qualify of the lane workspace to the lane with 30-minute executions", async () => {
    for (const [eventType, workflowType, workflowId] of [
      ["CompanyProfileCreated", UNDERSTANDING_WORKFLOW, "understanding-co-1"],
      ["QualifyRequested", QUALIFY_WORKFLOW, "qualify-co-1"],
    ] as const) {
      // Arrange
      const ev = command(eventType, LANE_WS, 1n, "co-1");
      const temporal = managedTemporal();
      const lane = laneClient(laneFor(LANE_WS));

      // Act
      await makeService(makeDb([ev]), temporal, lane).routeEvent(ev);

      // Assert
      expect(temporal.client.workflow.start, eventType).not.toHaveBeenCalled();
      expect(lane.started, eventType).toHaveBeenCalledWith(
        workflowType,
        expect.objectContaining({
          taskQueue: LANE_QUEUE,
          workflowId,
          workflowExecutionTimeout: "30 minutes",
        }),
      );
      expect(ev.publishedAt, eventType).toBeInstanceOf(Date);
    }
  });

  it("keeps other workspaces, erasure commands and a disabled lane on the managed queue without a timeout", async () => {
    // Arrange
    const cases: Array<[Row, DevFastLane, string]> = [
      [
        command("QualifyRequested", OTHER_WS, 1n),
        laneFor(LANE_WS),
        QUALIFY_WORKFLOW,
      ],
      [
        command("DeletionRequested", LANE_WS, 2n),
        laneFor(LANE_WS),
        DELETION_WORKFLOW,
      ],
      [
        command(
          "PersonalArtifactCleanupRequested",
          LANE_WS,
          3n,
          "44444444-4444-4444-8444-444444444444",
        ),
        laneFor(LANE_WS),
        PERSONAL_ARTIFACT_CLEANUP_WORKFLOW,
      ],
      [
        command("DiscoveryRunRequested", LANE_WS, 4n),
        { enabled: false },
        DISCOVERY_WORKFLOW,
      ],
    ];

    for (const [ev, laneConfig, workflowType] of cases) {
      const temporal = managedTemporal();
      const lane = laneClient(laneConfig);

      // Act
      await makeService(makeDb([ev]), temporal, lane).routeEvent(ev);

      // Assert
      expect(lane.workflow, ev.eventType).not.toHaveBeenCalled();
      const [type, options] = vi.mocked(temporal.client.workflow.start).mock
        .calls[0] as unknown as [string, Record<string, unknown>];
      expect(type, ev.eventType).toBe(workflowType);
      expect(options.taskQueue, ev.eventType).toBe("understanding");
      expect(
        Object.hasOwn(options, "workflowExecutionTimeout"),
        ev.eventType,
      ).toBe(false);
      expect(ev.publishedAt, ev.eventType).toBeInstanceOf(Date);
    }
  });

  it("merges an already started lane workflow and retries a lane that is down", async () => {
    // Arrange
    const merged = command("QualifyRequested", LANE_WS, 1n);
    const down = command("QualifyRequested", LANE_WS, 2n);
    const alreadyStarted = new Error("already started");
    alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
    const mergingLane = laneClient(laneFor(LANE_WS), async () => {
      throw alreadyStarted;
    });
    const downLane = laneClient(laneFor(LANE_WS));
    downLane.workflow.mockRejectedValue(new Error("ECONNREFUSED"));
    const temporal = managedTemporal();

    // Act
    await makeService(makeDb([merged]), temporal, mergingLane).routeEvent(
      merged,
    );
    const downService = makeService(makeDb([down]), temporal, downLane);
    const errors = vi.spyOn(downService["logger"], "error");
    await downService.routeEvent(down);

    // Assert
    expect(merged.publishedAt).toBeInstanceOf(Date);
    expect(down.publishedAt).toBeNull();
    expect(down.parkedAt).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED"),
    );
    expect(temporal.client.workflow.start).not.toHaveBeenCalled();
  });

  it("polls lane commands in their own batch so a stuck lane never starves other workspaces", async () => {
    // Arrange
    const laneRows = Array.from({ length: 25 }, (_, index) =>
      command("QualifyRequested", LANE_WS, BigInt(index + 1)),
    );
    const otherRow = command("QualifyRequested", OTHER_WS, 26n);
    const db = makeDb([...laneRows, otherRow]);
    const temporal = managedTemporal();
    const lane = laneClient(laneFor(LANE_WS));
    lane.workflow.mockRejectedValue(new Error("ECONNREFUSED"));
    const service = makeService(db, temporal, lane);
    vi.spyOn(service["logger"], "error").mockImplementation(() => undefined);

    // Act
    await service.tick();

    // Assert
    expect(otherRow.publishedAt).toBeInstanceOf(Date);
    expect(laneRows.every((row) => row.publishedAt === null)).toBe(true);
    expect(db.outboxEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          publishedAt: null,
          parkedAt: null,
          NOT: {
            workspaceId: LANE_WS,
            eventType: { in: [...DEV_FAST_LANE_ACQUISITION_COMMANDS] },
          },
        },
      }),
    );
    expect(db.outboxEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          publishedAt: null,
          parkedAt: null,
          workspaceId: LANE_WS,
          eventType: { in: [...DEV_FAST_LANE_ACQUISITION_COMMANDS] },
        },
        take: 20,
      }),
    );
    expect(lane.workflow).toHaveBeenCalledTimes(20);
  });

  it("keeps the single managed poll unchanged when the lane is off", async () => {
    // Arrange
    const db = makeDb([command("QualifyRequested", OTHER_WS, 1n)]);
    const service = makeService(
      db,
      managedTemporal(),
      laneClient({ enabled: false }),
    );

    // Act
    await service.tick();

    // Assert
    expect(db.outboxEvent.findMany).toHaveBeenCalledTimes(1);
    expect(db.outboxEvent.findMany).toHaveBeenCalledWith({
      where: { publishedAt: null, parkedAt: null },
      orderBy: { id: "asc" },
      take: 20,
    });
  });
});
