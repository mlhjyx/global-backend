import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, afterEach, beforeEach, describe, it } from "node:test";

// Self-owned, no-egress, no published ports/host volumes. Never accepts a DB URL.
const container = `codex-egress-reopen-pg-${randomUUID()}`;
const migrations = fileURLToPath(
  new URL("../prisma/migrations/", import.meta.url),
);
const migrationName = "20261101010000_platform_egress_fence_reopen";
const login = "reopen_test_writer";
const otherLogin = "reopen_test_other_superuser";
const issuer = "https://gain-saas.example";
const revision = "b".repeat(64);
const policyArtifact = "c".repeat(64);
const policyEnvelope = "d".repeat(64);
const quoteVectors = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
).vectors;
let created = false;
let database = "reopen_test";
const docker = (args, input) =>
  spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
const args = () => [
  "exec",
  "-i",
  container,
  "psql",
  "-U",
  "postgres",
  "-d",
  database,
  "-X",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
];
function sql(source, rejects) {
  const result = docker(args(), source);
  if (rejects) {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, rejects);
  } else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function asyncSql(source) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args());
    let out = "";
    let err = "";
    child.stdout.on("data", (value) => {
      out += value;
    });
    child.stderr.on("data", (value) => {
      err += value;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err)),
    );
    child.stdin.end(source);
  });
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const writer = (source) => `SET SESSION AUTHORIZATION ${login}; ${source}`;
const owner = (source) => `SET SESSION AUTHORIZATION global; ${source}`;

function installPolicy(
  schedule,
  expected = 0,
  artifact = policyArtifact,
  envelope = policyEnvelope,
  cap = "100",
) {
  return `SELECT * FROM install_platform_egress_policy_v2(${quote(schedule)},${expected}::bigint,${quote(artifact)},${quote(envelope)},${cap}::bigint);`;
}

function target(schedule = "acq-sweep", options = {}) {
  const vector = quoteVectors.find((row) => row.id === schedule);
  assert.ok(vector, `quote vector for ${schedule}`);
  const value = {
    jti: randomUUID(),
    run: randomUUID(),
    schedule,
    workflow: `test-${randomUUID()}`,
    request: vector.input.schedule_request_sha256,
    cap: options.cap ?? "100",
  };
  value.accountKey = `platform:${value.request}:${value.run}`;
  const admitted = JSON.parse(
    sql(
      writer(`SELECT row_to_json(r)::text FROM ingest_and_admit_platform_execution_budget_run_v2(
        ${quote(issuer)},'global-backend:execution-budget',${quote(value.jti)}::uuid,${quote(randomBytes(32).toString("hex"))},
        'execution-budget-grant/v1',${quote(vector.input.purpose)}::execution_budget_purpose,'schedule',${quote(schedule)},${quote(schedule)},
        ${quote(value.request)},${quote(value.workflow)},${quote(value.run)},${quote(revision)},'USD','microusd',
        ${value.cap}::bigint,${value.cap}::bigint,1::bigint,
        statement_timestamp()-interval '30 seconds',statement_timestamp()-interval '20 seconds',statement_timestamp()+interval '4 minutes',
        ${quote(vector.input.purpose)}::execution_budget_purpose,'schedule',${quote(schedule)},${quote(schedule)},
        ${quote(value.request)},${quote(value.workflow)},${quote(value.run)},${quote(revision)}) r;`),
    ),
  );
  value.id = admitted.authority_id;
  if (options.install !== false) {
    sql(
      owner(
        installPolicy(
          schedule,
          Number(
            sql(
              `SELECT generation FROM platform_egress_schedule_fence WHERE schedule_id=${quote(schedule)}`,
            ),
          ),
          policyArtifact,
          policyEnvelope,
          value.cap,
        ),
      ),
    );
  }
  return value;
}

function command(t, overrides = {}) {
  return {
    issuer,
    revocationJti: randomUUID(),
    digest: "a".repeat(64),
    targetIssuer: issuer,
    targetJti: t.jti,
    schedule: t.schedule,
    run: t.run,
    sequence: "1",
    reason: "POLICY_DISABLED",
    expiry: new Date(Date.now() + 240000).toISOString(),
    ...overrides,
  };
}
function apply(c) {
  return `SELECT row_to_json(r)::text FROM apply_platform_revocation_fence_v1(
    ${quote(c.issuer)},${quote(c.revocationJti)}::uuid,${quote(c.digest)},${quote(c.targetIssuer)},
    ${quote(c.targetJti)}::uuid,${quote(c.schedule)},${quote(c.run)},${quote(c.sequence)}::bigint,
    ${quote(c.reason)},${quote(c.expiry)}::timestamptz) r;`;
}
function revoke(t, overrides = {}) {
  const c = command(t, overrides);
  return { command: c, receipt: JSON.parse(sql(writer(apply(c)))) };
}

function fenceState(schedule = "acq-sweep") {
  return JSON.parse(
    sql(`SELECT row_to_json(f)::text FROM (
      SELECT state, generation::text AS generation, fence_sequence::text AS fence_sequence,
             policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd::text AS required_cap_microusd
      FROM platform_egress_schedule_fence WHERE schedule_id=${quote(schedule)}) f`),
  );
}
const currentGeneration = (schedule = "acq-sweep") =>
  sql(
    `SELECT generation FROM platform_egress_schedule_fence WHERE schedule_id=${quote(schedule)}`,
  );
const defaultReason = (revocationReason) =>
  ({
    POLICY_DISABLED: "POLICY_REENABLED",
    SECURITY_RESPONSE: "SECURITY_CLEARED",
    OPERATOR_HOLD: "HOLD_RELEASED",
  })[revocationReason];

function reopenArgs(c, overrides = {}) {
  const value = {
    schedule: c.schedule,
    expectedGeneration: currentGeneration(c.schedule),
    fenceSequence: c.sequence,
    revocationIssuer: c.issuer,
    revocationJti: c.revocationJti,
    reopenJti: randomUUID(),
    operator: "operator:test-ticket-1",
    reasonCode: defaultReason(c.reason),
    ...overrides,
  };
  const literal = (v) => (v === null ? "NULL" : quote(v));
  return {
    value,
    call: `SELECT row_to_json(r)::text FROM reopen_platform_egress_fence_v1(
      ${literal(value.schedule)},${value.expectedGeneration}::bigint,${value.fenceSequence}::bigint,
      ${literal(value.revocationIssuer)},${literal(value.revocationJti)}::uuid,${literal(value.reopenJti)}::uuid,
      ${literal(value.operator)},${literal(value.reasonCode)}) r;`,
  };
}
function reopen(c, overrides = {}) {
  const { value, call } = reopenArgs(c, overrides);
  return { args: value, result: JSON.parse(sql(owner(call))) };
}
const auditCount = () =>
  sql("SELECT count(*) FROM platform_egress_fence_reopen_receipt");
const auditRow = (jti) =>
  JSON.parse(
    sql(
      `SELECT row_to_json(r)::text FROM platform_egress_fence_reopen_receipt r WHERE reopen_jti=${quote(jti)}::uuid`,
    ),
  );

function insertAttempt(t, operation, generation, state) {
  sql(`INSERT INTO platform_egress_attempt(
      authority_id,schedule_id,workflow_id,workflow_run_id,operation_key,policy_revision,generation,state,sending_at)
    VALUES (${quote(t.id)}::uuid,${quote(t.schedule)},${quote(t.workflow)},${quote(t.run)},
      ${quote(operation)},${quote(revision)},${generation}::bigint,${quote(state)},
      ${state === "SENDING" ? "clock_timestamp()" : "NULL"});`);
}

describe("audited platform egress fence reopen on self-owned disposable PostgreSQL 16", () => {
  before(async () => {
    assert.equal(
      process.env.PLATFORM_EGRESS_FENCE_REOPEN_DISPOSABLE_TEST,
      "1",
      "explicit disposable test opt-in required",
    );
    const started = docker([
      "run",
      "--pull=never",
      "--rm",
      "-d",
      "--name",
      container,
      "--network=none",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_DB=reopen_test",
      "pgvector/pgvector:pg16",
    ]);
    assert.equal(started.status, 0, started.stderr);
    created = true;
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (
        docker([
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          "reopen_test",
        ]).status === 0
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "disposable PostgreSQL did not start");
    sql("CREATE ROLE global LOGIN SUPERUSER;");
    // Prisma creates this before applying migrations; raw SQL replay must too,
    // because 20261010090000 grants app_user SELECT on it and self-checks the
    // full relation privilege set.
    sql(`SET ROLE global; CREATE TABLE public._prisma_migrations (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0);`);
    const names = readdirSync(migrations)
      .filter(
        (name) =>
          name <= migrationName &&
          existsSync(`${migrations}/${name}/migration.sql`),
      )
      .sort();
    assert.ok(
      names.includes(migrationName),
      "reopen migration must be part of the applied set",
    );
    sql(
      "SET ROLE global;\n" +
        names
          .filter((name) => name !== migrationName)
          .map((name) => {
            const source = readFileSync(
              `${migrations}/${name}/migration.sql`,
              "utf8",
            );
            return /^BEGIN;/m.test(source)
              ? source
              : `BEGIN;\n${source}\nCOMMIT;`;
          })
          .join("\n"),
    );
    // Default EXECUTE for new functions must not leak the reopen capability.
    sql(
      "ALTER DEFAULT PRIVILEGES FOR ROLE global GRANT EXECUTE ON FUNCTIONS TO app_user, runtime_api, runtime_worker, runtime_outbox_relay;",
    );
    sql(
      `SET ROLE global;\n${readFileSync(`${migrations}/${migrationName}/migration.sql`, "utf8")}`,
    );
    sql(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT execution_budget_platform_writer TO ${login};
      CREATE ROLE ${otherLogin} LOGIN SUPERUSER;`);
  });
  after(() => {
    if (created) {
      const stopped = docker(["stop", container]);
      assert.equal(stopped.status, 0, stopped.stderr);
    }
  });
  beforeEach(() => {
    const name = `reopen_case_${randomUUID().replaceAll("-", "")}`;
    sql(`CREATE DATABASE ${name} TEMPLATE reopen_test`);
    database = name;
  });
  afterEach(() => {
    const previous = database;
    database = "reopen_test";
    if (previous !== database) {
      assert.match(previous, /^reopen_case_[0-9a-f]{32}$/);
      sql(`DROP DATABASE ${previous}`);
    }
  });

  it("reopens a revocation-disabled fence with exact generation, pairing and immutable audit facts", () => {
    const t = target();
    const revoked = revoke(t);
    assert.equal(revoked.receipt.generation, 2);
    insertAttempt(t, "wire-sending", 2, "SENDING");
    insertAttempt(t, "stale-authorized", 1, "AUTHORIZED");
    const { args, result } = reopen(revoked.command);
    assert.equal(result.replay, false);
    assert.equal(result.generation, 3);
    assert.equal(result.in_flight_attempts, 1);
    assert.equal(result.blocked_attempts, 1);
    assert.deepEqual(fenceState(), {
      state: "ACTIVE",
      generation: "3",
      fence_sequence: "1",
      policy_artifact_sha256: policyArtifact,
      execution_envelope_sha256: policyEnvelope,
      required_cap_microusd: "100",
    });
    const audit = auditRow(args.reopenJti);
    assert.equal(audit.reopen_receipt_id ?? audit.id, result.reopen_receipt_id);
    assert.equal(audit.operator, "operator:test-ticket-1");
    assert.equal(audit.db_principal, "global");
    assert.equal(audit.schedule_id, "acq-sweep");
    assert.equal(audit.fence_sequence, 1);
    assert.equal(audit.revocation_receipt_id, revoked.receipt.receipt_id);
    assert.equal(audit.revocation_issuer, issuer);
    assert.equal(audit.revocation_jti, revoked.command.revocationJti);
    assert.equal(audit.prior_generation, 2);
    assert.equal(audit.generation, 3);
    assert.equal(audit.reason_code, "POLICY_REENABLED");
    assert.equal(audit.policy_artifact_sha256, policyArtifact);
    assert.equal(audit.execution_envelope_sha256, policyEnvelope);
    assert.equal(audit.required_cap_microusd, 100);
    assert.equal(audit.in_flight_attempts, 1);
    assert.equal(audit.blocked_attempts, 1);
    assert.ok(Number.isFinite(Date.parse(audit.committed_at)));
    assert.equal(
      sql(
        `SELECT state FROM platform_egress_attempt WHERE schedule_id='acq-sweep' AND operation_key='wire-sending'`,
      ),
      "SENDING",
    );
    assert.equal(
      sql(`SELECT state || ':' || (outcome_meta->>'reason') FROM platform_egress_attempt
        WHERE schedule_id='acq-sweep' AND operation_key='stale-authorized'`),
      "BLOCKED:REOPEN_GENERATION_ADVANCED",
    );
    assert.deepEqual(
      JSON.parse(
        sql(
          writer(
            `SELECT row_to_json(r)::text FROM inspect_platform_egress_policy_v2('acq-sweep') r`,
          ),
        ),
      ),
      {
        schedule_id: "acq-sweep",
        state: "ACTIVE",
        generation: 3,
        fence_sequence: 1,
        policy_artifact_sha256: policyArtifact,
        execution_envelope_sha256: policyEnvelope,
        required_cap_microusd: 100,
      },
    );
  });

  it("replays the same command identity, survives a later re-disable, and rejects changed facts", () => {
    const t = target();
    const first = revoke(t);
    const { args: firstArgs, result: firstResult } = reopen(first.command);
    assert.equal(firstResult.replay, false);
    const replay = reopen(first.command, {
      reopenJti: firstArgs.reopenJti,
      operator: firstArgs.operator,
      expectedGeneration: "2",
    });
    assert.deepEqual(replay.result, { ...firstResult, replay: true });
    assert.equal(auditCount(), "1");

    // A newer signed revocation fences the schedule again; the old reopen
    // command still replays its own historical facts and touches nothing.
    const second = revoke(t, { sequence: "2", reason: "OPERATOR_HOLD" });
    assert.equal(second.receipt.generation, 4);
    const oldReplay = reopen(first.command, {
      reopenJti: firstArgs.reopenJti,
      operator: firstArgs.operator,
      expectedGeneration: "2",
    });
    assert.deepEqual(oldReplay.result, { ...firstResult, replay: true });
    assert.deepEqual(fenceState().state, "DISABLED");
    assert.equal(fenceState().generation, "4");
    assert.equal(fenceState().fence_sequence, "2");

    const fresh = reopen(second.command);
    assert.equal(fresh.result.replay, false);
    assert.equal(fresh.result.generation, 5);
    assert.equal(fenceState().state, "ACTIVE");

    for (const mutation of [
      { operator: "operator:other-ticket" },
      { schedule: "intent-sweep" },
      { fenceSequence: "9" },
      { expectedGeneration: "4" },
      { reasonCode: "HOLD_RELEASED" },
    ]) {
      sql(
        owner(
          reopenArgs(first.command, {
            reopenJti: firstArgs.reopenJti,
            ...mutation,
          }).call,
        ),
        /PLATFORM_EGRESS_REOPEN_(REUSED|INVALID)/,
      );
    }
    assert.equal(auditCount(), "2");
  });

  it("rejects unpaired, active, legacy and conflicting transitions without side effects", () => {
    const t = target();
    sql(
      owner(reopenArgs(command(t)).call),
      /PLATFORM_EGRESS_REOPEN_NOT_DISABLED/,
    );
    const revoked = revoke(t);
    assert.equal(fenceState().state, "DISABLED");
    const before = JSON.stringify(fenceState());

    for (const [overrides, code] of [
      [
        { revocationIssuer: "https://other.example" },
        /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE/,
      ],
      [
        { revocationJti: randomUUID() },
        /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE/,
      ],
      [{ fenceSequence: "9" }, /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE/],
      [
        { expectedGeneration: "3" },
        /PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT/,
      ],
      [
        { reasonCode: "HOLD_RELEASED" },
        /PLATFORM_EGRESS_REOPEN_REASON_MISMATCH/,
      ],
      [
        { schedule: "intent-sweep" },
        /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE|PLATFORM_EGRESS_REOPEN_NOT_DISABLED/,
      ],
    ]) {
      sql(owner(reopenArgs(revoked.command, overrides).call), code);
    }
    assert.equal(JSON.stringify(fenceState()), before);
    assert.equal(auditCount(), "0");

    // Legacy unsigned kill switch after the revocation advances generation
    // without moving fence_sequence: no receipt can pair with it.
    sql(
      writer(
        `SELECT * FROM fence_platform_schedule_v1('acq-sweep','OPERATOR_HOLD')`,
      ),
    );
    assert.equal(fenceState().generation, "3");
    assert.equal(fenceState().fence_sequence, "1");
    sql(
      owner(reopenArgs(revoked.command, { expectedGeneration: "3" }).call),
      /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE/,
    );
    assert.equal(fenceState().state, "DISABLED");
    assert.equal(auditCount(), "0");

    sql(
      owner(
        `UPDATE platform_egress_schedule_fence SET generation=9223372036854775807 WHERE schedule_id='acq-sweep'`,
      ),
    );
    sql(
      owner(
        reopenArgs(revoked.command, {
          expectedGeneration: "9223372036854775807",
        }).call,
      ),
      /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE|PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT/,
    );

    for (const mutation of [
      { schedule: null },
      { schedule: "unknown" },
      { expectedGeneration: "0" },
      { fenceSequence: "0" },
      { revocationIssuer: "https://x.example space" },
      { revocationIssuer: null },
      { revocationJti: "00000000-0000-0000-0000-000000000000" },
      { operator: "" },
      { operator: " padded" },
      { operator: "line\nbreak" },
      { reasonCode: "ARBITRARY" },
      { reasonCode: null },
    ]) {
      try {
        sql(
          owner(reopenArgs(revoked.command, mutation).call),
          /PLATFORM_EGRESS_REOPEN_INVALID/,
        );
      } catch (error) {
        error.message = `${JSON.stringify(mutation)}: ${error.message}`;
        throw error;
      }
    }
    assert.equal(auditCount(), "0");
  });

  it("allows reopen without a published policy while keeping egress closed, then installs on the new generation", () => {
    const t = target("intent-sweep", { install: false });
    const revoked = revoke(t);
    const { args, result } = reopen(revoked.command);
    assert.equal(result.generation, 2);
    const state = fenceState("intent-sweep");
    assert.equal(state.state, "ACTIVE");
    assert.equal(state.policy_artifact_sha256, null);
    assert.equal(state.execution_envelope_sha256, null);
    assert.equal(state.required_cap_microusd, null);
    const audit = auditRow(args.reopenJti);
    assert.equal(audit.policy_artifact_sha256, null);
    assert.equal(audit.execution_envelope_sha256, null);
    assert.equal(audit.required_cap_microusd, null);
    assert.equal(audit.generation, 2);
    // install_platform_egress_policy_v2 requires ACTIVE; reopen removed the deadlock.
    assert.equal(sql(owner(installPolicy("intent-sweep", 2))), "3|f");
    assert.equal(
      fenceState("intent-sweep").policy_artifact_sha256,
      policyArtifact,
    );
  });

  it("is owner-only: no runtime EXECUTE, no direct table access, immutable audit rows", () => {
    const signature =
      "public.reopen_platform_egress_fence_v1(text,bigint,bigint,text,uuid,uuid,text,text)";
    const facts = JSON.parse(
      sql(`SELECT json_build_object(
        'writer_execute',has_function_privilege(${quote(login)},${quote(signature)},'EXECUTE'),
        'app_execute',has_function_privilege('app_user',${quote(signature)},'EXECUTE'),
        'api_execute',has_function_privilege('runtime_api',${quote(signature)},'EXECUTE'),
        'worker_execute',has_function_privilege('runtime_worker',${quote(signature)},'EXECUTE'),
        'platform_execute',has_function_privilege('runtime_platform_worker',${quote(signature)},'EXECUTE'),
        'relay_execute',has_function_privilege('runtime_outbox_relay',${quote(signature)},'EXECUTE'),
        'public_execute',has_function_privilege('public',${quote(signature)},'EXECUTE'),
        'definer',(SELECT prosecdef FROM pg_proc WHERE oid=${quote(signature)}::regprocedure),
        'search_path',(SELECT proconfig FROM pg_proc WHERE oid=${quote(signature)}::regprocedure),
        'rls',(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
          WHERE oid='platform_egress_fence_reopen_receipt'::regclass))::text`),
    );
    assert.deepEqual(facts, {
      writer_execute: false,
      app_execute: false,
      api_execute: false,
      worker_execute: false,
      platform_execute: false,
      relay_execute: false,
      public_execute: false,
      definer: true,
      search_path: ["search_path=pg_catalog, public, pg_temp"],
      rls: true,
    });

    const t = target();
    const revoked = revoke(t);
    const { call } = reopenArgs(revoked.command);
    sql(
      `SET SESSION AUTHORIZATION ${login}; ${call}`,
      /permission denied for function/,
    );
    sql(
      `SET SESSION AUTHORIZATION app_user; ${call}`,
      /permission denied for function/,
    );
    // A superuser that is not the function owner passes ACL but fails the
    // owner principal assertion.
    sql(
      `SET SESSION AUTHORIZATION ${otherLogin}; ${call}`,
      /PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID/,
    );
    // Even a deliberately wrong ACL cannot be exploited through SET ROLE.
    sql(
      `BEGIN; GRANT EXECUTE ON FUNCTION ${signature} TO runtime_api; SET ROLE runtime_api; ${call} ROLLBACK;`,
      /PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID/,
    );

    for (const role of [
      login,
      "app_user",
      "runtime_api",
      "runtime_worker",
      "runtime_platform_worker",
      "runtime_outbox_relay",
    ]) {
      assert.equal(
        sql(`SELECT has_table_privilege(${quote(role)},'platform_egress_fence_reopen_receipt',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`),
        "f",
      );
      sql(
        `SET SESSION AUTHORIZATION ${role}; SELECT * FROM platform_egress_fence_reopen_receipt`,
        /permission denied/,
      );
    }
    reopen(revoked.command);
    sql(
      `UPDATE platform_egress_fence_reopen_receipt SET operator='other'`,
      /PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE/,
    );
    sql(
      `DELETE FROM platform_egress_fence_reopen_receipt`,
      /PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE/,
    );
    sql(
      "TRUNCATE platform_egress_fence_reopen_receipt",
      /PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE/,
    );
    assert.equal(auditCount(), "1");
  });

  it("serializes concurrent duplicate and conflicting reopen commands", async () => {
    const t = target();
    const revoked = revoke(t);
    const { value: shared } = reopenArgs(revoked.command);
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        asyncSql(
          owner(
            reopenArgs(revoked.command, { reopenJti: shared.reopenJti }).call,
          ),
        ),
      ),
    );
    const rows = outputs.map((value) => JSON.parse(value));
    assert.equal(new Set(rows.map((row) => row.reopen_receipt_id)).size, 1);
    assert.equal(rows.filter((row) => row.replay === false).length, 1);
    assert.equal(auditCount(), "1");

    const t2 = target("sanctions-refresh");
    const revoked2 = revoke(t2);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        asyncSql(owner(reopenArgs(revoked2.command).call)),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejection = results.find((result) => result.status === "rejected");
    assert.match(
      String(rejection.reason),
      /PLATFORM_EGRESS_REOPEN_(GENERATION_CONFLICT|NOT_DISABLED|UNPAIRED_FENCE)/,
    );
    assert.equal(fenceState("sanctions-refresh").state, "ACTIVE");
    assert.equal(auditCount(), "2");
  });

  it("rolls the whole transition back with its outer transaction", () => {
    const t = target();
    const revoked = revoke(t);
    const { call } = reopenArgs(revoked.command);
    sql(owner(`BEGIN; ${call} ROLLBACK;`));
    assert.equal(fenceState().state, "DISABLED");
    assert.equal(fenceState().generation, "2");
    assert.equal(auditCount(), "0");
    const committed = reopen(revoked.command);
    assert.equal(committed.result.replay, false);
    assert.equal(fenceState().state, "ACTIVE");
    assert.equal(auditCount(), "1");
  });

  it("requires the exact function owner even when the owner is not a superuser role", () => {
    const t = target();
    const revoked = revoke(t);
    const { call } = reopenArgs(revoked.command);
    // Database owner here is the superuser `global`; the migration-time self
    // check asserts that invariant when the migration runs.
    assert.equal(
      sql(`SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=(
        SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
        WHERE p.oid='public.reopen_platform_egress_fence_v1(text,bigint,bigint,text,uuid,uuid,text,text)'::regprocedure)`),
      "t",
    );
    sql(
      `SET SESSION AUTHORIZATION ${otherLogin}; ${call}`,
      /PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID/,
    );
  });
});
