import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { EventsService } from "../../../apps/api/src/events/events.service.ts";
import { PrismaService } from "../../../apps/api/src/prisma/prisma.service.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const postgresImage =
  "pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b";
const containerName = `codex-event-ack-readback-${process.pid}-${randomBytes(3).toString("hex")}`;
const databaseName = "event_ack_readback";
const postgresPassword = randomBytes(24).toString("hex");
const ownerPassword = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const previousAppDatabaseUrl = process.env.APP_DATABASE_URL;

const ids = Object.freeze({
  workspaceA: "10000000-0000-4000-8000-000000000001",
  workspaceB: "10000000-0000-4000-8000-000000000002",
  pending: "a1000000-0000-4000-8000-000000000001",
  otherWorkspace: "a1000000-0000-4000-8000-000000000002",
  webhookOnly: "a1000000-0000-4000-8000-000000000003",
  internal: "a1000000-0000-4000-8000-000000000004",
  dead: "a1000000-0000-4000-8000-000000000005",
});

function redactSecrets(value) {
  return String(value ?? "")
    .replaceAll(postgresPassword, "[REDACTED_POSTGRES_PASSWORD]")
    .replaceAll(ownerPassword, "[REDACTED_OWNER_PASSWORD]")
    .replaceAll(appPassword, "[REDACTED_APP_PASSWORD]");
}

function commandFailure(result) {
  return redactSecrets(
    `${result.error?.message ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  );
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
  assert.equal(result.status, 0, commandFailure(result));
  return result.stdout.trim();
}

function psql(sql) {
  return docker(
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      databaseName,
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql },
  );
}

function expectNotFound(promise) {
  return assert.rejects(
    promise,
    (error) =>
      typeof error === "object" &&
      error !== null &&
      typeof error.getStatus === "function" &&
      error.getStatus() === 404,
  );
}

function insertEvent(eventId, workspaceId, eventType) {
  return `
    INSERT INTO outbox_event(
      event_id, workspace_id, event_type, schema_version, aggregate_type,
      aggregate_id, producer, privacy_classification, payload, published_at
    ) VALUES (
      '${eventId}'::uuid, '${workspaceId}'::uuid, '${eventType}', 1, 'Lead',
      '${eventId}', 'global-backend', 'CONFIDENTIAL', '{}'::jsonb, now()
    );`;
}

function insertDelivery(eventId, workspaceId, sink, status) {
  const acknowledged = status === "ACKED" ? "now()" : "NULL";
  return `
    INSERT INTO outbox_delivery(
      workspace_id, event_id, sink, status, delivered_at, acked_at
    ) VALUES (
      '${workspaceId}'::uuid, '${eventId}'::uuid, '${sink}', '${status}',
      ${acknowledged}, ${acknowledged}
    );`;
}

describe(
  "Events ACK status on disposable PostgreSQL 16",
  { concurrency: false },
  () => {
    let prisma;
    let service;
    let containerStarted = false;

    before(
      async () => {
        docker(["image", "inspect", postgresImage]);
        docker([
          "run",
          "-d",
          "--name",
          containerName,
          "--publish",
          "127.0.0.1::5432",
          "--tmpfs",
          "/var/lib/postgresql/data:rw,nosuid,size=768m",
          "--env",
          `POSTGRES_PASSWORD=${postgresPassword}`,
          postgresImage,
        ]);
        containerStarted = true;

        let consecutiveReady = 0;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const readiness = spawnSync(
            "docker",
            [
              "exec",
              containerName,
              "psql",
              "-U",
              "postgres",
              "-d",
              "postgres",
              "--no-psqlrc",
              "-X",
              "-qAt",
              "-c",
              "SELECT 1",
            ],
            { encoding: "utf8", timeout: 5_000 },
          );
          consecutiveReady = readiness.status === 0 ? consecutiveReady + 1 : 0;
          if (consecutiveReady >= 2) break;
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, 100),
          );
        }
        assert.equal(
          consecutiveReady >= 2,
          true,
          "disposable PostgreSQL did not become ready",
        );

        docker(
          [
            "exec",
            "-i",
            containerName,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "--no-psqlrc",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
          ],
          {
            input: `
          CREATE ROLE global LOGIN SUPERUSER PASSWORD '${ownerPassword}';
          CREATE DATABASE ${databaseName} OWNER global;
        `,
          },
        );

        const portOutput = docker(["port", containerName, "5432/tcp"]);
        const port = /^127\.0\.0\.1:(\d+)$/u.exec(portOutput)?.[1];
        assert.ok(
          port,
          `PostgreSQL was not bound only to loopback: ${portOutput}`,
        );
        assert.equal(
          psql(
            "SELECT current_setting('server_version_num')::integer / 10000;",
          ),
          "16",
          "disposable database must run PostgreSQL major version 16",
        );
        const ownerUrl = `postgresql://global:${ownerPassword}@127.0.0.1:${port}/${databaseName}?schema=public`;
        const migration = spawnSync(
          "pnpm",
          ["--filter", "@global/db", "exec", "prisma", "migrate", "deploy"],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 180_000,
            env: {
              ...process.env,
              DATABASE_URL: ownerUrl,
              PRISMA_HIDE_UPDATE_MESSAGE: "1",
              CHECKPOINT_DISABLE: "1",
            },
          },
        );
        assert.equal(migration.status, 0, commandFailure(migration));

        psql(`ALTER ROLE app_user PASSWORD '${appPassword}';`);

        psql(`
        INSERT INTO workspace(id, name, created_at, updated_at) VALUES
          ('${ids.workspaceA}'::uuid, 'ACK workspace A', now(), now()),
          ('${ids.workspaceB}'::uuid, 'ACK workspace B', now(), now());
        ${insertEvent(ids.pending, ids.workspaceA, "LeadQualified")}
        ${insertDelivery(ids.pending, ids.workspaceA, "saas", "PENDING")}
        ${insertEvent(ids.otherWorkspace, ids.workspaceB, "LeadQualified")}
        ${insertDelivery(ids.otherWorkspace, ids.workspaceB, "saas", "ACKED")}
        ${insertEvent(ids.webhookOnly, ids.workspaceA, "LeadQualified")}
        ${insertDelivery(ids.webhookOnly, ids.workspaceA, "webhook", "ACKED")}
        ${insertEvent(ids.internal, ids.workspaceA, "QualifyRequested")}
        ${insertDelivery(ids.internal, ids.workspaceA, "saas", "PENDING")}
        ${insertEvent(ids.dead, ids.workspaceA, "LeadQualified")}
        ${insertDelivery(ids.dead, ids.workspaceA, "saas", "DEAD")}
      `);

        process.env.APP_DATABASE_URL = `postgresql://app_user:${appPassword}@127.0.0.1:${port}/${databaseName}?schema=public&connection_limit=2`;
        prisma = new PrismaService();
        assert.deepEqual(await prisma.reconnect(), { status: "ready" });
        service = new EventsService(prisma);
      },
      { timeout: 180_000 },
    );

    after(async () => {
      try {
        if (prisma) await prisma.onModuleDestroy();
      } finally {
        if (previousAppDatabaseUrl === undefined)
          delete process.env.APP_DATABASE_URL;
        else process.env.APP_DATABASE_URL = previousAppDatabaseUrl;
        if (containerStarted) {
          assert.match(
            containerName,
            /^codex-event-ack-readback-[0-9]+-[0-9a-f]{6}$/u,
          );
          const cleanup = spawnSync("docker", ["rm", "-f", containerName], {
            encoding: "utf8",
            timeout: 30_000,
          });
          assert.equal(cleanup.status, 0, commandFailure(cleanup));
          const verifyRemoved = spawnSync(
            "docker",
            ["container", "inspect", containerName],
            { encoding: "utf8", timeout: 10_000 },
          );
          assert.equal(
            verifyRemoved.status,
            1,
            `task-owned container absence was not proven: ${containerName}\n${commandFailure(verifyRemoved)}`,
          );
          assert.match(
            `${verifyRemoved.stderr}\n${verifyRemoved.stdout}`,
            /No such (?:container|object)/u,
          );
          containerStarted = false;
        }
      }
    });

    it("enforces app_user RLS before the service-level workspace predicate", async () => {
      const visibleFromA = await prisma.withWorkspace(
        ids.workspaceA,
        (transaction) =>
          transaction.outboxDelivery.findMany({
            where: { eventId: ids.otherWorkspace },
          }),
      );
      const visibleFromB = await prisma.withWorkspace(
        ids.workspaceB,
        (transaction) =>
          transaction.outboxDelivery.findMany({
            where: { eventId: ids.otherWorkspace },
          }),
      );
      assert.deepEqual(visibleFromA, []);
      assert.equal(visibleFromB.length, 1);

      await expectNotFound(
        service.ackStatus(
          {
            workspaceId: ids.workspaceA,
            userId: "program-c-consumer",
            roles: ["service"],
          },
          ids.otherWorkspace,
        ),
      );
    });

    it("reads only the saas delivery of registered integration events", async () => {
      const context = {
        workspaceId: ids.workspaceA,
        userId: "program-c-consumer",
        roles: ["service"],
      };
      await expectNotFound(service.ackStatus(context, ids.webhookOnly));
      await expectNotFound(service.ackStatus(context, ids.internal));
    });

    it("reads ACKED truth after PENDING mutation even when the repeated ACK returns zero", async () => {
      const context = {
        workspaceId: ids.workspaceA,
        userId: "program-c-consumer",
        roles: ["service"],
      };
      assert.deepEqual(await service.ackStatus(context, ids.pending), {
        event_id: ids.pending,
        status: "PENDING",
        acked_at: null,
      });
      assert.deepEqual(await service.ack(context, [ids.pending]), { acked: 1 });
      const committed = await service.ackStatus(context, ids.pending);
      assert.equal(committed.event_id, ids.pending);
      assert.equal(committed.status, "ACKED");
      assert.match(
        committed.acked_at,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      assert.deepEqual(await service.ack(context, [ids.pending]), { acked: 0 });
      assert.deepEqual(
        await service.ackStatus(context, ids.pending),
        committed,
      );
    });

    it("reports DEAD as non-ACKED truth and repeated ACK cannot change it", async () => {
      const context = {
        workspaceId: ids.workspaceA,
        userId: "program-c-consumer",
        roles: ["service"],
      };
      const dead = { event_id: ids.dead, status: "DEAD", acked_at: null };
      assert.deepEqual(await service.ackStatus(context, ids.dead), dead);
      assert.deepEqual(await service.ack(context, [ids.dead]), { acked: 0 });
      assert.deepEqual(await service.ackStatus(context, ids.dead), dead);
    });
  },
);
