import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { admitDisposablePostgresVerification } from "../src/lead-quality-labels/lead-quality-label.postgres-verifier";

const admission = admitDisposablePostgresVerification(
  process.argv.slice(2),
  process.env,
);
if (admission.status === "NOT_RUN") {
  console.log(JSON.stringify(admission));
  process.exit(0);
}

const containerName = `global-quality-label-verifier-${process.pid}-${randomUUID()}`;
const ownerPassword = randomBytes(24).toString("hex");
const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";
let containerCreated = false;

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync("docker", ["--host", LOCAL_DOCKER_HOST, ...args], {
    encoding: "utf8",
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error("disposable PostgreSQL docker operation failed");
  }
  return result.stdout.trim();
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function workspaceSql(
  client: PrismaClient,
  workspaceId: string,
  sql: string,
): Promise<number> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      workspaceId,
    );
    return tx.$executeRawUnsafe(sql);
  });
}

async function mustReject(
  operation: () => Promise<unknown>,
  description: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(
    `disposable PostgreSQL invariant did not reject: ${description}`,
  );
}

try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,nodev",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER=global",
    "--env",
    `POSTGRES_PASSWORD=${ownerPassword}`,
    "--env",
    "POSTGRES_DB=global_dev",
    admission.image,
  ]);
  containerCreated = true;

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = spawnSync(
      "docker",
      [
        "--host",
        LOCAL_DOCKER_HOST,
        "exec",
        containerName,
        "pg_isready",
        "-U",
        "global",
        "-d",
        "global_dev",
      ],
      { stdio: "ignore" },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    wait(250);
  }
  if (!ready) throw new Error("disposable PostgreSQL did not become ready");

  const portOutput = docker(["port", containerName, "5432/tcp"]);
  const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portOutput);
  if (!portMatch)
    throw new Error("disposable PostgreSQL loopback port was ambiguous");
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("disposable PostgreSQL loopback port was invalid");

  const encodedPassword = encodeURIComponent(ownerPassword);
  const ownerUrl = `postgresql://global:${encodedPassword}@127.0.0.1:${port}/global_dev`;
  const appUrl = `postgresql://app_user:app_pw@127.0.0.1:${port}/global_dev`;
  const migration = spawnSync(
    "pnpm",
    ["--filter", "@global/db", "exec", "prisma", "migrate", "deploy"],
    {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 4_194_304,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CI: "1",
        DATABASE_URL: ownerUrl,
      },
    },
  );
  if (migration.error || migration.status !== 0)
    throw new Error("migrations failed in disposable PostgreSQL");

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const appA = new PrismaClient({ datasourceUrl: appUrl });
  const appB = new PrismaClient({ datasourceUrl: appUrl });
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const leadId = "11111111-1111-4111-8111-111111111111";
  const validEventId = "22222222-2222-4222-8222-222222222222";
  const wrongTypeEventId = "33333333-3333-4333-8333-333333333333";
  const wrongAggregateEventId = "44444444-4444-4444-8444-444444444444";

  try {
    // Seed only the exact parents under session_replication_role=replica. This
    // is a disposable fixture shortcut; every invariant under test runs again
    // with normal trigger/FK/RLS semantics.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      );
      await tx.$executeRawUnsafe(`
        INSERT INTO "lead" ("id", "workspace_id", "icp_id", "canonical_company_id", "updated_at")
        VALUES ('${leadId}', '${workspaceId}', '55555555-5555-4555-8555-555555555555',
                '66666666-6666-4666-8666-666666666666', CURRENT_TIMESTAMP)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "outbox_event"
          ("event_id", "workspace_id", "event_type", "aggregate_type", "aggregate_id", "payload")
        VALUES
          ('${validEventId}', '${workspaceId}', 'LeadQualified', 'Lead', '${leadId}', '{}'::jsonb),
          ('${wrongTypeEventId}', '${workspaceId}', 'LeadsScored', 'Lead', '${leadId}', '{}'::jsonb),
          ('${wrongAggregateEventId}', '${workspaceId}', 'LeadQualified', 'Lead',
           '77777777-7777-4777-8777-777777777777', '{}'::jsonb)`);
    });

    // Prove the SECURITY DEFINER checks still work under FORCE RLS without a
    // superuser/BYPASSRLS owner. The functions must see only the workspace
    // selected from NEW/OLD and must restore the caller's prior GUC.
    await owner.$executeRawUnsafe(
      "CREATE ROLE quality_label_trigger_owner NOLOGIN NOSUPERUSER NOBYPASSRLS",
    );
    await owner.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO quality_label_trigger_owner",
    );
    await owner.$executeRawUnsafe(
      'GRANT SELECT ON "outbox_event", "lead_quality_label" TO quality_label_trigger_owner',
    );
    await owner.$executeRawUnsafe(
      'ALTER FUNCTION "enforce_lead_quality_label_handoff_identity"() OWNER TO quality_label_trigger_owner',
    );
    await owner.$executeRawUnsafe(
      'ALTER FUNCTION "protect_lead_quality_label_handoff_identity"() OWNER TO quality_label_trigger_owner',
    );

    const insert = (id: string, source: string, eventId = validEventId) => `
      INSERT INTO "lead_quality_label"
        ("id", "workspace_id", "source_event_id", "lead_id", "lead_qualified_event_id",
         "label", "occurred_at", "source_system", "disposition", "actor_id")
      VALUES ('${id}', '${workspaceId}', '${source}', '${leadId}', '${eventId}',
              'QGO_CREATED', CURRENT_TIMESTAMP, 'disposable-verifier', 'ACCEPTED', 'verifier')`;

    await workspaceSql(
      appA,
      workspaceId,
      insert("88888888-8888-4888-8888-888888888888", "valid-direct-insert"),
    );
    await mustReject(
      () =>
        workspaceSql(
          appA,
          workspaceId,
          insert(
            "99999999-9999-4999-8999-999999999999",
            "wrong-type",
            wrongTypeEventId,
          ),
        ),
      "wrong outbox event type",
    );
    await mustReject(
      () =>
        workspaceSql(
          appA,
          workspaceId,
          insert(
            "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            "wrong-aggregate",
            wrongAggregateEventId,
          ),
        ),
      "wrong outbox aggregate identity",
    );
    await mustReject(
      () =>
        workspaceSql(
          appA,
          otherWorkspaceId,
          insert("aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa", "cross-workspace"),
        ),
      "cross-workspace app_user insert",
    );
    await mustReject(
      () =>
        workspaceSql(
          appA,
          workspaceId,
          `UPDATE "lead_quality_label" SET "actor_id" = 'rewritten'
         WHERE "id" = '88888888-8888-4888-8888-888888888888'`,
        ),
      "append-only app_user update",
    );
    await mustReject(
      () =>
        owner.$executeRawUnsafe(
          `UPDATE "outbox_event" SET "aggregate_type" = 'Company'
         WHERE "event_id" = '${validEventId}'`,
        ),
      "referenced handoff identity mutation",
    );
    await mustReject(
      () =>
        owner.$executeRawUnsafe(
          `UPDATE "lead" SET "id" = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa'
         WHERE "id" = '${leadId}'`,
        ),
      "append-only FK update cascade",
    );

    const concurrentSource = "concurrent-source-event";
    const concurrent = await Promise.allSettled([
      workspaceSql(
        appA,
        workspaceId,
        insert("aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa", concurrentSource),
      ),
      workspaceSql(
        appB,
        workspaceId,
        insert("aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa", concurrentSource),
      ),
    ]);
    if (
      concurrent.filter((result) => result.status === "fulfilled").length !==
        1 ||
      concurrent.filter((result) => result.status === "rejected").length !== 1
    ) {
      throw new Error("concurrent source-event uniqueness invariant failed");
    }
    console.log(
      JSON.stringify({
        status: "PASSED_DISPOSABLE_POSTGRES",
        target: "ephemeral-loopback-container",
        existingDatabaseConnections: 0,
      }),
    );
  } finally {
    await Promise.allSettled([
      owner.$disconnect(),
      appA.$disconnect(),
      appB.$disconnect(),
    ]);
  }
} finally {
  if (containerCreated) docker(["rm", "--force", containerName], true);
}
