import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  PrismaRuntimeProcessLeaseStore,
  type RuntimeProcessLeaseRecord,
  type RuntimeProcessRole,
} from "../src/runtime/runtime-process-lease";

const REQUIRED_URLS = Object.freeze([
  "APP_DATABASE_URL",
  "RUNTIME_API_LEASE_DATABASE_URL",
  "RUNTIME_WORKER_LEASE_DATABASE_URL",
  "RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL",
  "RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL",
] as const);

for (const name of REQUIRED_URLS) {
  if (!process.env[name]?.trim()) {
    throw new Error(
      `RUNTIME_LEASE_PRISMA_COMPATIBILITY_CONFIG_REQUIRED:${name}`,
    );
  }
}

const roles = Object.freeze<readonly RuntimeProcessRole[]>([
  "API",
  "WORKER",
  "PLATFORM_WORKER",
  "OUTBOX_RELAY",
]);
const buildSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const artifactDigest = `sha256:${"c".repeat(64)}`;
const migrationRevision =
  "runtime-lease-prisma-void-return-compatibility-verification";
const temporalClusterId = "runtime-lease-prisma-verification";
const temporalClusterProofDigest = `sha256:${"e".repeat(64)}`;

// Worker leases are bound (v2) to one cluster, the role's own namespace and
// workload kind, and the shared "understanding" queue; the database rejects
// anything else with RUNTIME_PROCESS_LEASE_IDENTITY_INVALID.
const BOUND_WORKER = Object.freeze({
  WORKER: { namespace: "default", workloadKind: "customer-worker" },
  PLATFORM_WORKER: {
    namespace: "platform-automation",
    workloadKind: "platform-worker",
  },
} as const);

function boundWorker(role: RuntimeProcessRole) {
  return role === "WORKER" || role === "PLATFORM_WORKER"
    ? BOUND_WORKER[role]
    : null;
}

function startingLease(role: RuntimeProcessRole): RuntimeProcessLeaseRecord {
  const startedAt = new Date();
  const bound = boundWorker(role);
  return Object.freeze({
    instanceId: randomUUID(),
    role,
    state: "STARTING",
    taskQueue: bound ? "understanding" : null,
    temporalClusterId: bound ? temporalClusterId : null,
    temporalClusterProofDigest: bound ? temporalClusterProofDigest : null,
    temporalNamespace: bound?.namespace ?? null,
    workloadKind: bound?.workloadKind ?? null,
    buildSha,
    imageDigest,
    artifactDigest,
    migrationRevision,
    startedAt,
    lastSeenAt: startedAt,
    stoppedAt: null,
  });
}

function stoppedLease(
  record: RuntimeProcessLeaseRecord,
): RuntimeProcessLeaseRecord {
  const stoppedAt = new Date();
  return Object.freeze({
    ...record,
    state: "STOPPED",
    lastSeenAt: stoppedAt,
    stoppedAt,
  });
}

async function readLeaseState(
  instanceId: string,
): Promise<{ state: string; stoppedAt: Date | null } | undefined> {
  const rows = await reader.$queryRawUnsafe<
    Array<{ state: string; stoppedAt: Date | null }>
  >(
    `SELECT "state"::text AS "state", "stopped_at" AS "stoppedAt"
       FROM "runtime_process_lease"
      WHERE "instance_id" = $1::uuid`,
    instanceId,
  );
  return rows[0];
}

const reader = new PrismaClient({
  datasourceUrl: process.env.APP_DATABASE_URL,
});
const store = new PrismaRuntimeProcessLeaseStore(reader as never);

try {
  for (const role of roles) {
    const starting = startingLease(role);
    await store.upsert(starting);
    await store.upsert(
      Object.freeze({ ...starting, state: "READY", lastSeenAt: new Date() }),
    );
    await store.terminalize(stoppedLease(starting));

    const rows = await reader.$queryRawUnsafe<
      Array<{
        role: RuntimeProcessRole;
        state: string;
        taskQueue: string | null;
        temporalClusterId: string | null;
        temporalClusterProofDigest: string | null;
        temporalNamespace: string | null;
        workloadKind: string | null;
        buildSha: string;
        imageDigest: string;
        artifactDigest: string;
        migrationRevision: string;
        stoppedAt: Date | null;
      }>
    >(
      `SELECT "role", "state"::text AS "state",
              "task_queue" AS "taskQueue",
              "temporal_cluster_id" AS "temporalClusterId",
              "temporal_cluster_proof_digest" AS "temporalClusterProofDigest",
              "temporal_namespace" AS "temporalNamespace",
              "workload_kind"::text AS "workloadKind",
              "build_sha" AS "buildSha",
              "image_digest" AS "imageDigest",
              "artifact_digest" AS "artifactDigest",
              "migration_revision" AS "migrationRevision",
              "stopped_at" AS "stoppedAt"
         FROM "runtime_process_lease"
        WHERE "instance_id" = $1::uuid`,
      starting.instanceId,
    );
    const observed = rows[0];
    const bound = boundWorker(role);
    if (
      rows.length !== 1 ||
      !observed ||
      observed.role !== role ||
      observed.state !== "STOPPED" ||
      observed.taskQueue !== (bound ? "understanding" : null) ||
      observed.temporalClusterId !== (bound ? temporalClusterId : null) ||
      observed.temporalClusterProofDigest !==
        (bound ? temporalClusterProofDigest : null) ||
      observed.temporalNamespace !== (bound?.namespace ?? null) ||
      observed.workloadKind !== (bound?.workloadKind ?? null) ||
      observed.buildSha !== buildSha ||
      observed.imageDigest !== imageDigest ||
      observed.artifactDigest !== artifactDigest ||
      observed.migrationRevision !== migrationRevision ||
      !observed.stoppedAt
    ) {
      throw new Error(
        `RUNTIME_LEASE_PRISMA_COMPATIBILITY_READBACK_FAILED:${role}`,
      );
    }
  }

  const missing = startingLease("WORKER");
  const missingStopped = stoppedLease(missing);
  await store.terminalize(missingStopped);
  await store.terminalize(missingStopped);
  const missingObserved = await readLeaseState(missing.instanceId);
  if (missingObserved?.state !== "STOPPED" || !missingObserved.stoppedAt) {
    throw new Error("RUNTIME_LEASE_ATOMIC_MISSING_ROW_TERMINALIZATION_FAILED");
  }
  await store
    .terminalize(
      Object.freeze({
        ...missingStopped,
        buildSha: "d".repeat(40),
      }),
    )
    .then(
      () => {
        throw new Error("RUNTIME_LEASE_ATOMIC_IDENTITY_MISMATCH_ACCEPTED");
      },
      () => undefined,
    );

  const registerFirst = startingLease("WORKER");
  await store.upsert(registerFirst);
  await store.terminalize(stoppedLease(registerFirst));
  if ((await readLeaseState(registerFirst.instanceId))?.state !== "STOPPED") {
    throw new Error("RUNTIME_LEASE_ATOMIC_REGISTER_FIRST_FAILED");
  }

  const terminalFirst = startingLease("WORKER");
  await store.terminalize(stoppedLease(terminalFirst));
  await store.upsert(terminalFirst).then(
    () => {
      throw new Error("RUNTIME_LEASE_ATOMIC_STOPPED_ROW_REOPENED");
    },
    () => undefined,
  );
  if ((await readLeaseState(terminalFirst.instanceId))?.state !== "STOPPED") {
    throw new Error("RUNTIME_LEASE_ATOMIC_TERMINAL_FIRST_FAILED");
  }

  for (let index = 0; index < 20; index += 1) {
    const concurrent = startingLease("WORKER");
    const outcomes = await Promise.allSettled([
      store.upsert(concurrent),
      store.terminalize(stoppedLease(concurrent)),
    ]);
    if (
      outcomes[1]?.status !== "fulfilled" ||
      (await readLeaseState(concurrent.instanceId))?.state !== "STOPPED"
    ) {
      throw new Error("RUNTIME_LEASE_ATOMIC_CONCURRENT_TERMINALIZATION_FAILED");
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "RUNTIME_LEASE_PRISMA_COMPATIBILITY_VERIFIED",
      roles: [...roles],
    })}\n`,
  );
} finally {
  await store.disconnectWriters();
  await reader.$disconnect();
}
