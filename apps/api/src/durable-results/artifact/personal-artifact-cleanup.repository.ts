import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA,
  type PersonalArtifactCleanupClaim,
  type PersonalArtifactCleanupCommand,
  type PersonalArtifactCleanupCommandRepository,
  type PersonalArtifactCleanupFailure,
} from './personal-artifact-cleanup.contract';

type CleanupRow = Readonly<{
  command_id: unknown;
  workspace_id: unknown;
  deletion_request_id: unknown;
  artifact_id: unknown;
  sha256: unknown;
  object_version_id: unknown;
  tombstoned_at: unknown;
  attempt: unknown;
  status: unknown;
  object_status: unknown;
}>;

type InspectionRow = Readonly<{
  fence_committed: unknown;
  shared_hold: unknown;
  version_hold: unknown;
}>;

export interface PersonalArtifactCleanupPersistence {
  claim(input: Readonly<{
    workspaceId: string;
    deletionRequestId: string;
  }>): Promise<readonly CleanupRow[]>;
  complete(input: Readonly<{
    command: PersonalArtifactCleanupCommand;
    objectStatus: 'DELETED' | 'ABSENT';
  }>): Promise<readonly CleanupRow[]>;
  retry(input: Readonly<{
    command: PersonalArtifactCleanupCommand;
    code: PersonalArtifactCleanupFailure['code'];
  }>): Promise<readonly CleanupRow[]>;
  inspect(input: Readonly<{
    workspaceId: string;
    deletionRequestId: string;
  }>): Promise<readonly InspectionRow[]>;
}

function invalid(): never {
  throw new Error('INVALID_DURABLE_CLEANUP_COMMAND');
}

function uuid(value: unknown): string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : invalid();
}

function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') return invalid();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid();
  const canonical = date.toISOString();
  if (typeof value === 'string' && value !== canonical) return invalid();
  return canonical;
}

function commandFromRow(row: CleanupRow): PersonalArtifactCleanupCommand {
  if (
    typeof row.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    typeof row.object_version_id !== 'string' ||
    !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(row.object_version_id) ||
    typeof row.attempt !== 'number' ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1
  ) {
    return invalid();
  }
  return Object.freeze({
    schemaVersion: PERSONAL_ARTIFACT_CLEANUP_COMMAND_SCHEMA,
    commandId: uuid(row.command_id),
    workspaceId: uuid(row.workspace_id),
    deletionRequestId: uuid(row.deletion_request_id),
    artifactId: uuid(row.artifact_id),
    sha256: row.sha256,
    versionId: row.object_version_id,
    tombstonedAt: timestamp(row.tombstoned_at),
    attempt: row.attempt,
  });
}

function oneInspection(rows: readonly InspectionRow[]): InspectionRow | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) return invalid();
  const row = rows[0];
  if (
    !row ||
    typeof row.fence_committed !== 'boolean' ||
    typeof row.shared_hold !== 'boolean' ||
    typeof row.version_hold !== 'boolean'
  ) {
    return invalid();
  }
  return row;
}

export class PrismaPersonalArtifactCleanupCommandRepository
  implements PersonalArtifactCleanupCommandRepository
{
  constructor(private readonly persistence: PersonalArtifactCleanupPersistence) {}

  async claimCommitted(input: Readonly<{
    workspaceId: string;
    deletionRequestId: string;
  }>): Promise<PersonalArtifactCleanupClaim> {
    const rows = await this.persistence.claim(input);
    if (rows.length > 1) return invalid();
    const row = rows[0];
    if (row) {
      const command = commandFromRow(row);
      if (
        command.workspaceId !== input.workspaceId ||
        command.deletionRequestId !== input.deletionRequestId
      ) {
        return invalid();
      }
      if (row.status === 'CLAIMED') {
        return Object.freeze({ status: 'CLAIMED', command });
      }
      if (
        row.status === 'COMPLETED' &&
        (row.object_status === 'DELETED' || row.object_status === 'ABSENT')
      ) {
        const inspection = oneInspection(
          await this.persistence.inspect(input),
        );
        if (inspection?.shared_hold) {
          return Object.freeze({ status: 'SHARED_OBJECT_STILL_REFERENCED' });
        }
        if (inspection?.version_hold) {
          return Object.freeze({ status: 'EXACT_OBJECT_VERSION_UNAVAILABLE' });
        }
        return Object.freeze({
          status: 'COMPLETED',
          commandId: command.commandId,
          workspaceId: command.workspaceId,
          deletionRequestId: command.deletionRequestId,
          objectStatus: row.object_status,
        });
      }
      return invalid();
    }

    const inspection = oneInspection(await this.persistence.inspect(input));
    if (!inspection) return Object.freeze({ status: 'CROSS_WORKSPACE_DENIED' });
    if (!inspection.fence_committed) {
      return Object.freeze({ status: 'TOMBSTONE_FENCE_NOT_COMMITTED' });
    }
    if (inspection.shared_hold) {
      return Object.freeze({ status: 'SHARED_OBJECT_STILL_REFERENCED' });
    }
    if (inspection.version_hold) {
      return Object.freeze({ status: 'EXACT_OBJECT_VERSION_UNAVAILABLE' });
    }
    return Object.freeze({ status: 'NO_CLEANUP_REQUIRED' });
  }

  async complete(
    command: PersonalArtifactCleanupCommand,
    objectStatus: 'DELETED' | 'ABSENT',
  ): Promise<void> {
    const rows = await this.persistence.complete({ command, objectStatus });
    if (
      rows.length !== 1 ||
      rows[0]?.status !== 'COMPLETED' ||
      rows[0]?.object_status !== objectStatus
    ) {
      return invalid();
    }
  }

  async scheduleRetry(
    command: PersonalArtifactCleanupCommand,
    failure: PersonalArtifactCleanupFailure,
  ): Promise<void> {
    const rows = await this.persistence.retry({ command, code: failure.code });
    if (
      rows.length !== 1 ||
      rows[0]?.status !== 'RETRY' ||
      typeof rows[0]?.attempt !== 'number' ||
      rows[0].attempt !== command.attempt + 1
    ) {
      return invalid();
    }
  }
}

export function personalArtifactCleanupPersistence(
  prisma: PrismaService,
): PersonalArtifactCleanupPersistence {
  const persistence: PersonalArtifactCleanupPersistence = {
    claim: (input) =>
      prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$queryRaw<CleanupRow[]>(Prisma.sql`
          SELECT * FROM claim_workspace_personal_artifact_cleanup_v1(
            ${input.workspaceId}::uuid, ${input.deletionRequestId}::uuid
          )
        `),
      ),
    inspect: (input) =>
      prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$queryRaw<InspectionRow[]>(Prisma.sql`
          SELECT * FROM inspect_workspace_personal_artifact_cleanup_v1(
            ${input.workspaceId}::uuid, ${input.deletionRequestId}::uuid
          )
        `),
      ),
    complete: ({ command, objectStatus }) =>
      prisma.withWorkspace(command.workspaceId, (tx) =>
        tx.$queryRaw<CleanupRow[]>(Prisma.sql`
          SELECT * FROM complete_workspace_personal_artifact_cleanup_v1(
            ${command.workspaceId}::uuid, ${command.commandId}::uuid,
            ${command.attempt}, ${objectStatus}
          )
        `),
      ),
    retry: ({ command, code }) =>
      prisma.withWorkspace(command.workspaceId, (tx) =>
        tx.$queryRaw<CleanupRow[]>(Prisma.sql`
          SELECT * FROM retry_workspace_personal_artifact_cleanup_v1(
            ${command.workspaceId}::uuid, ${command.commandId}::uuid,
            ${command.attempt}, ${code}
          )
        `),
      ),
  };
  return Object.freeze(persistence);
}

export interface PersonalArtifactCleanupEnqueueResult {
  readonly commandCount: number;
  readonly sharedHoldCount: number;
  readonly versionHoldCount: number;
}

type EnqueueRow = Readonly<{
  command_count: unknown;
  shared_hold_count: unknown;
  version_hold_count: unknown;
}>;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();
}

export class PersonalArtifactCleanupEnqueuer {
  async enqueue(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      workspaceId: string;
      deletionRequestId: string;
    }>,
  ): Promise<PersonalArtifactCleanupEnqueueResult> {
    const rows = await tx.$queryRaw<EnqueueRow[]>(Prisma.sql`
      SELECT * FROM enqueue_workspace_personal_artifact_cleanup_v1(
        ${input.workspaceId}::uuid, ${input.deletionRequestId}::uuid
      )
    `);
    if (rows.length !== 1 || !rows[0]) return invalid();
    const result = Object.freeze({
      commandCount: count(rows[0].command_count),
      sharedHoldCount: count(rows[0].shared_hold_count),
      versionHoldCount: count(rows[0].version_hold_count),
    });
    if (
      result.commandCount === 0 &&
      result.sharedHoldCount === 0 &&
      result.versionHoldCount === 0
    ) return result;
    const existing = await tx.outboxEvent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        eventType: 'PersonalArtifactCleanupRequested',
        aggregateType: 'DeletionRequest',
        aggregateId: input.deletionRequestId,
      },
      select: { eventId: true },
    });
    if (!existing) {
      await tx.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId,
          eventType: 'PersonalArtifactCleanupRequested',
          aggregateType: 'DeletionRequest',
          aggregateId: input.deletionRequestId,
          privacyClassification: 'RESTRICTED',
          payload: {
            deletionRequestId: input.deletionRequestId,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return result;
  }
}

export type PersonalArtifactCleanupTransaction = PrismaClient;
