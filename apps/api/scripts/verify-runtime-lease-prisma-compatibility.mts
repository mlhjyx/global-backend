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
  "OUTBOX_RELAY",
]);
const buildSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const artifactDigest = `sha256:${"c".repeat(64)}`;
const migrationRevision =
  "runtime-lease-prisma-void-return-compatibility-verification";

function startingLease(role: RuntimeProcessRole): RuntimeProcessLeaseRecord {
  const startedAt = new Date();
  return Object.freeze({
    instanceId: randomUUID(),
    role,
    state: "STARTING",
    taskQueue: role === "WORKER" ? "runtime-lease-prisma-verification" : null,
    buildSha,
    imageDigest,
    artifactDigest,
    migrationRevision,
    startedAt,
    lastSeenAt: startedAt,
    stoppedAt: null,
  });
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
    const stoppedAt = new Date();
    await store.upsert(
      Object.freeze({
        ...starting,
        state: "STOPPED",
        lastSeenAt: stoppedAt,
        stoppedAt,
      }),
    );

    const rows = await reader.$queryRawUnsafe<
      Array<{
        role: RuntimeProcessRole;
        state: string;
        taskQueue: string | null;
        buildSha: string;
        imageDigest: string;
        artifactDigest: string;
        migrationRevision: string;
        stoppedAt: Date | null;
      }>
    >(
      `SELECT "role", "state"::text AS "state",
              "task_queue" AS "taskQueue", "build_sha" AS "buildSha",
              "image_digest" AS "imageDigest",
              "artifact_digest" AS "artifactDigest",
              "migration_revision" AS "migrationRevision",
              "stopped_at" AS "stoppedAt"
         FROM "runtime_process_lease"
        WHERE "instance_id" = $1::uuid`,
      starting.instanceId,
    );
    const observed = rows[0];
    const expectedTaskQueue =
      role === "WORKER" ? "runtime-lease-prisma-verification" : null;
    if (
      rows.length !== 1 ||
      !observed ||
      observed.role !== role ||
      observed.state !== "STOPPED" ||
      observed.taskQueue !== expectedTaskQueue ||
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

  process.stdout.write(
    `${JSON.stringify({
      status: "RUNTIME_LEASE_PRISMA_COMPATIBILITY_VERIFIED",
      roles: [...roles],
    })}\n`,
  );
} finally {
  await store.onApplicationShutdown();
  await reader.$disconnect();
}
