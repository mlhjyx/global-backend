import { describe, expect, it, vi } from "vitest";
import {
  PersonalArtifactCleanupService,
  type PersonalArtifactCleanupCommand,
  type PersonalArtifactCleanupCommandRepository,
  type PrivilegedPersonalArtifactCleanupPort,
} from "./personal-artifact-cleanup.contract";

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000b2";
const DELETION_REQUEST_ID = "00000000-0000-4000-8000-0000000000c3";
const COMMAND_ID = "00000000-0000-4000-8000-0000000000d4";
const ARTIFACT_ID = "00000000-0000-4000-8000-0000000000e5";
const SHA256 = "ab".repeat(32);
const VERSION_ID = "3LgKp9Q4-example-version";

function command(
  overrides: Partial<PersonalArtifactCleanupCommand> = {},
): PersonalArtifactCleanupCommand {
  return Object.freeze({
    schemaVersion: "personal-artifact-cleanup-command/v1",
    commandId: COMMAND_ID,
    workspaceId: WORKSPACE_ID,
    deletionRequestId: DELETION_REQUEST_ID,
    artifactId: ARTIFACT_ID,
    sha256: SHA256,
    versionId: VERSION_ID,
    tombstonedAt: "2026-08-24T08:00:00.000Z",
    attempt: 1,
    ...overrides,
  });
}

function repository(
  claim: Awaited<
    ReturnType<PersonalArtifactCleanupCommandRepository["claimCommitted"]>
  >,
  order: string[] = [],
): PersonalArtifactCleanupCommandRepository {
  return {
    claimCommitted: vi.fn(async () => {
      order.push("claim-committed");
      return claim;
    }),
    complete: vi.fn(async () => {
      order.push("complete");
    }),
    scheduleRetry: vi.fn(async () => {
      order.push("schedule-retry");
    }),
  };
}

function cleanupPort(
  result: "DELETED" | "ABSENT" = "DELETED",
  order: string[] = [],
): PrivilegedPersonalArtifactCleanupPort {
  return {
    deleteFinalVersion: vi.fn(async () => {
      order.push("delete-final-version");
      return result;
    }),
  };
}

describe("PersonalArtifactCleanupService", () => {
  it("completes a recheck when another governed request already removed every eligible version", async () => {
    const commands = repository({ status: "NO_CLEANUP_REQUIRED" });
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);
    await expect(service.cleanup({
      workspaceId: WORKSPACE_ID,
      deletionRequestId: DELETION_REQUEST_ID,
    })).resolves.toEqual({ status: "NO_ACTION", reason: "NO_CLEANUP_REQUIRED" });
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
  });
  it("does not delete before the database tombstone and audit fence are committed", async () => {
    const commands = repository({ status: "TOMBSTONE_FENCE_NOT_COMMITTED" });
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "HOLD",
      reason: "TOMBSTONE_FENCE_NOT_COMMITTED",
    });
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
    expect(commands.complete).not.toHaveBeenCalled();
    expect(commands.scheduleRetry).not.toHaveBeenCalled();
  });

  it("denies a cross-workspace request before the privileged port is reached", async () => {
    const commands = repository({ status: "CROSS_WORKSPACE_DENIED" });
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: OTHER_WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "DENIED",
      reason: "CROSS_WORKSPACE_DENIED",
    });
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
  });

  it("deletes only the digest-derived exact final version after claiming the committed durable command", async () => {
    const order: string[] = [];
    const durable = command();
    const commands = repository({ status: "CLAIMED", command: durable }, order);
    const store = cleanupPort("DELETED", order);
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "COMPLETED",
      commandId: COMMAND_ID,
      objectStatus: "DELETED",
      replay: false,
    });

    expect(order).toEqual([
      "claim-committed",
      "delete-final-version",
      "complete",
    ]);
    expect(store.deleteFinalVersion).toHaveBeenCalledWith({
      sha256: SHA256,
      versionId: VERSION_ID,
    });
    const storeInput = vi.mocked(store.deleteFinalVersion).mock.calls[0]?.[0];
    expect(Reflect.ownKeys(storeInput ?? {})).toEqual(["sha256", "versionId"]);
    expect(durable).not.toHaveProperty("objectKey");
    expect(durable).not.toHaveProperty("body");
    expect(durable).not.toHaveProperty("subjectId");
    expect(commands.complete).toHaveBeenCalledWith(durable, "DELETED");
  });

  it("treats an absent exact version as an idempotent completed cleanup", async () => {
    const durable = command();
    const commands = repository({ status: "CLAIMED", command: durable });
    const store = cleanupPort("ABSENT");
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "COMPLETED",
      commandId: COMMAND_ID,
      objectStatus: "ABSENT",
      replay: false,
    });
    expect(commands.complete).toHaveBeenCalledWith(durable, "ABSENT");
  });

  it("replays a completed durable command without another physical delete", async () => {
    const commands = repository({
      status: "COMPLETED",
      commandId: COMMAND_ID,
      workspaceId: WORKSPACE_ID,
      deletionRequestId: DELETION_REQUEST_ID,
      objectStatus: "ABSENT",
    });
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "COMPLETED",
      commandId: COMMAND_ID,
      objectStatus: "ABSENT",
      replay: true,
    });
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
  });

  it.each([
    [
      "cross-workspace replay",
      {
        status: "COMPLETED",
        commandId: COMMAND_ID,
        workspaceId: OTHER_WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        objectStatus: "ABSENT",
      },
    ],
    [
      "different-request replay",
      {
        status: "COMPLETED",
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        deletionRequestId: ARTIFACT_ID,
        objectStatus: "ABSENT",
      },
    ],
    [
      "malformed replay id",
      {
        status: "COMPLETED",
        commandId: "not-a-uuid",
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        objectStatus: "ABSENT",
      },
    ],
    [
      "malformed replay status",
      {
        status: "COMPLETED",
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        objectStatus: "UNKNOWN",
      },
    ],
    [
      "replay with extra PII",
      {
        status: "COMPLETED",
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        objectStatus: "ABSENT",
        email: "person@example.test",
      },
    ],
    [
      "replay proxy",
      new Proxy(
        {
          status: "COMPLETED",
          commandId: COMMAND_ID,
          workspaceId: WORKSPACE_ID,
          deletionRequestId: DELETION_REQUEST_ID,
          objectStatus: "ABSENT",
        },
        {},
      ),
    ],
  ])("denies an unbound or malformed %s", async (_case, invalidClaim) => {
    const commands = repository(invalidClaim as never);
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "DENIED",
      reason: "INVALID_DURABLE_CLEANUP_COMMAND",
    });
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
  });

  it("rejects replay accessors without evaluating them", async () => {
    let accessorRead = false;
    const invalidClaim = Object.defineProperties(
      {},
      {
        status: {
          enumerable: true,
          get() {
            accessorRead = true;
            throw new Error("must not evaluate replay accessor");
          },
        },
        commandId: { enumerable: true, value: COMMAND_ID },
        workspaceId: { enumerable: true, value: WORKSPACE_ID },
        deletionRequestId: {
          enumerable: true,
          value: DELETION_REQUEST_ID,
        },
        objectStatus: { enumerable: true, value: "ABSENT" },
      },
    );
    const commands = repository(invalidClaim as never);
    const store = cleanupPort();
    const service = new PersonalArtifactCleanupService(commands, store);

    await expect(
      service.cleanup({
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
      }),
    ).resolves.toEqual({
      status: "DENIED",
      reason: "INVALID_DURABLE_CLEANUP_COMMAND",
    });
    expect(accessorRead).toBe(false);
    expect(store.deleteFinalVersion).not.toHaveBeenCalled();
  });

  it("bounds provider failures and durably schedules the same command for retry", async () => {
    const durable = command({ attempt: 2 });
    const commands = repository({ status: "CLAIMED", command: durable });
    const store: PrivilegedPersonalArtifactCleanupPort = {
      deleteFinalVersion: vi.fn(async () => {
        throw new Error("provider request leaked secret=do-not-persist");
      }),
    };
    const service = new PersonalArtifactCleanupService(commands, store);

    const result = await service.cleanup({
      workspaceId: WORKSPACE_ID,
      deletionRequestId: DELETION_REQUEST_ID,
    });

    expect(result).toEqual({
      status: "RETRY_SCHEDULED",
      commandId: COMMAND_ID,
      reason: "PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE",
      retriable: true,
    });
    expect(JSON.stringify(result)).not.toContain("do-not-persist");
    expect(commands.scheduleRetry).toHaveBeenCalledWith(durable, {
      code: "PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE",
      retriable: true,
    });
    expect(commands.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-workspace command", command({ workspaceId: OTHER_WORKSPACE_ID })],
    ["missing exact version", { ...command(), versionId: "" }],
    ["caller object key", { ...command(), objectKey: "caller/chosen/key" }],
    ["body or PII", { ...command(), body: "person@example.test" }],
  ])(
    "rejects an invalid durable %s without touching the store",
    async (_case, invalid) => {
      const commands = repository({
        status: "CLAIMED",
        command: invalid as never,
      });
      const store = cleanupPort();
      const service = new PersonalArtifactCleanupService(commands, store);

      await expect(
        service.cleanup({
          workspaceId: WORKSPACE_ID,
          deletionRequestId: DELETION_REQUEST_ID,
        }),
      ).resolves.toEqual({
        status: "DENIED",
        reason: "INVALID_DURABLE_CLEANUP_COMMAND",
      });
      expect(store.deleteFinalVersion).not.toHaveBeenCalled();
    },
  );
});
