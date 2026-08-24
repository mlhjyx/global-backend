import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const PLATFORM_LOGIN = "execution_budget_task3_test";
const PLATFORM_PASSWORD = randomBytes(24).toString("hex");
const REQUEST_HASHES = Object.freeze({
  "acq-sweep":
    "5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e",
  "intent-sweep":
    "9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a",
  "sanctions-refresh":
    "50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe",
  "patents-cache-refresh":
    "3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6",
});

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function platformUrl() {
  const value = new URL(requireUrl("DATABASE_URL", OWNER_URL));
  value.username = PLATFORM_LOGIN;
  value.password = PLATFORM_PASSWORD;
  return value.toString();
}

async function ingest(platform, input) {
  const now = Date.now();
  const [row] = await platform.$queryRawUnsafe(
    `SELECT * FROM ingest_platform_execution_authority(
      $1,$2,$3::uuid,$4,$5,$6::execution_budget_purpose,
      'schedule',$7,$7,'USD','microusd',$8::bigint,$9::bigint,$10::bigint,
      $11::timestamptz,$12::timestamptz,$13::timestamptz
    )`,
    "https://control.example.test",
    "global-backend:execution-budget",
    randomUUID(),
    randomBytes(32).toString("hex"),
    "execution-budget-grant/v1",
    input.purpose,
    input.scheduleId,
    input.capPerRun ?? 1_000_000n,
    input.campaignCap ?? 10_000_000n,
    input.maxRuns ?? 10n,
    new Date(now - 30_000),
    new Date(now - 20_000),
    new Date(now + 240_000),
  );
  return row.authority_id;
}

async function admit(platform, input) {
  return platform.$queryRawUnsafe(
    `SELECT * FROM admit_platform_execution_budget_run_v1(
      $1::execution_budget_purpose,'schedule',$2,$2,$3,$4,$5
    )`,
    input.purpose,
    input.scheduleId,
    input.requestSha256,
    input.workflowRunId,
    `platform:${input.requestSha256}:${input.workflowRunId}`,
  );
}

describe("platform schedule authority PostgreSQL admission", () => {
  let owner;
  let app;
  let platform;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    await owner.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_LOGIN}') THEN
          REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN};
          DROP ROLE ${PLATFORM_LOGIN};
        END IF;
        CREATE ROLE ${PLATFORM_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${PLATFORM_PASSWORD}';
        GRANT execution_budget_platform_writer TO ${PLATFORM_LOGIN};
      END
      $role$
    `);
    app = client(requireUrl("APP_DATABASE_URL", APP_URL));
    platform = client(platformUrl());
  });

  after(async () => {
    await Promise.allSettled([app?.$disconnect(), platform?.$disconnect()]);
    if (owner) {
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PLATFORM_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("consumes one slot per workflow run and read-only reattests an ACK-loss retry", async () => {
    const scheduleId = "acq-sweep";
    const authorityId = await ingest(platform, {
      purpose: "platform.acquisition",
      scheduleId,
    });
    const requestSha256 = REQUEST_HASHES[scheduleId];
    const firstInput = {
      purpose: "platform.acquisition",
      scheduleId,
      requestSha256,
      workflowRunId: "workflow-run-1",
    };
    const [first] = await admit(platform, firstInput);
    const [retry] = await admit(platform, firstInput);
    const [second] = await admit(platform, {
      ...firstInput,
      workflowRunId: "workflow-run-2",
    });

    assert.equal(first.replay, false);
    assert.equal(retry.replay, true);
    assert.equal(retry.account_id, first.account_id);
    assert.equal(second.replay, false);
    assert.notEqual(second.account_id, first.account_id);
    assert.equal(first.authority_id, authorityId);
    assert.equal(first.campaign_cap_microusd, 10_000_000n);
    assert.equal(first.max_runs, 10n);

    const [authority] = await owner.$queryRawUnsafe(
      `SELECT runs_consumed FROM execution_budget_authority WHERE id=$1::uuid`,
      authorityId,
    );
    const accounts = await owner.$queryRawUnsafe(
      `SELECT ref_count FROM tool_budget_account
       WHERE authority_id=$1::uuid ORDER BY account_key`,
      authorityId,
    );
    assert.equal(authority.runs_consumed, 2n);
    assert.deepEqual(
      accounts.map((row) => row.ref_count),
      [1, 1],
    );
  });

  it("rejects missing, revoked, exhausted and request/account drift without an extra account", async () => {
    const requestSha256 = REQUEST_HASHES["patents-cache-refresh"];
    await assert.rejects(
      admit(platform, {
        purpose: "platform.acquisition",
        scheduleId: "patents-cache-refresh",
        requestSha256,
        workflowRunId: "missing-run",
      }),
      /EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE/,
    );
    await assert.rejects(
      admit(platform, {
        purpose: "platform.acquisition",
        scheduleId: "acq-sweep",
        requestSha256: "a".repeat(64),
        workflowRunId: "request-drift",
      }),
      /EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/,
    );

    const revokedSchedule = "sanctions-refresh";
    const revokedId = await ingest(platform, {
      purpose: "platform.sanctions",
      scheduleId: revokedSchedule,
    });
    await platform.$queryRawUnsafe(
      `SELECT * FROM revoke_platform_execution_authority_v1(
        $1::uuid,'task3-test',statement_timestamp()
      )`,
      revokedId,
    );
    await assert.rejects(
      admit(platform, {
        purpose: "platform.sanctions",
        scheduleId: revokedSchedule,
        requestSha256: REQUEST_HASHES[revokedSchedule],
        workflowRunId: "revoked-run",
      }),
      /EXECUTION_BUDGET_AUTHORITY_REVOKED/,
    );

    const expiredSchedule = "patents-cache-refresh";
    const expiredId = await ingest(platform, {
      purpose: "platform.acquisition",
      scheduleId: expiredSchedule,
    });
    const expiredAt = Date.now();
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
       SET issued_at=$2::timestamptz,not_before=$3::timestamptz,
           expires_at=$4::timestamptz
       WHERE id=$1::uuid`,
      expiredId,
      new Date(expiredAt - 300_000),
      new Date(expiredAt - 299_000),
      new Date(expiredAt - 61_000),
    );
    await assert.rejects(
      admit(platform, {
        purpose: "platform.acquisition",
        scheduleId: expiredSchedule,
        requestSha256: REQUEST_HASHES[expiredSchedule],
        workflowRunId: "expired-run",
      }),
      /EXECUTION_BUDGET_GRANT_EXPIRED/,
    );

    const exhaustedSchedule = "intent-sweep";
    const exhaustedId = await ingest(platform, {
      purpose: "platform.intent_watch",
      scheduleId: exhaustedSchedule,
      maxRuns: 1n,
      campaignCap: 1_000_000n,
    });
    await admit(platform, {
      purpose: "platform.intent_watch",
      scheduleId: exhaustedSchedule,
      requestSha256: REQUEST_HASHES[exhaustedSchedule],
      workflowRunId: "first-run",
    });
    await assert.rejects(
      admit(platform, {
        purpose: "platform.intent_watch",
        scheduleId: exhaustedSchedule,
        requestSha256: REQUEST_HASHES[exhaustedSchedule],
        workflowRunId: "second-run",
      }),
      /EXECUTION_BUDGET_AUTHORITY_EXHAUSTED/,
    );

    await assert.rejects(
      platform.$queryRawUnsafe(
        `SELECT * FROM admit_platform_execution_budget_run_v1(
          'platform.intent_watch'::execution_budget_purpose,'schedule',$1,$1,
          $2,'drift-run','platform:wrong:drift-run'
        )`,
        exhaustedSchedule,
        REQUEST_HASHES[exhaustedSchedule],
      ),
      /EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/,
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM tool_budget_account
       WHERE authority_id IN ($1::uuid,$2::uuid,$3::uuid)`,
      revokedId,
      expiredId,
      exhaustedId,
    );
    assert.equal(count, 1);
  });

  it("has no app-user or owner fallback for schedule admission", async () => {
    const args = [
      "platform.acquisition",
      `forbidden-${randomUUID()}`,
      randomBytes(32).toString("hex"),
      "forbidden-run",
    ];
    const sql = `SELECT * FROM admit_platform_execution_budget_run_v1(
      $1::execution_budget_purpose,'schedule',$2,$2,$3,$4,
      'platform:' || $3 || ':' || $4
    )`;
    await assert.rejects(
      app.$queryRawUnsafe(sql, ...args),
      /permission denied/,
    );
    await assert.rejects(
      owner.$queryRawUnsafe(sql, ...args),
      /EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID/,
    );
  });
});
