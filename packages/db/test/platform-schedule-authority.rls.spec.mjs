import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const PLATFORM_LOGIN = "execution_budget_task4_platform_test";
const RUNTIME_LOGIN = "execution_budget_task4_runtime_test";
const PLATFORM_PASSWORD = randomBytes(24).toString("hex");
const RUNTIME_PASSWORD = randomBytes(24).toString("hex");
const ISSUER = "https://control.example.test";
const AUDIENCE = "global-backend:execution-budget";
const SCHEMA_VERSION = "execution-budget-grant/v1";
const SCHEDULE_ID = "acq-sweep";
const PURPOSE = "platform.acquisition";
const SCHEDULE_REQUEST_SHA256 =
  "5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e";
const TECHNICAL_POLICY_REVISION = "d".repeat(64);

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function roleUrl(login, password) {
  const value = new URL(requireUrl("DATABASE_URL", OWNER_URL));
  value.username = login;
  value.password = password;
  return value.toString();
}

function grantInput(overrides = {}) {
  const now = Date.now();
  const workflowRunId = overrides.workflowRunId ?? randomUUID();
  const scheduleId = overrides.scheduleId ?? SCHEDULE_ID;
  const scheduleRequestSha256 =
    overrides.scheduleRequestSha256 ?? SCHEDULE_REQUEST_SHA256;
  return {
    issuer: overrides.issuer ?? ISSUER,
    audience: overrides.audience ?? AUDIENCE,
    jti: overrides.jti ?? randomUUID(),
    tokenSha256: overrides.tokenSha256 ?? randomBytes(32).toString("hex"),
    schemaVersion: overrides.schemaVersion ?? SCHEMA_VERSION,
    purpose: overrides.purpose ?? PURPOSE,
    subjectType: overrides.subjectType ?? "schedule",
    subjectId: overrides.subjectId ?? scheduleId,
    scheduleId,
    scheduleRequestSha256,
    workflowId:
      overrides.workflowId ?? `platform-acquisition-${scheduleId}-20260905`,
    workflowRunId,
    technicalPolicyRevision:
      overrides.technicalPolicyRevision ?? TECHNICAL_POLICY_REVISION,
    currency: overrides.currency ?? "USD",
    unit: overrides.unit ?? "microusd",
    capPerRunMicrousd: overrides.capPerRunMicrousd ?? 1_000_000n,
    campaignCapMicrousd: overrides.campaignCapMicrousd ?? 1_000_000n,
    maxRuns: overrides.maxRuns ?? 1n,
    issuedAt: overrides.issuedAt ?? new Date(now - 30_000),
    notBefore: overrides.notBefore ?? new Date(now - 20_000),
    expiresAt: overrides.expiresAt ?? new Date(now + 240_000),
  };
}

function expectedInput(grant, overrides = {}) {
  return {
    purpose: overrides.purpose ?? grant.purpose,
    subjectType: overrides.subjectType ?? grant.subjectType,
    subjectId: overrides.subjectId ?? grant.subjectId,
    scheduleId: overrides.scheduleId ?? grant.scheduleId,
    scheduleRequestSha256:
      overrides.scheduleRequestSha256 ?? grant.scheduleRequestSha256,
    workflowId: overrides.workflowId ?? grant.workflowId,
    workflowRunId: overrides.workflowRunId ?? grant.workflowRunId,
    technicalPolicyRevision:
      overrides.technicalPolicyRevision ?? grant.technicalPolicyRevision,
  };
}

async function ingestAndAdmit(
  database,
  grant,
  expected = expectedInput(grant),
) {
  return database.$queryRawUnsafe(
    `SELECT * FROM ingest_and_admit_platform_execution_budget_run_v2(
      $1,$2,$3::uuid,$4,$5,$6::execution_budget_purpose,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16::bigint,$17::bigint,$18::bigint,
      $19::timestamptz,$20::timestamptz,$21::timestamptz,
      $22::execution_budget_purpose,$23,$24,$25,$26,$27,$28,$29
    )`,
    grant.issuer,
    grant.audience,
    grant.jti,
    grant.tokenSha256,
    grant.schemaVersion,
    grant.purpose,
    grant.subjectType,
    grant.subjectId,
    grant.scheduleId,
    grant.scheduleRequestSha256,
    grant.workflowId,
    grant.workflowRunId,
    grant.technicalPolicyRevision,
    grant.currency,
    grant.unit,
    grant.capPerRunMicrousd,
    grant.campaignCapMicrousd,
    grant.maxRuns,
    grant.issuedAt,
    grant.notBefore,
    grant.expiresAt,
    expected.purpose,
    expected.subjectType,
    expected.subjectId,
    expected.scheduleId,
    expected.scheduleRequestSha256,
    expected.workflowId,
    expected.workflowRunId,
    expected.technicalPolicyRevision,
  );
}

async function rejectWith(operation, marker) {
  await assert.rejects(operation, (error) => {
    assert.match(String(error?.message), new RegExp(marker));
    return true;
  });
}

describe("platform run-bound authority PostgreSQL admission", () => {
  let owner;
  let app;
  let platform;
  let runtime;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    await owner.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_LOGIN}') THEN
          REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN};
          DROP ROLE ${PLATFORM_LOGIN};
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_LOGIN}') THEN
          REVOKE runtime_worker FROM ${RUNTIME_LOGIN};
          DROP ROLE ${RUNTIME_LOGIN};
        END IF;
        CREATE ROLE ${PLATFORM_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${PLATFORM_PASSWORD}';
        GRANT execution_budget_platform_writer TO ${PLATFORM_LOGIN};
        CREATE ROLE ${RUNTIME_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${RUNTIME_PASSWORD}';
        GRANT runtime_worker TO ${RUNTIME_LOGIN};
      END
      $role$
    `);
    app = client(requireUrl("APP_DATABASE_URL", APP_URL));
    platform = client(roleUrl(PLATFORM_LOGIN, PLATFORM_PASSWORD));
    runtime = client(roleUrl(RUNTIME_LOGIN, RUNTIME_PASSWORD));
  });

  after(async () => {
    await Promise.allSettled([
      app?.$disconnect(),
      platform?.$disconnect(),
      runtime?.$disconnect(),
    ]);
    if (owner) {
      await owner.$executeRawUnsafe(
        `REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN}`,
      );
      await owner.$executeRawUnsafe(
        `REVOKE runtime_worker FROM ${RUNTIME_LOGIN}`,
      );
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PLATFORM_LOGIN}`);
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("atomically persists one bound authority/account and read-only recovers an ACK-loss retry", async () => {
    const grant = grantInput();

    const [first] = await ingestAndAdmit(platform, grant);
    const [retry] = await ingestAndAdmit(platform, grant);
    await rejectWith(
      () =>
        ingestAndAdmit(
          platform,
          grant,
          expectedInput(grant, { workflowRunId: randomUUID() }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );

    assert.equal(first.replay, false);
    assert.equal(retry.replay, true);
    assert.equal(retry.authority_id, first.authority_id);
    assert.equal(retry.account_id, first.account_id);
    assert.equal(retry.generation, first.generation);
    assert.equal(retry.authorized_cap_microusd, 1_000_000n);

    const [authority] = await owner.$queryRawUnsafe(
      `SELECT runs_consumed, consumed_at, schedule_request_sha256,
              workflow_id, workflow_run_id, technical_policy_revision
         FROM execution_budget_authority WHERE id=$1::uuid`,
      first.authority_id,
    );
    const [account] = await owner.$queryRawUnsafe(
      `SELECT ref_count, authority_id, authorized_cap_microusd
         FROM tool_budget_account WHERE id=$1::uuid`,
      first.account_id,
    );
    assert.equal(authority.runs_consumed, 1n);
    assert.ok(authority.consumed_at instanceof Date);
    assert.equal(
      authority.schedule_request_sha256,
      grant.scheduleRequestSha256,
    );
    assert.equal(authority.workflow_id, grant.workflowId);
    assert.equal(authority.workflow_run_id, grant.workflowRunId);
    assert.equal(
      authority.technical_policy_revision,
      grant.technicalPolicyRevision,
    );
    assert.deepEqual(account, {
      ref_count: 1,
      authority_id: first.authority_id,
      authorized_cap_microusd: 1_000_000n,
    });
  });

  it("rejects every independent runtime substitution before creating authority or account state", async () => {
    const cases = [
      ["purpose", { purpose: "platform.intent_watch" }],
      ["schedule", { scheduleId: "intent-sweep", subjectId: "intent-sweep" }],
      ["request", { scheduleRequestSha256: "e".repeat(64) }],
      ["workflow", { workflowId: "another-workflow" }],
      ["run", { workflowRunId: randomUUID() }],
      ["policy", { technicalPolicyRevision: "f".repeat(64) }],
    ];

    for (const [name, override] of cases) {
      const grant = grantInput();
      await rejectWith(
        () => ingestAndAdmit(platform, grant, expectedInput(grant, override)),
        "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
      );
      const [{ authorities, accounts }] = await owner.$queryRawUnsafe(
        `SELECT
           count(*) FILTER (WHERE jti=$1::uuid)::int AS authorities,
           count(account.id)::int AS accounts
         FROM execution_budget_authority authority
         LEFT JOIN tool_budget_account account ON account.authority_id=authority.id
         WHERE authority.jti=$1::uuid`,
        grant.jti,
      );
      assert.deepEqual(
        { name, authorities, accounts },
        {
          name,
          authorities: 0,
          accounts: 0,
        },
      );
    }
  });

  it("classifies altered signed claims under the same JTI as conflict and rolls back a replacement JTI for the same run", async () => {
    const original = grantInput();
    const [first] = await ingestAndAdmit(platform, original);

    for (const alteredClaim of [
      { scheduleRequestSha256: "e".repeat(64) },
      { workflowId: "altered-workflow" },
      { workflowRunId: randomUUID() },
      { technicalPolicyRevision: "f".repeat(64) },
    ]) {
      await rejectWith(
        () => ingestAndAdmit(platform, { ...original, ...alteredClaim }),
        "EXECUTION_BUDGET_GRANT_REUSED",
      );
    }

    const replacement = {
      ...original,
      jti: randomUUID(),
      tokenSha256: randomBytes(32).toString("hex"),
    };
    await rejectWith(
      () => ingestAndAdmit(platform, replacement),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );

    const crossScheduleReplacement = grantInput({
      jti: randomUUID(),
      tokenSha256: randomBytes(32).toString("hex"),
      purpose: "platform.intent_watch",
      subjectId: "intent-sweep",
      scheduleId: "intent-sweep",
      scheduleRequestSha256:
        "9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a",
      workflowId: `platform-intent-${randomUUID()}`,
      workflowRunId: original.workflowRunId,
    });
    await rejectWith(
      () => ingestAndAdmit(platform, crossScheduleReplacement),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );

    const [{ authorities, accounts, consumed }] = await owner.$queryRawUnsafe(
      `SELECT count(DISTINCT authority.id)::int AS authorities,
              count(DISTINCT account.id)::int AS accounts,
              max(authority.runs_consumed) AS consumed
         FROM execution_budget_authority authority
         LEFT JOIN tool_budget_account account ON account.authority_id=authority.id
        WHERE authority.workflow_run_id=$1`,
      original.workflowRunId,
    );
    assert.deepEqual(
      { authorities, accounts, consumed },
      {
        authorities: 1,
        accounts: 1,
        consumed: 1n,
      },
    );
    assert.equal(first.replay, false);
  });

  it("linearizes 20 concurrent exact deliveries into one consumption and nineteen replays", async () => {
    const grant = grantInput();
    const raceClients = Array.from({ length: 20 }, () =>
      client(roleUrl(PLATFORM_LOGIN, PLATFORM_PASSWORD)),
    );
    try {
      const rows = await Promise.all(
        raceClients.map(
          async (database) => (await ingestAndAdmit(database, grant))[0],
        ),
      );
      assert.equal(rows.filter((row) => row.replay === false).length, 1);
      assert.equal(rows.filter((row) => row.replay === true).length, 19);
      assert.equal(new Set(rows.map((row) => row.authority_id)).size, 1);
      assert.equal(new Set(rows.map((row) => row.account_id)).size, 1);

      const [authority] = await owner.$queryRawUnsafe(
        `SELECT runs_consumed FROM execution_budget_authority WHERE jti=$1::uuid`,
        grant.jti,
      );
      const [account] = await owner.$queryRawUnsafe(
        `SELECT ref_count FROM tool_budget_account
          WHERE account_key=$1 AND scope_key='platform'`,
        `platform:${grant.scheduleRequestSha256}:${grant.workflowRunId}`,
      );
      assert.equal(authority.runs_consumed, 1n);
      assert.equal(account.ref_count, 1);
    } finally {
      await Promise.allSettled(
        raceClients.map((database) => database.$disconnect()),
      );
    }
  });

  it("rejects multi-run and unequal-cap grants with zero durable writes", async () => {
    for (const grant of [
      grantInput({ maxRuns: 2n }),
      grantInput({ campaignCapMicrousd: 2_000_000n }),
    ]) {
      await rejectWith(
        () => ingestAndAdmit(platform, grant),
        "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
      );
      const [{ count }] = await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM execution_budget_authority
          WHERE jti=$1::uuid`,
        grant.jti,
      );
      assert.equal(count, 0);
    }
  });

  it("keeps historical unbound rows nullable while denying every legacy writer entry point", async () => {
    const historicalJti = randomUUID();
    const now = Date.now();
    const [historical] = await owner.$queryRawUnsafe(
      `INSERT INTO execution_budget_authority(
         scope_key,authority_kind,issuer,audience,jti,token_sha256,
         schema_version,purpose,subject_type,subject_id,schedule_id,currency,
         unit,cap_per_run_microusd,campaign_cap_microusd,max_runs,issued_at,
         not_before,expires_at
       ) VALUES (
         'platform','PLATFORM_GRANT',$1,$2,$3::uuid,$4,$5,
         'platform.acquisition','schedule','historical-schedule',
         'historical-schedule','USD','microusd',1,10,10,$6,$7,$8
       ) RETURNING id,schedule_request_sha256,workflow_id,workflow_run_id,
                   technical_policy_revision`,
      ISSUER,
      AUDIENCE,
      historicalJti,
      randomBytes(32).toString("hex"),
      SCHEMA_VERSION,
      new Date(now - 120_000),
      new Date(now - 119_000),
      new Date(now - 60_000),
    );
    assert.equal(historical.schedule_request_sha256, null);
    assert.equal(historical.workflow_id, null);
    assert.equal(historical.workflow_run_id, null);
    assert.equal(historical.technical_policy_revision, null);

    const oldIngest = `SELECT * FROM ingest_platform_execution_authority(
      $1,$2,$3::uuid,$4,$5,'platform.acquisition'::execution_budget_purpose,
      'schedule','acq-sweep','acq-sweep','USD','microusd',1,1,1,$6,$7,$8
    )`;
    await rejectWith(
      () =>
        platform.$queryRawUnsafe(
          oldIngest,
          ISSUER,
          AUDIENCE,
          randomUUID(),
          randomBytes(32).toString("hex"),
          SCHEMA_VERSION,
          new Date(now - 30_000),
          new Date(now - 20_000),
          new Date(now + 240_000),
        ),
      "permission denied",
    );
    const legacyRun = randomUUID();
    await rejectWith(
      () =>
        platform.$queryRawUnsafe(
          `SELECT * FROM admit_platform_execution_budget_run_v1(
          'platform.acquisition','schedule','acq-sweep','acq-sweep',$1,$2,$3
        )`,
          SCHEDULE_REQUEST_SHA256,
          legacyRun,
          `platform:${SCHEDULE_REQUEST_SHA256}:${legacyRun}`,
        ),
      "permission denied",
    );
    await rejectWith(
      () =>
        platform.$queryRawUnsafe(
          `SELECT * FROM open_authorized_tool_budget_v1(
          'platform',$1::uuid,'platform:legacy-bypass',false
        )`,
          historical.id,
        ),
      "permission denied",
    );
    await rejectWith(
      () =>
        platform.$queryRawUnsafe(
          `SELECT * FROM open_tool_budget(
          'platform',$1::uuid,'platform:legacy-wrapper-bypass',false
        )`,
          historical.id,
        ),
      "permission denied",
    );
  });

  it("keeps FORCE RLS and permits only the exact dedicated writer principal", async () => {
    const grant = grantInput();
    await ingestAndAdmit(platform, grant);

    const rls = await owner.$queryRawUnsafe(`
      SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname='execution_budget_authority'
    `);
    assert.deepEqual(rls, [
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);

    await rejectWith(
      () => ingestAndAdmit(owner, grantInput()),
      "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
    );
    await rejectWith(
      () => ingestAndAdmit(app, grantInput()),
      "permission denied",
    );
    await rejectWith(
      () => ingestAndAdmit(runtime, grantInput()),
      "permission denied",
    );

    const signature =
      "ingest_and_admit_platform_execution_budget_run_v2(text,text,uuid,text,text,execution_budget_purpose,text,text,text,text,text,text,text,text,text,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,execution_budget_purpose,text,text,text,text,text,text,text)";
    const [privileges] = await owner.$queryRawUnsafe(
      `SELECT
        has_function_privilege('execution_budget_platform_writer',$1,'EXECUTE') AS platform_writer,
        has_function_privilege('app_user',$1,'EXECUTE') AS app_user,
        has_function_privilege('runtime_worker',$1,'EXECUTE') AS runtime_worker`,
      signature,
    );
    assert.deepEqual(privileges, {
      platform_writer: true,
      app_user: false,
      runtime_worker: false,
    });
  });
});
