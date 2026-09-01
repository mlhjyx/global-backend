import { Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaService } from "../prisma/prisma.service";
import type { RuntimeReleaseIdentity } from "./runtime-release-identity";

export type RuntimeProcessRole = "API" | "WORKER" | "OUTBOX_RELAY";
export type RuntimeProcessState = "STARTING" | "READY" | "DRAINING" | "STOPPED";

export interface RuntimeProcessLeaseRecord {
  instanceId: string;
  role: RuntimeProcessRole;
  state: RuntimeProcessState;
  taskQueue: string | null;
  buildSha: string;
  imageDigest: string;
  artifactDigest: string;
  migrationRevision: string;
  startedAt: Date;
  lastSeenAt: Date;
  stoppedAt: Date | null;
}

export interface RuntimeProcessLeaseStore {
  upsert(record: RuntimeProcessLeaseRecord): Promise<void>;
  terminalize(record: RuntimeProcessLeaseRecord): Promise<void>;
  listFresh(input: {
    role: RuntimeProcessRole;
    taskQueue: string | null;
    cutoff: Date;
  }): Promise<RuntimeProcessLeaseRecord[]>;
}

type RuntimeLeaseQueryClient = Pick<PrismaClient, "$queryRawUnsafe"> &
  Partial<Pick<PrismaClient, "$disconnect">>;

const RUNTIME_LEASE_STATEMENT_TIMEOUT_MS = 4_000;

export function withRuntimeLeaseStatementTimeout(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RUNTIME_PROCESS_LEASE_WRITER_URL_INVALID");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("RUNTIME_PROCESS_LEASE_WRITER_URL_INVALID");
  }
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [
      existingOptions,
      `-c statement_timeout=${RUNTIME_LEASE_STATEMENT_TIMEOUT_MS}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return url.toString();
}

export interface RuntimeProcessLeaseStoreOptions {
  env?: NodeJS.ProcessEnv;
  writers?: Partial<Record<RuntimeProcessRole, RuntimeLeaseQueryClient>>;
}

const WRITER_URL_ENV: Readonly<Record<RuntimeProcessRole, string>> = {
  API: "RUNTIME_API_LEASE_DATABASE_URL",
  WORKER: "RUNTIME_WORKER_LEASE_DATABASE_URL",
  OUTBOX_RELAY: "RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL",
};
const REGISTER_FUNCTION: Readonly<Record<RuntimeProcessRole, string>> = {
  API: "register_api_runtime_process_lease",
  WORKER: "register_worker_runtime_process_lease",
  OUTBOX_RELAY: "register_outbox_relay_runtime_process_lease",
};
const HEARTBEAT_FUNCTION: Readonly<Record<RuntimeProcessRole, string>> = {
  API: "heartbeat_api_runtime_process_lease",
  WORKER: "heartbeat_worker_runtime_process_lease",
  OUTBOX_RELAY: "heartbeat_outbox_relay_runtime_process_lease",
};
const TERMINALIZE_FUNCTION: Readonly<Record<RuntimeProcessRole, string>> = {
  API: "terminalize_api_runtime_process_lease",
  WORKER: "terminalize_worker_runtime_process_lease",
  OUTBOX_RELAY: "terminalize_outbox_relay_runtime_process_lease",
};
const DATABASE_ROLE: Readonly<Record<RuntimeProcessRole, string>> = {
  API: "runtime_api",
  WORKER: "runtime_worker",
  OUTBOX_RELAY: "runtime_outbox_relay",
};

interface RuntimeLeasePrincipal {
  sessionUser: string;
  statementTimeout: string;
  superuser: boolean;
  bypassRls: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  memberships: string[];
}

function configuredWriters(
  options: RuntimeProcessLeaseStoreOptions,
): ReadonlyMap<RuntimeProcessRole, RuntimeLeaseQueryClient> {
  const env = options.env ?? process.env;
  const writers = new Map<RuntimeProcessRole, RuntimeLeaseQueryClient>();
  for (const role of PROCESS_ROLES) {
    const injected = options.writers?.[role];
    if (injected) {
      writers.set(role, injected);
      continue;
    }
    const url = env[WRITER_URL_ENV[role]]?.trim();
    if (url) {
      writers.set(
        role,
        new PrismaClient({
          datasourceUrl: withRuntimeLeaseStatementTimeout(url),
        }),
      );
    }
  }
  return writers;
}

@Injectable()
export class PrismaRuntimeProcessLeaseStore implements RuntimeProcessLeaseStore {
  private readonly registeredInstances = new Set<string>();
  private readonly verifiedWriters = new Set<RuntimeProcessRole>();
  private readonly writers: ReadonlyMap<
    RuntimeProcessRole,
    RuntimeLeaseQueryClient
  >;
  private disconnectPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    options: RuntimeProcessLeaseStoreOptions = {},
  ) {
    this.writers = configuredWriters(options);
  }

  async upsert(record: RuntimeProcessLeaseRecord): Promise<void> {
    const writer = this.writers.get(record.role);
    if (!writer) throw new Error("RUNTIME_PROCESS_LEASE_WRITER_UNAVAILABLE");
    await this.assertWriterIdentity(record.role, writer);
    const registerFunction = REGISTER_FUNCTION[record.role];
    const heartbeatFunction = HEARTBEAT_FUNCTION[record.role];
    let registeredNow = false;
    if (!this.registeredInstances.has(record.instanceId)) {
      await writer.$queryRawUnsafe<Array<{ instance_id: string }>>(
        `SELECT ${registerFunction}(
          $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz
        ) AS instance_id`,
        record.instanceId,
        record.taskQueue,
        record.buildSha,
        record.imageDigest,
        record.artifactDigest,
        record.migrationRevision,
        record.startedAt,
      );
      this.registeredInstances.add(record.instanceId);
      registeredNow = true;
    }
    if (registeredNow && record.state === "STARTING") return;
    await writer.$queryRawUnsafe<Array<{ heartbeat: string }>>(
      `SELECT ${heartbeatFunction}(
        $1::uuid, $2::"runtime_process_state", $3::timestamptz
      )::text AS "heartbeat"`,
      record.instanceId,
      record.state,
      record.lastSeenAt,
    );
  }

  async terminalize(record: RuntimeProcessLeaseRecord): Promise<void> {
    if (record.state !== "STOPPED" || !record.stoppedAt) {
      throw new Error("RUNTIME_PROCESS_LEASE_TERMINAL_STATE_REQUIRED");
    }
    const writer = this.writers.get(record.role);
    if (!writer) throw new Error("RUNTIME_PROCESS_LEASE_WRITER_UNAVAILABLE");
    await this.assertWriterIdentity(record.role, writer);
    const terminalizeFunction = TERMINALIZE_FUNCTION[record.role];
    await writer.$queryRawUnsafe<Array<{ instance_id: string }>>(
      `SELECT ${terminalizeFunction}(
        $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
        $7::timestamptz, $8::timestamptz
      ) AS instance_id`,
      record.instanceId,
      record.taskQueue,
      record.buildSha,
      record.imageDigest,
      record.artifactDigest,
      record.migrationRevision,
      record.startedAt,
      record.stoppedAt,
    );
    this.registeredInstances.add(record.instanceId);
  }

  private async assertWriterIdentity(
    role: RuntimeProcessRole,
    writer: RuntimeLeaseQueryClient,
  ): Promise<void> {
    if (this.verifiedWriters.has(role)) return;
    const rows = await writer.$queryRawUnsafe<RuntimeLeasePrincipal[]>(
      `SELECT p.rolname::text AS "sessionUser",
              current_setting('statement_timeout')::text AS "statementTimeout",
              p.rolsuper AS "superuser", p.rolbypassrls AS "bypassRls",
              p.rolcreatedb AS "createDb", p.rolcreaterole AS "createRole",
              p.rolreplication AS "replication",
              COALESCE(ARRAY(
                SELECT granted.rolname::text
                  FROM pg_catalog.pg_auth_members membership
                  JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
                 WHERE membership.member = p.oid
                 ORDER BY granted.rolname
              ), ARRAY[]::text[]) AS "memberships"
         FROM pg_catalog.pg_roles p
        WHERE p.rolname = session_user`,
    );
    const principal = rows[0];
    const expectedMembership = DATABASE_ROLE[role];
    if (
      rows.length !== 1 ||
      !principal ||
      principal.statementTimeout !== "4s" ||
      principal.superuser ||
      principal.bypassRls ||
      principal.createDb ||
      principal.createRole ||
      principal.replication ||
      principal.memberships.length !== 1 ||
      principal.memberships[0] !== expectedMembership
    ) {
      throw new Error("RUNTIME_PROCESS_LEASE_WRITER_IDENTITY_INVALID");
    }
    this.verifiedWriters.add(role);
  }

  disconnectWriters(): Promise<void> {
    this.disconnectPromise ??= this.disconnectWriterClients();
    return this.disconnectPromise;
  }

  private async disconnectWriterClients(): Promise<void> {
    const clients = new Set(this.writers.values());
    await Promise.all(
      [...clients].map((client) =>
        client.$disconnect?.().catch(() => undefined),
      ),
    );
  }

  async listFresh(input: {
    role: RuntimeProcessRole;
    taskQueue: string | null;
    cutoff: Date;
  }): Promise<RuntimeProcessLeaseRecord[]> {
    return this.prisma.$queryRawUnsafe<RuntimeProcessLeaseRecord[]>(
      `SELECT "instance_id" AS "instanceId", "role", "state",
              "task_queue" AS "taskQueue", "build_sha" AS "buildSha",
              "image_digest" AS "imageDigest", "artifact_digest" AS "artifactDigest",
              "migration_revision" AS "migrationRevision", "started_at" AS "startedAt",
              "last_seen_at" AS "lastSeenAt", "stopped_at" AS "stoppedAt"
         FROM "runtime_process_lease"
        WHERE "role" = $1::"runtime_process_role"
          AND ($2::text IS NULL OR "task_queue" = $2)
          AND "last_seen_at" >= $3
        ORDER BY "instance_id" ASC`,
      input.role,
      input.taskQueue,
      input.cutoff,
    );
  }
}

type ProcessLeaseInspection =
  Readonly<{ status: "ok" }> | Readonly<{ status: "failed"; code: string }>;

const FRESHNESS_MS = 30_000;
const PROCESS_ROLES: readonly RuntimeProcessRole[] = [
  "API",
  "WORKER",
  "OUTBOX_RELAY",
];

function roleInstanceId(seed: string, role: RuntimeProcessRole): string {
  const digest = createHash("sha256").update(`${seed}\0${role}`).digest("hex");
  const variant = (
    (Number.parseInt(digest[16] ?? "0", 16) & 0x3) |
    0x8
  ).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function sameRelease(
  record: RuntimeProcessLeaseRecord,
  identity: Extract<RuntimeReleaseIdentity, { attested: true }>,
): boolean {
  return (
    record.buildSha === identity.build_sha &&
    record.imageDigest === identity.image_digest &&
    record.artifactDigest === identity.artifact_digest &&
    record.migrationRevision === identity.migration_revision
  );
}

export class RuntimeProcessLeaseService {
  private readonly startedAt = new Map<RuntimeProcessRole, Date>();
  private readonly instanceIds: ReadonlyMap<RuntimeProcessRole, string>;

  constructor(
    private readonly store: RuntimeProcessLeaseStore,
    private readonly options: {
      identity: RuntimeReleaseIdentity;
      instanceId?: string;
      now?: () => Date;
    },
  ) {
    const processSeed = options.instanceId ?? randomUUID();
    this.instanceIds = new Map(
      PROCESS_ROLES.map((role) => [role, roleInstanceId(processSeed, role)]),
    );
    this.options = Object.freeze({
      ...options,
      instanceId: processSeed,
      now: options.now ?? (() => new Date()),
    });
  }

  async heartbeat(
    role: RuntimeProcessRole,
    state: RuntimeProcessState,
    taskQueue: string | null,
  ): Promise<void> {
    const identity = this.options.identity;
    if (!identity.attested) {
      throw new Error("runtime release identity is unavailable");
    }
    const now = this.options.now!();
    const instanceId = this.instanceIds.get(role);
    if (!instanceId)
      throw new Error("runtime process role identity is unavailable");
    const startedAt = this.startedAt.get(role) ?? now;
    this.startedAt.set(role, startedAt);
    await this.store.upsert({
      instanceId,
      role,
      state,
      taskQueue,
      buildSha: identity.build_sha,
      imageDigest: identity.image_digest,
      artifactDigest: identity.artifact_digest,
      migrationRevision: identity.migration_revision,
      startedAt,
      lastSeenAt: now,
      stoppedAt: state === "STOPPED" ? now : null,
    });
  }

  async terminalize(
    role: RuntimeProcessRole,
    taskQueue: string | null,
  ): Promise<void> {
    const identity = this.options.identity;
    if (!identity.attested) {
      throw new Error("runtime release identity is unavailable");
    }
    const now = this.options.now!();
    const instanceId = this.instanceIds.get(role);
    if (!instanceId) {
      throw new Error("runtime process role identity is unavailable");
    }
    const startedAt = this.startedAt.get(role) ?? now;
    this.startedAt.set(role, startedAt);
    await this.store.terminalize({
      instanceId,
      role,
      state: "STOPPED",
      taskQueue,
      buildSha: identity.build_sha,
      imageDigest: identity.image_digest,
      artifactDigest: identity.artifact_digest,
      migrationRevision: identity.migration_revision,
      startedAt,
      lastSeenAt: now,
      stoppedAt: now,
    });
  }

  async inspectWorkerQueue(
    taskQueue: string,
    options: { requireReady?: boolean } = {},
  ): Promise<ProcessLeaseInspection> {
    return this.inspect("WORKER", taskQueue, options.requireReady ?? true);
  }

  async inspectRole(role: RuntimeProcessRole): Promise<ProcessLeaseInspection> {
    return this.inspect(role, null, true);
  }

  private async inspect(
    role: RuntimeProcessRole,
    taskQueue: string | null,
    requireReady: boolean,
  ): Promise<ProcessLeaseInspection> {
    const identity = this.options.identity;
    if (!identity.attested) {
      return { status: "failed", code: "RUNTIME_RELEASE_IDENTITY_UNAVAILABLE" };
    }
    const now = this.options.now!();
    const cutoff = new Date(now.getTime() - FRESHNESS_MS);
    const records = (
      await this.store.listFresh({ role, taskQueue, cutoff })
    ).filter(
      (record) =>
        record.lastSeenAt >= cutoff &&
        record.state !== "STOPPED" &&
        (taskQueue === null || record.taskQueue === taskQueue),
    );
    if (records.some((record) => !sameRelease(record, identity))) {
      return {
        status: "failed",
        code:
          role === "WORKER"
            ? "WORKER_MIXED_RELEASE_IDENTITY"
            : `${role}_MIXED_RELEASE_IDENTITY`,
      };
    }
    if (requireReady && !records.some((record) => record.state === "READY")) {
      return {
        status: "failed",
        code:
          role === "WORKER" ? "MATCHING_WORKER_NOT_READY" : `${role}_NOT_READY`,
      };
    }
    return { status: "ok" };
  }
}

export async function assertMigrationCompatible(
  prisma: Pick<PrismaService, "$queryRawUnsafe">,
  identity: RuntimeReleaseIdentity,
): Promise<void> {
  if (!identity.attested)
    throw new Error("RUNTIME_RELEASE_IDENTITY_UNAVAILABLE");
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name
       FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC, migration_name DESC
      LIMIT 1`,
  );
  if (rows[0]?.migration_name !== identity.migration_revision) {
    throw new Error("MIGRATION_REVISION_MISMATCH");
  }
}
