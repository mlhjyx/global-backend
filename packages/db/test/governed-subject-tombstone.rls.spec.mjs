import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import * as core from "./governed-subject-relation-append-attest.support.mjs";

const {
  ACCOUNT_A, ACCOUNT_B, APPEND, ATTEST, AUTH_A, AUTH_B, CHILD_A, CHILD_B,
  CONTRACT_B, OP_A, OP_B, SOURCE_B, WS_A, WS_B, asApp, canonicalSnapshot,
  parseRow, psql, rawPsql, resetDatabase, seedAuthority, selectCall, state,
} = core;
const TOMBSTONE = "tombstone_workspace_governed_subject_v1";
const REQUEST_A = "71000000-0000-4000-8000-000000000001";
const REQUEST_A2 = "71000000-0000-4000-8000-000000000002";
const REQUEST_B = "71000000-0000-4000-8000-000000000003";
const REQUEST_DEEP = "71000000-0000-4000-8000-000000000004";
const DSR_A = "72000000-0000-4000-8000-000000000001";
const DSR_B = "72000000-0000-4000-8000-000000000002";
let personalA;
let personalA2;
let personalB;
let nonPersonalA;

function cleanup() {
  psql(`DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone;
    DELETE FROM deletion_request WHERE id IN
      ('${REQUEST_A}','${REQUEST_A2}','${REQUEST_B}','${REQUEST_DEEP}');`);
  resetDatabase();
}

function request(id, workspaceId, subjectType, subjectId) {
  psql(`INSERT INTO deletion_request(id,workspace_id,subject_type,subject_id,status,
      requested_by,reason,created_at,updated_at)
    VALUES ('${id}','${workspaceId}','${subjectType}','${subjectId}','RECEIVED',
      'task3-test','erasure',now(),now());`);
}

function call(workspaceId, subjectId, requestId) {
  return `SELECT governed_subject_id::text,tombstoned_at::text,audit_id::text,outcome
    FROM public.${TOMBSTONE}('${workspaceId}'::uuid,'${subjectId}'::uuid,'${requestId}'::uuid);`;
}

function appCall(workspaceId, subjectId, requestId) {
  return psql(asApp(call(workspaceId, subjectId, requestId), workspaceId));
}

function capture(workspaceId, subjectId, requestId, code) {
  const before = canonicalSnapshot();
  const result = psql(asApp(`CREATE TEMP TABLE task3_error(state text,message text) ON COMMIT DROP;
    DO $capture$ DECLARE s text; m text; BEGIN BEGIN
      PERFORM * FROM public.${TOMBSTONE}('${workspaceId}'::uuid,'${subjectId}'::uuid,'${requestId}'::uuid);
      INSERT INTO task3_error VALUES ('00000','NO_ERROR');
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE,m=MESSAGE_TEXT;
      INSERT INTO task3_error VALUES(s,m); END; END $capture$;
    SELECT state||'|'||message FROM task3_error;`, workspaceId)).split("\n").at(-1);
  assert.equal(result, `P0001|${code}`);
  assert.ok(result.length <= 96);
  assert.doesNotMatch(result, /email|phone|token|prompt|response|credential/i);
  assert.equal(canonicalSnapshot(), before);
}

function seed() {
  state.factsA = seedAuthority({
    workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
    operationId: OP_A, suffix: "01",
  });
  state.factsB = seedAuthority({
    workspaceId: WS_B, authorityId: AUTH_B, accountId: ACCOUNT_B,
    operationId: OP_B, suffix: "02",
  });
  personalA = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_A,
  }), WS_A)));
  nonPersonalA = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childId: CHILD_B, relationKey: "record:nonpersonal", sourceUuid: SOURCE_B,
    contractSha256: CONTRACT_B,
  }), WS_A)));
  personalA2 = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childId: "51000000-0000-4000-8000-000000000003",
    childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_A, relationKey: "record:personal-two",
    sourceUuid: "61000000-0000-4000-8000-000000000003",
  }), WS_A)));
  personalB = parseRow(psql(asApp(selectCall(APPEND, state.factsB, {
    childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_B,
  }), WS_B)));
  request(REQUEST_A, WS_A, "company", DSR_A);
  psql(`UPDATE deletion_request SET status='COMPLETED',completed_at=now()
    WHERE id='${REQUEST_A}';`);
  request(REQUEST_A2, WS_A, "company", DSR_A);
  request(REQUEST_B, WS_B, "company", DSR_B);
}

describe("governed subject Task 3 tombstone database contract", () => {
  before(() => {
    assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global");
  });

  beforeEach(() => {
    cleanup();
    seed();
    assert.equal(psql(`SELECT count(*) FILTER (WHERE data_class='PERSONAL')||':'||
      count(*) FILTER (WHERE data_class='NON_PERSONAL') FROM governed_subject
      WHERE id IN ('${personalA[2]}','${personalB[2]}','${nonPersonalA[2]}');`), "2:1");
  });

  it("installs only the exact public function, owner search_path and app execute ACL", () => {
    const catalog = psql(`SELECT p.proname,pg_get_function_identity_arguments(p.oid),
      pg_get_function_result(p.oid),p.provolatile,p.prosecdef,p.proowner::regrole::text,
      array_to_string(p.proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='${TOMBSTONE}';`);
    assert.equal(catalog,
      `${TOMBSTONE}|p_workspace_id uuid, p_governed_subject_id uuid, p_deletion_request_id uuid|TABLE(governed_subject_id uuid, tombstoned_at timestamp with time zone, audit_id uuid, outcome character varying)|v|t|global|search_path=pg_catalog, public`);
    assert.equal(psql(`SELECT COALESCE(string_agg(
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END||':'||x.privilege_type,
      ',' ORDER BY x.grantee,x.privilege_type),'') FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
      WHERE p.oid='public.${TOMBSTONE}(uuid,uuid,uuid)'::regprocedure
        AND (x.grantee=0 OR x.grantee::regrole::text IN
          ('app_user','execution_budget_platform_writer','runtime_api','runtime_worker','runtime_outbox_relay'));`),
    "app_user:EXECUTE");
  });

  it("validates dynamic PERSONAL DSR identity and rejects NON_PERSONAL or mismatched requests", () => {
    capture(WS_A, nonPersonalA[2], REQUEST_A, "GOVERNED_SUBJECT_INVALID");
    capture(WS_A, personalA[2], REQUEST_B, "GOVERNED_SUBJECT_INVALID");
    psql(`UPDATE deletion_request SET subject_type='person' WHERE id='${REQUEST_A}';`);
    capture(WS_A, personalA[2], REQUEST_A, "GOVERNED_SUBJECT_INVALID");
    psql(`UPDATE deletion_request SET subject_type='company',subject_id='${DSR_B}'
      WHERE id='${REQUEST_A}';`);
    capture(WS_A, personalA[2], REQUEST_A, "GOVERNED_SUBJECT_INVALID");
  });

  it("locks the three replay outcomes and keeps the first fence time immutable", () => {
    const created = appCall(WS_A, personalA[2], REQUEST_A).split("|");
    assert.equal(created[0], personalA[2]);
    assert.equal(created[3], "FENCE_CREATED");
    const firstTime = created[1];
    const replay = appCall(WS_A, personalA[2], REQUEST_A).split("|");
    assert.equal(replay[3], "REPLAYED");
    assert.equal(replay[1], firstTime);
    const added = appCall(WS_A, personalA[2], REQUEST_A2).split("|");
    assert.equal(added[3], "AUDIT_APPENDED_WITH_EXISTING_FENCE");
    assert.equal(added[1], firstTime);
    assert.equal(psql(`SELECT count(*)||':'||count(DISTINCT tombstoned_at)
      FROM governed_subject_tombstone_audit WHERE governed_subject_id='${personalA[2]}';`), "2:1");
    capture(WS_A, personalA2[2], REQUEST_A, "GOVERNED_SUBJECT_RELATION_CONFLICT");
  });

  it("blocks deep-path append and read-only attest after an intermediate fence", () => {
    const middle = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
      parentId: personalA[2], childId: CHILD_B, relationKey: "record:middle",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B, contractSha256: CONTRACT_B,
    }), WS_A)));
    appCall(WS_A, personalA[2], REQUEST_A);
    for (const fn of [APPEND, ATTEST]) {
      core.captureFailure(fn, state.factsA, {
        parentId: middle[2], childId: "51000000-0000-4000-8000-000000000099",
        relationKey: "record:deep", sourceUuid: SOURCE_B,
      }, "GOVERNED_SUBJECT_TOMBSTONED");
    }
  });

  it("denies direct tables, helper execute, managed roles, cross-workspace and append-only mutation", () => {
    for (const statement of [
      "SELECT * FROM governed_subject_tombstone",
      "INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id) VALUES ('11000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001')",
      "UPDATE governed_subject_tombstone SET tombstoned_at=now()",
      "DELETE FROM governed_subject_tombstone",
    ]) {
      const denied = rawPsql(asApp(`${statement};`, WS_A));
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /permission denied/);
    }
    const cross = rawPsql(asApp(call(WS_A, personalA[2], REQUEST_A), WS_B));
    assert.notEqual(cross.status, 0);
    for (const role of ["execution_budget_platform_writer","runtime_api","runtime_worker","runtime_outbox_relay"]) {
      const denied = rawPsql(`SET SESSION AUTHORIZATION ${role}; ${call(WS_A, personalA[2], REQUEST_A)}`);
      assert.notEqual(denied.status, 0);
    }
  });
});
