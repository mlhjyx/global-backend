import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.DATABASE_URL;
const WORKER_LOGIN = "site_build_wire_worker_test";
const API_LOGIN = "site_build_wire_api_test";
const WORKER_PASSWORD = randomBytes(24).toString("hex");
const API_PASSWORD = randomBytes(24).toString("hex");
const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();
const SITE_ID = randomUUID();
const BUILD_RUN_ID = randomUUID();
const TASK_ATTEMPT_ID = randomUUID();
const FENCE_TOKEN = randomUUID();
const OPERATION_KEY = randomBytes(32).toString("hex");
const REQUEST_ID_1 = randomBytes(32).toString("base64url");
const REQUEST_ID_2 = randomBytes(32).toString("base64url");
const ROTATED_REQUEST_ID = randomBytes(32).toString("base64url");
const NONCE_SHA_1 = "1".repeat(64);
const NONCE_SHA_2 = "2".repeat(64);
const ROTATED_NONCE_SHA = "3".repeat(64);
const RECEIPT_DIGEST = randomBytes(32).toString("hex");
const RECEIPT_DIGEST_2 = randomBytes(32).toString("hex");
const OBSERVED_AT = new Date();

function requireOwnerUrl() {
  assert.ok(OWNER_URL, "DATABASE_URL is required");
  return OWNER_URL;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function loginUrl(login, password) {
  const url = new URL(requireOwnerUrl());
  url.username = login;
  url.password = password;
  return url.toString();
}

async function inWorkspace(database, workspaceId, callback) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      workspaceId,
    );
    return callback(transaction);
  });
}

async function reserve(
  database,
  {
    operationKey = OPERATION_KEY,
    derivationKeyId = "settlement-test",
    requestId = REQUEST_ID_1,
    nonceSha256 = NONCE_SHA_1,
  } = {},
) {
  return inWorkspace(database, WORKSPACE_ID, (transaction) =>
    transaction.$queryRawUnsafe(
      `SELECT * FROM reserve_site_build_model_spend_v1(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::varchar,$6,$7,$8::bigint,
        $9::jsonb,$10::varchar,$11::varchar,$12::varchar,$13::varchar,
        $14::varchar,$15::varchar,$16::integer,$17::integer,$18::integer,
        $19::integer,$20::integer,$21::bigint,$22::varchar,$23::varchar,
        $24::varchar,$25::bigint,$26::bigint,$27::bigint
      )`,
      WORKSPACE_ID,
      BUILD_RUN_ID,
      TASK_ATTEMPT_ID,
      FENCE_TOKEN,
      operationKey,
      "site_builder.copy",
      "gpt-5.6-terra@gateway",
      800_000n,
      JSON.stringify({ provider: "gateway" }),
      derivationKeyId,
      requestId,
      nonceSha256,
      "new-api-request-bound-reconciliation-v1",
      "openai-responses",
      "gpt-5.6-terra",
      72,
      1024,
      2,
      4000,
      4000,
      2_000_000n,
      "site-builder-product-pricing-test",
      "a".repeat(64),
      "b".repeat(64),
      2_000_000n,
      10_000_000n,
      1_000_000n,
    ),
  );
}

async function beginWire(database, wireAttemptId) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      "SELECT begin_site_build_provider_wire_v1($1::uuid,$2::uuid,$3::uuid) AS decision",
      WORKSPACE_ID,
      wireAttemptId,
      FENCE_TOKEN,
    );
    return row.decision;
  });
}

async function claimProbe(database, wireAttemptId, sequence) {
  return inWorkspace(database, WORKSPACE_ID, (transaction) =>
    transaction.$queryRawUnsafe(
      "SELECT * FROM claim_site_build_provider_readback_probe_v1($1::uuid,$2::uuid,$3::integer)",
      WORKSPACE_ID,
      wireAttemptId,
      sequence,
    ),
  );
}

async function recordProbe(database, probeId, phase, statusClass, observedAt) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      "SELECT record_site_build_provider_readback_probe_v1($1::uuid,$2::uuid,$3::varchar,$4::integer,$5::timestamptz) AS decision",
      WORKSPACE_ID,
      probeId,
      phase,
      statusClass,
      observedAt,
    );
    return row.decision;
  });
}

async function finalizeWire(database, wireAttemptId, input) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      `SELECT finalize_site_build_provider_wire_v1(
        $1::uuid,$2::uuid,$3::varchar,$4::varchar,$5::varchar,
        $6::varchar,$7::varchar,$8::timestamptz
      ) AS decision`,
      WORKSPACE_ID,
      wireAttemptId,
      input.settlementStatus,
      input.finalPhase,
      input.gatewayIdState,
      input.upstreamIdState,
      input.payloadState,
      input.observedAt,
    );
    return row.decision;
  });
}

async function finalizeWireFromReceipt(database, wireAttemptId) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      "SELECT finalize_site_build_provider_wire_from_receipt_v1($1::uuid,$2::uuid) AS decision",
      WORKSPACE_ID,
      wireAttemptId,
    );
    return row.decision;
  });
}

async function finalizeWireNotDispatched(database, wireAttemptId) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      "SELECT finalize_site_build_provider_wire_not_dispatched_v1($1::uuid,$2::uuid) AS decision",
      WORKSPACE_ID,
      wireAttemptId,
    );
    return row.decision;
  });
}

async function recordReceipt(database, wireAttemptId, input) {
  return inWorkspace(database, WORKSPACE_ID, async (transaction) => {
    const [row] = await transaction.$queryRawUnsafe(
      `SELECT record_site_build_provider_wire_receipt_v1(
        $1::uuid,$2::uuid,$3::varchar,$4::varchar,$5::varchar,
        $6::integer,$7::bigint,$8::integer,$9::integer,$10::bigint,
        $11::varchar,$12::timestamptz
      ) AS decision`,
      WORKSPACE_ID,
      wireAttemptId,
      input.receiptDigest,
      "gpt-5.6-terra",
      "openai-responses",
      72,
      1_250n,
      120,
      30,
      input.exactCostMicrousd ?? 540n,
      "observed",
      input.observedAt,
    );
    return row.decision;
  });
}

describe("site build physical provider wire PostgreSQL authority", () => {
  let owner;
  let worker;
  let api;
  let spendId;
  let firstWireId;
  let secondWireId;
  let firstDerivationKeyId;

  before(async () => {
    owner = client(requireOwnerUrl());
    await owner.$executeRawUnsafe(`
      DO $roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${WORKER_LOGIN}') THEN
          DROP ROLE ${WORKER_LOGIN};
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${API_LOGIN}') THEN
          DROP ROLE ${API_LOGIN};
        END IF;
        CREATE ROLE ${WORKER_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${WORKER_PASSWORD}';
        CREATE ROLE ${API_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${API_PASSWORD}';
        GRANT app_user, runtime_worker TO ${WORKER_LOGIN};
        GRANT app_user, runtime_api TO ${API_LOGIN};
      END
      $roles$
    `);
    worker = client(loginUrl(WORKER_LOGIN, WORKER_PASSWORD));
    api = client(loginUrl(API_LOGIN, API_PASSWORD));

    const now = Date.now();
    await owner.$executeRawUnsafe(
      `INSERT INTO workspace(id,name,created_at,updated_at)
       VALUES ($1::uuid,'Wire authority test',now(),now()),
              ($2::uuid,'Wire authority other',now(),now())`,
      WORKSPACE_ID,
      OTHER_WORKSPACE_ID,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO site(id,workspace_id,name,slug,intake,created_at,updated_at)
       VALUES ($1::uuid,$2::uuid,'Wire site',$3,'{}'::jsonb,now(),now())`,
      SITE_ID,
      WORKSPACE_ID,
      `wire-${randomBytes(8).toString("hex")}`,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO site_build_run(id,workspace_id,site_id,kind,status,created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'refurbish','running',now())`,
      BUILD_RUN_ID,
      WORKSPACE_ID,
      SITE_ID,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO site_build_budget_grant(
        workspace_id,site_id,build_run_id,issuer,audience,jti,
        schema_version,purpose,operation,request_sha256,token_sha256,
        currency,unit,cap_microusd,issued_at,not_before,expires_at
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,'https://control.example.test',
        'global-backend:site-builder-budget',$4::uuid,
        'site-builder-budget-grant/v1','site_builder.build_run','refurbish',
        $5,$6,'USD','microusd',5000000,$7::timestamptz,
        $8::timestamptz,$9::timestamptz
      )`,
      WORKSPACE_ID,
      SITE_ID,
      BUILD_RUN_ID,
      randomUUID(),
      "c".repeat(64),
      "d".repeat(64),
      new Date(now - 30_000),
      new Date(now - 20_000),
      new Date(now + 240_000),
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO site_build_budget(
        build_run_id,workspace_id,site_id,cap_microusd,
        reserved_microusd,charged_microusd,paid_calls_enabled,
        created_at,updated_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,5000000,0,0,true,now(),now())`,
      BUILD_RUN_ID,
      WORKSPACE_ID,
      SITE_ID,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO site_build_task_attempt(
        id,workspace_id,site_id,build_run_id,task_id,status,attempt_no,
        fence_token,lease_until,created_at,updated_at
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'site_builder.copy',
        'CLAIMED',1,$5::uuid,now()+interval '10 minutes',now(),now()
      )`,
      TASK_ATTEMPT_ID,
      WORKSPACE_ID,
      SITE_ID,
      BUILD_RUN_ID,
      FENCE_TOKEN,
    );
  });

  after(async () => {
    await Promise.allSettled([worker?.$disconnect(), api?.$disconnect()]);
    if (owner) {
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${WORKER_LOGIN}`);
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${API_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("atomically creates one Spend and one first wire under concurrency", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        reserve(
          worker,
          index % 2 === 0
            ? undefined
            : {
                derivationKeyId: "settlement-rotated",
                requestId: ROTATED_REQUEST_ID,
                nonceSha256: ROTATED_NONCE_SHA,
              },
        ),
      ),
    );
    const rows = outcomes.map(([row]) => row);
    assert.equal(rows.filter((row) => row.decision === "EXECUTE").length, 1);
    assert.equal(rows.filter((row) => row.decision === "REPLAY").length, 11);
    assert.equal(new Set(rows.map((row) => row.spend_id)).size, 1);
    assert.equal(new Set(rows.map((row) => row.wire_attempt_id)).size, 1);
    assert.equal(
      new Set(rows.map((row) => row.wire_derivation_key_id)).size,
      1,
    );
    assert.equal(
      new Set(rows.map((row) => row.wire_settlement_request_id)).size,
      1,
    );
    assert.equal(
      new Set(rows.map((row) => row.wire_settlement_nonce_sha256)).size,
      1,
    );
    spendId = rows[0].spend_id;
    firstWireId = rows[0].wire_attempt_id;
    firstDerivationKeyId = rows[0].wire_derivation_key_id;
    assert.ok(
      firstDerivationKeyId === "settlement-test" ||
        firstDerivationKeyId === "settlement-rotated",
    );

    const [fact] = await owner.$queryRawUnsafe(
      `SELECT s.status,count(w.id)::int AS wires
       FROM site_build_spend s
       JOIN site_build_provider_wire_attempt w ON w.spend_id=s.id
       WHERE s.id=$1::uuid GROUP BY s.status`,
      spendId,
    );
    assert.deepEqual(fact, { status: "RESERVED", wires: 1 });
    const [replay] = await reserve(worker);
    assert.equal(replay.decision, "REPLAY");
    assert.equal(replay.wire_attempt_id, firstWireId);
    assert.equal(replay.wire_state, "ALLOCATED");
    assert.equal(replay.wire_derivation_key_id, firstDerivationKeyId);
    assert.equal(
      replay.wire_settlement_request_id,
      rows[0].wire_settlement_request_id,
    );
    assert.equal(
      replay.wire_settlement_nonce_sha256,
      rows[0].wire_settlement_nonce_sha256,
    );
  });

  it("closes a provably unsent wire as not incurred", async () => {
    const operationKey = randomBytes(32).toString("hex");
    const [reserved] = await reserve(worker, {
      operationKey,
      requestId: randomBytes(32).toString("base64url"),
      nonceSha256: randomBytes(32).toString("hex"),
    });
    assert.equal(
      await finalizeWireNotDispatched(worker, reserved.wire_attempt_id),
      "FINALIZED",
    );
    assert.equal(
      await finalizeWireNotDispatched(worker, reserved.wire_attempt_id),
      "REPLAY",
    );
    const [bulk] = await inWorkspace(worker, WORKSPACE_ID, (transaction) =>
      transaction.$queryRawUnsafe(
        "SELECT reconcile_site_build_spend($1::uuid,$2::uuid) AS reconciled",
        WORKSPACE_ID,
        BUILD_RUN_ID,
      ),
    );
    assert.equal(bulk.reconciled, 0);
    const [beforeSettlement] = await owner.$queryRawUnsafe(
      "SELECT status FROM site_build_spend WHERE operation_key=$1",
      operationKey,
    );
    assert.equal(beforeSettlement.status, "RESERVED");
    const settlement = await inWorkspace(
      worker,
      WORKSPACE_ID,
      async (transaction) => {
        const [row] = await transaction.$queryRawUnsafe(
          `SELECT settle_site_build_spend(
            $1::uuid,$2::uuid,$3::varchar,$4::uuid,'RELEASED',0,
            'not_incurred',NULL,NULL,NULL,NULL,NULL,NULL,NULL,
            $5::jsonb,'MODEL_WIRE_NOT_DISPATCHED'
          ) AS decision`,
          WORKSPACE_ID,
          BUILD_RUN_ID,
          operationKey,
          FENCE_TOKEN,
          JSON.stringify({ reason: "all_attempts_not_dispatched" }),
        );
        return row.decision;
      },
    );
    assert.equal(settlement, "SETTLED");
    const [truth] = await owner.$queryRawUnsafe(
      `SELECT s.status,s.cost_basis,s.budget_charge_microusd,s.call_count,
              w.state,w.dispatch_started_at,w.settlement_status,w.final_phase
       FROM site_build_spend s
       JOIN site_build_provider_wire_attempt w ON w.spend_id=s.id
       WHERE s.operation_key=$1`,
      operationKey,
    );
    assert.deepEqual(truth, {
      status: "RELEASED",
      cost_basis: "not_incurred",
      budget_charge_microusd: 0n,
      call_count: null,
      state: "NOT_DISPATCHED",
      dispatch_started_at: null,
      settlement_status: "NOT_INCURRED",
      final_phase: "not_dispatched",
    });
  });

  it("allows one send-cut winner and never sends from a replay", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => beginWire(worker, firstWireId)),
    );
    assert.equal(decisions.filter((value) => value === "DISPATCH").length, 1);
    assert.equal(
      decisions.filter((value) => value === "READBACK_ONLY").length,
      11,
    );
    const [bulk] = await inWorkspace(worker, WORKSPACE_ID, (transaction) =>
      transaction.$queryRawUnsafe(
        "SELECT reconcile_site_build_spend($1::uuid,$2::uuid) AS reconciled",
        WORKSPACE_ID,
        BUILD_RUN_ID,
      ),
    );
    assert.equal(bulk.reconciled, 0);
    const [spend] = await owner.$queryRawUnsafe(
      "SELECT status FROM site_build_spend WHERE id=$1::uuid",
      spendId,
    );
    assert.equal(spend.status, "RESERVED");
  });

  it("claims at most two readback probes across concurrent workers", async () => {
    const firstClaims = await Promise.all(
      Array.from({ length: 12 }, () => claimProbe(worker, firstWireId, 1)),
    );
    const firstRows = firstClaims.map(([row]) => row);
    assert.equal(
      firstRows.filter((row) => row.decision === "CLAIMED").length,
      1,
    );
    assert.equal(
      firstRows.filter((row) => row.decision === "REPLAY").length,
      11,
    );
    const [second] = await claimProbe(worker, firstWireId, 2);
    assert.equal(second.decision, "CLAIMED");
    await assert.rejects(
      claimProbe(worker, firstWireId, 3),
      /SITE_BUILD_PROVIDER_PROBE_CLAIM_INVALID/,
    );
    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM site_build_provider_readback_probe
       WHERE wire_attempt_id=$1::uuid`,
      firstWireId,
    );
    assert.equal(count, 2);

    assert.equal(
      await recordProbe(
        worker,
        firstRows[0].probe_id,
        "gateway_log_pending",
        2,
        OBSERVED_AT,
      ),
      "RECORDED",
    );
    assert.equal(
      await recordProbe(
        worker,
        firstRows[0].probe_id,
        "gateway_log_pending",
        2,
        OBSERVED_AT,
      ),
      "REPLAY",
    );
    await assert.rejects(
      recordProbe(
        worker,
        firstRows[0].probe_id,
        "gateway_log_invalid",
        2,
        OBSERVED_AT,
      ),
      /SITE_BUILD_PROVIDER_PROBE_OBSERVATION_CONFLICT/,
    );
  });

  it("allocates attempt two only after an exact first observation", async () => {
    await assert.rejects(
      recordReceipt(worker, firstWireId, {
        receiptDigest: RECEIPT_DIGEST,
        exactCostMicrousd: 539n,
        observedAt: OBSERVED_AT,
      }),
      /SITE_BUILD_PROVIDER_WIRE_RECEIPT_PRICE_INVALID/,
    );
    assert.equal(
      await recordReceipt(worker, firstWireId, {
        receiptDigest: RECEIPT_DIGEST,
        observedAt: OBSERVED_AT,
      }),
      "RECORDED",
    );
    assert.equal(
      await finalizeWire(worker, firstWireId, {
        settlementStatus: "SETTLED",
        finalPhase: "gateway_request_id_observed",
        gatewayIdState: "observed",
        upstreamIdState: "observed",
        payloadState: "available",
        observedAt: OBSERVED_AT,
      }),
      "FINALIZED",
    );
    const allocate = (
      identity = {
        derivationKeyId: firstDerivationKeyId,
        requestId: REQUEST_ID_2,
        nonceSha256: NONCE_SHA_2,
      },
    ) =>
      inWorkspace(worker, WORKSPACE_ID, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM allocate_site_build_provider_wire_v1(
            $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::uuid,
            $6::varchar,$7::varchar,$8::varchar
          )`,
          WORKSPACE_ID,
          BUILD_RUN_ID,
          spendId,
          OPERATION_KEY,
          FENCE_TOKEN,
          identity.derivationKeyId,
          identity.requestId,
          identity.nonceSha256,
        ),
      );
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => allocate()),
    );
    const rows = outcomes.map(([row]) => row);
    assert.equal(rows.filter((row) => row.decision === "EXECUTE").length, 1);
    assert.equal(rows.filter((row) => row.decision === "REPLAY").length, 7);
    assert.equal(
      new Set(rows.map((row) => row.wire_derivation_key_id)).size,
      1,
    );
    assert.equal(rows[0].wire_derivation_key_id, firstDerivationKeyId);
    secondWireId = rows[0].wire_attempt_id;
    const [replay] = await allocate({
      derivationKeyId: "settlement-another-active",
      requestId: ROTATED_REQUEST_ID,
      nonceSha256: ROTATED_NONCE_SHA,
    });
    assert.equal(replay.decision, "REPLAY");
    assert.equal(replay.wire_attempt_id, secondWireId);
    assert.equal(replay.wire_state, "ALLOCATED");
    assert.equal(replay.wire_derivation_key_id, firstDerivationKeyId);
    assert.equal(
      replay.wire_settlement_request_id,
      rows[0].wire_settlement_request_id,
    );
    assert.equal(
      replay.wire_settlement_nonce_sha256,
      rows[0].wire_settlement_nonce_sha256,
    );
    assert.equal(await beginWire(worker, secondWireId), "DISPATCH");
    assert.equal(await beginWire(worker, secondWireId), "READBACK_ONLY");
  });

  it("rejects impossible probe phases and normalized sensitive Spend meta keys", async () => {
    const operationKey = randomBytes(32).toString("hex");
    const [reserved] = await reserve(worker, {
      operationKey,
      requestId: randomBytes(32).toString("base64url"),
      nonceSha256: randomBytes(32).toString("hex"),
    });
    assert.equal(await beginWire(worker, reserved.wire_attempt_id), "DISPATCH");
    const [probe] = await claimProbe(worker, reserved.wire_attempt_id, 1);
    await assert.rejects(
      recordProbe(
        worker,
        probe.probe_id,
        "readback_http_success",
        2,
        new Date(),
      ),
      /SITE_BUILD_PROVIDER_PROBE_OBSERVATION_INVALID/,
    );
    await finalizeWire(worker, reserved.wire_attempt_id, {
      settlementStatus: "UNKNOWN",
      finalPhase: "gateway_log_missing",
      gatewayIdState: "observed",
      upstreamIdState: "unknown",
      payloadState: "unavailable",
      observedAt: new Date(),
    });

    for (const key of ["request id", "Settlement Request Id", "NONCE"]) {
      await assert.rejects(
        inWorkspace(worker, WORKSPACE_ID, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT settle_unknown_site_build_spend(
              $1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::bigint,
              NULL,NULL,1,$6::jsonb,$7::text,$8::text
            ) AS decision`,
            WORKSPACE_ID,
            BUILD_RUN_ID,
            operationKey,
            FENCE_TOKEN,
            800_000n,
            JSON.stringify({ [key]: "must-not-persist" }),
            "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING",
            "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING",
          ),
        ),
        /SITE_BUILD_PROVIDER_SETTLEMENT_META_FORBIDDEN/,
      );
    }
    const [unsettled] = await owner.$queryRawUnsafe(
      "SELECT status FROM site_build_spend WHERE operation_key=$1",
      operationKey,
    );
    assert.equal(unsettled.status, "RESERVED");
  });

  it("recovers receipt and Spend facts after a database-ACK gap without claiming a durable payload", async () => {
    assert.equal(
      await recordReceipt(worker, secondWireId, {
        receiptDigest: RECEIPT_DIGEST_2,
        observedAt: new Date(OBSERVED_AT.getTime() + 1),
      }),
      "RECORDED",
    );
    assert.equal(
      await finalizeWireFromReceipt(worker, secondWireId),
      "FINALIZED",
    );
    assert.equal(await finalizeWireFromReceipt(worker, secondWireId), "REPLAY");

    const [wire] = await owner.$queryRawUnsafe(
      `SELECT state,settlement_status,final_phase,gateway_id_state,
              upstream_id_state,payload_state
       FROM site_build_provider_wire_attempt WHERE id=$1::uuid`,
      secondWireId,
    );
    assert.deepEqual(wire, {
      state: "OBSERVED",
      settlement_status: "SETTLED",
      final_phase: "gateway_request_id_observed",
      gateway_id_state: "not_observable",
      upstream_id_state: "observed",
      payload_state: "unavailable",
    });

    await assert.rejects(
      inWorkspace(api, WORKSPACE_ID, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT settle_unknown_site_build_spend(
            $1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::bigint,
            NULL,NULL,$6::integer,$7::jsonb,$8::text,$9::text
          ) AS decision`,
          WORKSPACE_ID,
          BUILD_RUN_ID,
          OPERATION_KEY,
          FENCE_TOKEN,
          800_000n,
          2,
          JSON.stringify({ reason: "api-must-not-settle-provider-spend" }),
          "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
          "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
        ),
      ),
      /SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID/,
    );

    const decision = await inWorkspace(
      worker,
      WORKSPACE_ID,
      async (transaction) => {
        const [row] = await transaction.$queryRawUnsafe(
          `SELECT settle_unknown_site_build_spend(
            $1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::bigint,
            $6::integer,$7::integer,$8::integer,$9::jsonb,$10::text,$11::text
          ) AS decision`,
          WORKSPACE_ID,
          BUILD_RUN_ID,
          OPERATION_KEY,
          FENCE_TOKEN,
          800_000n,
          240,
          60,
          2,
          JSON.stringify({
            schemaVersion: "site-build-provider-spend-ack-recovery/v1",
            reason: "database_ack_recovery_after_send_cut",
            physicalWireCount: 2,
            exactReceiptCount: 2,
          }),
          "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
          "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
        );
        return row.decision;
      },
    );
    assert.equal(decision, "SETTLED");
    const [truth] = await owner.$queryRawUnsafe(
      `SELECT s.status,s.cost_basis,s.budget_charge_microusd,s.call_count,
              s.result_json,b.paid_calls_enabled,b.disabled_reason
       FROM site_build_spend s
       JOIN site_build_budget b ON b.build_run_id=s.build_run_id
       WHERE s.id=$1::uuid`,
      spendId,
    );
    assert.deepEqual(truth, {
      status: "UNKNOWN",
      cost_basis: "unknown",
      budget_charge_microusd: 800_000n,
      call_count: 2,
      result_json: null,
      paid_calls_enabled: false,
      disabled_reason: "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
    });
  });

  it("denies direct writes, API execution, legacy model reserve, and cross-workspace reads", async () => {
    await assert.rejects(
      inWorkspace(worker, WORKSPACE_ID, (transaction) =>
        transaction.$executeRawUnsafe(
          `INSERT INTO site_build_provider_readback_probe(
            workspace_id,site_id,build_run_id,spend_id,wire_attempt_id,sequence
          ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1)`,
          WORKSPACE_ID,
          SITE_ID,
          BUILD_RUN_ID,
          spendId,
          firstWireId,
        ),
      ),
      /permission denied/,
    );
    await assert.rejects(
      reserve(api),
      /permission denied|SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID/,
    );
    await assert.rejects(
      inWorkspace(worker, WORKSPACE_ID, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM reserve_site_build_spend(
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::varchar,
            'model',$6,$7,1,'{}'::jsonb
          )`,
          WORKSPACE_ID,
          BUILD_RUN_ID,
          TASK_ATTEMPT_ID,
          FENCE_TOKEN,
          randomBytes(32).toString("hex"),
          "site_builder.copy",
          "model@gateway",
        ),
      ),
      /MODEL_WIRE_AUTHORITY_REQUIRED/,
    );
    const crossWorkspace = await inWorkspace(
      worker,
      OTHER_WORKSPACE_ID,
      (transaction) =>
        transaction.$queryRawUnsafe(
          "SELECT id FROM site_build_provider_wire_attempt WHERE id=$1::uuid",
          firstWireId,
        ),
    );
    assert.deepEqual(crossWorkspace, []);
  });
});
