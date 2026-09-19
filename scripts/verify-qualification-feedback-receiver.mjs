import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  chmodSync,
  rmdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately disposable, offline PG16 verification. Company/Lead parents are minimal;
// this replays the receiver migration exactly, not the complete migration history.
const root = fileURLToPath(new URL("..", import.meta.url));
const marker = `qfeedback_${randomBytes(10).toString("hex")}`;
const name = `qualification-feedback-${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const image =
  "postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94";
const label = `global.qualification-feedback-verification=${marker}`;
const docker = (args, input) => {
  const result = spawnSync("docker", ["--context", "default", ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, POSTGRES_PASSWORD: password },
  });
  if (result.status !== 0)
    throw new Error(
      `Disposable Docker operation failed: ${args[0]}: ${(result.stderr ?? "").replaceAll(password, "[REDACTED]")}`,
    );
  return result.stdout.trim();
};
const socketDirectory = mkdtempSync(join(tmpdir(), "qfeedback-pg-"));
chmodSync(socketDirectory, 0o1777);
let containerCreated = false;
try {
  docker(["image", "inspect", image]);
  docker([
    "run",
    "-d",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    label,
    "--network",
    "none",
    "--mount",
    `type=bind,source=${socketDirectory},target=/socket`,
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    `POSTGRES_DB=${marker}`,
    image,
    "-c",
    "unix_socket_directories=/socket,/var/run/postgresql",
    "-c",
    "unix_socket_permissions=0700",
    "-c",
    "listen_addresses=",
  ]);
  containerCreated = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync(
      "docker",
      [
        "--context",
        "default",
        "exec",
        name,
        "pg_isready",
        "-h",
        "/socket",
        "-U",
        "postgres",
        "-d",
        marker,
      ],
      { stdio: "ignore" },
    );
    if (
      probe.status === 0 &&
      docker(["logs", name]).includes(
        "PostgreSQL init process complete; ready for start up.",
      )
    ) {
      ready = true;
      break;
    }
    if (docker(["inspect", "--format", "{{.State.Running}}", name]) !== "true")
      throw new Error("Disposable PostgreSQL exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  const migration = readFileSync(
    new URL(
      "../packages/db/prisma/migrations/20260919160000_qualification_feedback_receipt/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  docker(
    [
      "exec",
      "-i",
      name,
      "psql",
      "-h",
      "/socket",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      marker,
    ],
    `
    DO $$ BEGIN IF current_database() <> '${marker}' THEN RAISE EXCEPTION 'wrong disposable database'; END IF; END $$;
    CREATE TABLE disposable_verification_marker (marker text PRIMARY KEY);
    INSERT INTO disposable_verification_marker VALUES ('${marker}');
    CREATE ROLE app_user LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
    GRANT SELECT ON disposable_verification_marker TO app_user;
    CREATE FUNCTION current_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_workspace_id', true),'')::uuid $$;
    CREATE TABLE canonical_company (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, status text NOT NULL);
    ALTER TABLE canonical_company ENABLE ROW LEVEL SECURITY;
    ALTER TABLE canonical_company FORCE ROW LEVEL SECURITY;
    CREATE POLICY company_tenant ON canonical_company USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
    GRANT SELECT,INSERT,UPDATE,DELETE ON canonical_company TO app_user;
    CREATE TABLE lead (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, canonical_company_id uuid REFERENCES canonical_company(id) ON DELETE CASCADE, status text NOT NULL, queue text NOT NULL, version integer NOT NULL DEFAULT 1);
    ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
    ALTER TABLE lead FORCE ROW LEVEL SECURITY;
    CREATE POLICY lead_tenant ON lead USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
    GRANT SELECT,INSERT,UPDATE,DELETE ON lead TO app_user;
    ${migration}
  `,
  );
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/api",
      "exec",
      "vitest",
      "run",
      "src/qualification-feedback/qualification-feedback.postgres.spec.ts",
      "--maxWorkers=1",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        QUALIFICATION_FEEDBACK_PG_TEST: "1",
        QUALIFICATION_FEEDBACK_PG_MARKER: marker,
        APP_DATABASE_URL: `postgresql://app_user:${password}@localhost/${marker}?host=${encodeURIComponent(socketDirectory)}&connection_limit=12`,
        QUALIFICATION_FEEDBACK_OWNER_URL: `postgresql://postgres:${password}@localhost/${marker}?host=${encodeURIComponent(socketDirectory)}`,
      },
    },
  );
  const sanitize = (value) =>
    (value ?? "")
      .replaceAll(password, "[REDACTED]")
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[DATABASE_URL_REDACTED]");
  process.stdout.write(sanitize(result.stdout));
  process.stderr.write(sanitize(result.stderr));
  if (result.status !== 0)
    throw new Error("Receiver PostgreSQL verification failed");
  console.log(
    "PASS: disposable PostgreSQL16; exact receiver migration; minimal Company/Lead parents (not full migration parity).",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Disposable verification failed",
  );
  process.exitCode = 1;
} finally {
  // Exact random name plus matching label are required before cleanup.
  if (
    containerCreated &&
    docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "global.qualification-feedback-verification"}}',
      name,
    ]) === marker
  ) {
    docker(["stop", "--time", "5", name]);
    docker(["rm", "-v", name]);
  }
  for (const socketFile of [".s.PGSQL.5432", ".s.PGSQL.5432.lock"]) {
    const path = join(socketDirectory, socketFile);
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(socketDirectory);
}
