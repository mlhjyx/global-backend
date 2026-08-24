import { types } from "node:util";
import {
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
} from "./artifact.types";

export const PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA =
  "personal-artifact-cleanup-command/v1" as const;
export const PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE =
  "PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE" as const;

export interface PersonalArtifactCleanupCommand {
  readonly schemaVersion: typeof PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA;
  readonly commandId: string;
  readonly workspaceId: string;
  readonly deletionRequestId: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly versionId: string;
  readonly tombstonedAt: string;
  readonly attempt: number;
}

export type PersonalArtifactCleanupClaim =
  | Readonly<{ status: "TOMBSTONE_FENCE_NOT_COMMITTED" }>
  | Readonly<{ status: "SHARED_OBJECT_STILL_REFERENCED" }>
  | Readonly<{ status: "EXACT_OBJECT_VERSION_UNAVAILABLE" }>
  | Readonly<{ status: "NO_CLEANUP_REQUIRED" }>
  | Readonly<{ status: "CROSS_WORKSPACE_DENIED" }>
  | Readonly<{
      status: "COMPLETED";
      commandId: string;
      workspaceId: string;
      deletionRequestId: string;
      objectStatus: "DELETED" | "ABSENT";
    }>
  | Readonly<{
      status: "CLAIMED";
      command: PersonalArtifactCleanupCommand;
    }>;

export interface PersonalArtifactCleanupFailure {
  readonly code: typeof PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE;
  readonly retriable: true;
}

/**
 * Durable database boundary. A production implementation may return CLAIMED
 * only after both the subject tombstone and its per-DSR audit row have
 * committed for the exact workspace/request. It owns retry state and command
 * idempotency; the cleanup service never manufactures physical-delete input.
 */
export interface PersonalArtifactCleanupCommandRepository {
  claimCommitted(
    input: Readonly<{
      workspaceId: string;
      deletionRequestId: string;
    }>,
  ): Promise<PersonalArtifactCleanupClaim>;
  complete(
    command: PersonalArtifactCleanupCommand,
    objectStatus: "DELETED" | "ABSENT",
  ): Promise<void>;
  scheduleRetry(
    command: PersonalArtifactCleanupCommand,
    failure: PersonalArtifactCleanupFailure,
  ): Promise<void>;
}

/**
 * Separate privileged capability for physical erasure. Implementations must
 * derive the final object key from sha256 internally and address the supplied
 * exact immutable version. No object key, object body, subject, or PII crosses
 * this boundary.
 */
export interface PrivilegedPersonalArtifactCleanupPort {
  deleteFinalVersion(
    input: Readonly<{
      sha256: string;
      versionId: string;
    }>,
  ): Promise<"DELETED" | "ABSENT">;
}

export type PersonalArtifactCleanupResult =
  | Readonly<{
      status: "NO_ACTION";
      reason: "NO_CLEANUP_REQUIRED";
    }>
  | Readonly<{
      status: "HOLD";
      reason: "TOMBSTONE_FENCE_NOT_COMMITTED";
    }>
  | Readonly<{
      status: "HOLD";
      reason:
        | "SHARED_OBJECT_STILL_REFERENCED"
        | "EXACT_OBJECT_VERSION_UNAVAILABLE";
    }>
  | Readonly<{
      status: "DENIED";
      reason: "CROSS_WORKSPACE_DENIED" | "INVALID_DURABLE_CLEANUP_COMMAND";
    }>
  | Readonly<{
      status: "COMPLETED";
      commandId: string;
      objectStatus: "DELETED" | "ABSENT";
      replay: boolean;
    }>
  | Readonly<{
      status: "RETRY_SCHEDULED";
      commandId: string;
      reason: typeof PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE;
      retriable: true;
    }>;

const COMMAND_KEYS = Object.freeze([
  "schemaVersion",
  "commandId",
  "workspaceId",
  "deletionRequestId",
  "artifactId",
  "sha256",
  "versionId",
  "tombstonedAt",
  "attempt",
]);
const VERSION_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,1024}$/;

function closedRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !("value" in descriptor);
      })
    ) {
      return null;
    }
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return timestamp.toISOString() === value ? value : null;
}

function parseCommand(value: unknown): PersonalArtifactCleanupCommand | null {
  const source = closedRecord(value, COMMAND_KEYS);
  const tombstonedAt = canonicalTimestamp(source?.tombstonedAt);
  if (
    !source ||
    source.schemaVersion !== PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA ||
    !isCanonicalArtifactUuid(source.commandId) ||
    !isCanonicalArtifactUuid(source.workspaceId) ||
    !isCanonicalArtifactUuid(source.deletionRequestId) ||
    !isCanonicalArtifactUuid(source.artifactId) ||
    !isCanonicalArtifactSha256(source.sha256) ||
    typeof source.versionId !== "string" ||
    !VERSION_ID_PATTERN.test(source.versionId) ||
    tombstonedAt === null ||
    typeof source.attempt !== "number" ||
    !Number.isSafeInteger(source.attempt) ||
    source.attempt < 1
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA,
    commandId: source.commandId,
    workspaceId: source.workspaceId,
    deletionRequestId: source.deletionRequestId,
    artifactId: source.artifactId,
    sha256: source.sha256,
    versionId: source.versionId,
    tombstonedAt,
    attempt: source.attempt,
  });
}

function requestInput(value: unknown): Readonly<{
  workspaceId: string;
  deletionRequestId: string;
}> | null {
  const source = closedRecord(value, ["workspaceId", "deletionRequestId"]);
  if (
    !source ||
    !isCanonicalArtifactUuid(source.workspaceId) ||
    !isCanonicalArtifactUuid(source.deletionRequestId)
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId: source.workspaceId,
    deletionRequestId: source.deletionRequestId,
  });
}

function parseClaim(value: unknown): PersonalArtifactCleanupClaim | null {
  const fence = closedRecord(value, ["status"]);
  if (fence?.status === "TOMBSTONE_FENCE_NOT_COMMITTED") {
    return Object.freeze({ status: "TOMBSTONE_FENCE_NOT_COMMITTED" });
  }
  if (fence?.status === "SHARED_OBJECT_STILL_REFERENCED") {
    return Object.freeze({ status: "SHARED_OBJECT_STILL_REFERENCED" });
  }
  if (fence?.status === "EXACT_OBJECT_VERSION_UNAVAILABLE") {
    return Object.freeze({ status: "EXACT_OBJECT_VERSION_UNAVAILABLE" });
  }
  if (fence?.status === "NO_CLEANUP_REQUIRED") {
    return Object.freeze({ status: "NO_CLEANUP_REQUIRED" });
  }
  if (fence?.status === "CROSS_WORKSPACE_DENIED") {
    return Object.freeze({ status: "CROSS_WORKSPACE_DENIED" });
  }

  const completed = closedRecord(value, [
    "status",
    "commandId",
    "workspaceId",
    "deletionRequestId",
    "objectStatus",
  ]);
  if (
    completed?.status === "COMPLETED" &&
    isCanonicalArtifactUuid(completed.commandId) &&
    isCanonicalArtifactUuid(completed.workspaceId) &&
    isCanonicalArtifactUuid(completed.deletionRequestId) &&
    (completed.objectStatus === "DELETED" ||
      completed.objectStatus === "ABSENT")
  ) {
    return Object.freeze({
      status: "COMPLETED",
      commandId: completed.commandId,
      workspaceId: completed.workspaceId,
      deletionRequestId: completed.deletionRequestId,
      objectStatus: completed.objectStatus,
    });
  }

  const claimed = closedRecord(value, ["status", "command"]);
  const command =
    claimed?.status === "CLAIMED" ? parseCommand(claimed.command) : null;
  return command ? Object.freeze({ status: "CLAIMED", command }) : null;
}

const boundedFailure = Object.freeze({
  code: PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE,
  retriable: true as const,
});

export class PersonalArtifactCleanupService {
  constructor(
    private readonly commands: PersonalArtifactCleanupCommandRepository,
    private readonly cleanupPort: PrivilegedPersonalArtifactCleanupPort,
  ) {}

  async cleanup(
    input: Readonly<{
      workspaceId: string;
      deletionRequestId: string;
    }>,
  ): Promise<PersonalArtifactCleanupResult> {
    const request = requestInput(input);
    if (!request) {
      return Object.freeze({
        status: "DENIED",
        reason: "INVALID_DURABLE_CLEANUP_COMMAND",
      });
    }
    const claim = parseClaim(await this.commands.claimCommitted(request));
    if (!claim) {
      return Object.freeze({
        status: "DENIED",
        reason: "INVALID_DURABLE_CLEANUP_COMMAND",
      });
    }
    if (claim.status === "TOMBSTONE_FENCE_NOT_COMMITTED") {
      return Object.freeze({
        status: "HOLD",
        reason: "TOMBSTONE_FENCE_NOT_COMMITTED",
      });
    }
    if (
      claim.status === "SHARED_OBJECT_STILL_REFERENCED" ||
      claim.status === "EXACT_OBJECT_VERSION_UNAVAILABLE"
    ) {
      return Object.freeze({ status: "HOLD", reason: claim.status });
    }
    if (claim.status === "NO_CLEANUP_REQUIRED") {
      return Object.freeze({
        status: "NO_ACTION",
        reason: "NO_CLEANUP_REQUIRED",
      });
    }
    if (claim.status === "CROSS_WORKSPACE_DENIED") {
      return Object.freeze({
        status: "DENIED",
        reason: "CROSS_WORKSPACE_DENIED",
      });
    }
    if (claim.status === "COMPLETED") {
      if (
        claim.workspaceId !== request.workspaceId ||
        claim.deletionRequestId !== request.deletionRequestId
      ) {
        return Object.freeze({
          status: "DENIED",
          reason: "INVALID_DURABLE_CLEANUP_COMMAND",
        });
      }
      return Object.freeze({
        status: "COMPLETED",
        commandId: claim.commandId,
        objectStatus: claim.objectStatus,
        replay: true,
      });
    }

    const command = claim.command;
    if (
      !command ||
      command.workspaceId !== request.workspaceId ||
      command.deletionRequestId !== request.deletionRequestId
    ) {
      return Object.freeze({
        status: "DENIED",
        reason: "INVALID_DURABLE_CLEANUP_COMMAND",
      });
    }

    try {
      const objectStatus = await this.cleanupPort.deleteFinalVersion(
        Object.freeze({
          sha256: command.sha256,
          versionId: command.versionId,
        }),
      );
      if (objectStatus !== "DELETED" && objectStatus !== "ABSENT") {
        throw new Error("invalid privileged cleanup result");
      }
      await this.commands.complete(command, objectStatus);
      return Object.freeze({
        status: "COMPLETED",
        commandId: command.commandId,
        objectStatus,
        replay: false,
      });
    } catch {
      await this.commands.scheduleRetry(command, boundedFailure);
      return Object.freeze({
        status: "RETRY_SCHEDULED",
        commandId: command.commandId,
        reason: PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE,
        retriable: true,
      });
    }
  }
}
