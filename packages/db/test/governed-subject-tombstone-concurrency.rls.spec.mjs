import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { beforeEach, describe, it } from "node:test";
import * as core from "./governed-subject-relation-append-attest.support.mjs";

const {
  ACCOUNT_A, APPEND, AUTH_A, CHILD_A, CHILD_B, OP_A, SOURCE_B, WS_A,
  asApp, parseRow, psql, resetDatabase, seedAuthority, selectCall, state,
} = core;
const TOMBSTONE = "tombstone_workspace_governed_subject_v1";
const REQUEST_A = "73000000-0000-4000-8000-000000000001";
const REQUEST_B = "73000000-0000-4000-8000-000000000002";
const DSR_A = "74000000-0000-4000-8000-000000000001";
const DSR_B = "74000000-0000-4000-8000-000000000002";
let first;
let second;

function dockerArgs() {
  assert.match(core.CONTAINER ?? "", /^codex-gsr-task2-pg-[a-z0-9-]+$/);
  return ["exec", "-i", core.CONTAINER, "psql", "-U", "global", "-d", "gsr_task2",
    "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

function asyncSql(sql) {
  return new Promise((resolve) => {
    const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function request(id, dsrId) {
  psql(`INSERT INTO deletion_request(id,workspace_id,subject_type,subject_id,status,
      requested_by,reason,created_at,updated_at)
    VALUES ('${id}','${WS_A}','company','${dsrId}','RECEIVED',
      'task3-concurrency','erasure',now(),now());`);
}

function tombstone(subjectId, requestId) {
  return `SELECT outcome FROM public.${TOMBSTONE}(
    '${WS_A}'::uuid,'${subjectId}'::uuid,'${requestId}'::uuid);`;
}

function setup() {
  psql(`DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone;
    DELETE FROM deletion_request WHERE id IN ('${REQUEST_A}','${REQUEST_B}');`);
  resetDatabase();
  state.factsA = seedAuthority({
    workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
    operationId: OP_A, suffix: "01",
  });
  first = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_A,
  }), WS_A)));
  second = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childId: CHILD_B, childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_B, relationKey: "record:second", sourceUuid: SOURCE_B,
  }), WS_A)));
  request(REQUEST_A, DSR_A);
  request(REQUEST_B, DSR_B);
}

function boundedApp(sql, readOnly = false) {
  return asApp(`SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='5s'; ${sql}`,
    WS_A, readOnly);
}

describe("governed subject Task 3 tombstone linearization", () => {
  beforeEach(setup);

  it("locks the existing artifact tombstone namespace as the shared reference", () => {
    const artifactBody = psql(`SELECT pg_get_functiondef(
      'public.tombstone_workspace_generic_operation_artifact_subject_v1(uuid,text,uuid,uuid)'::regprocedure);`);
    assert.match(artifactBody, /generic-operation-artifact-subject:/);
    assert.match(artifactBody, /pg_advisory_xact_lock/);
  });

  it("uses the exact shared artifact DSR advisory namespace", () => {
    const artifactKey = psql(`SELECT hashtextextended(
      'generic-operation-artifact-subject:${WS_A}:company:${DSR_A}',0);`);
    assert.match(artifactKey, /^-?\d+$/);
    const functionBody = psql(`SELECT pg_get_functiondef(
      'public.${TOMBSTONE}(uuid,uuid,uuid)'::regprocedure);`);
    assert.match(functionBody,
      /generic-operation-artifact-subject:[^]*?dsr_subject_type[^]*?dsr_subject_id/);
  });

  it("linearizes concurrent append and tombstone in either physical order", async () => {
    const append = selectCall(APPEND, state.factsA);
    const [fence, replay] = await Promise.all([
      asyncSql(boundedApp(tombstone(first[2], REQUEST_A))),
      asyncSql(boundedApp(append)),
    ]);
    assert.notEqual(fence.status, null);
    assert.notEqual(replay.status, null);
    assert.doesNotMatch(`${fence.stderr}${replay.stderr}`, /40P01|deadlock detected/i);
    assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone
      WHERE workspace_id='${WS_A}' AND governed_subject_id='${first[2]}';`), "1");
    if (replay.status !== 0) assert.match(replay.stderr, /GOVERNED_SUBJECT_TOMBSTONED/);
  });

  it("orders dual PERSONAL locks and opposite edges without deadlock", async () => {
    const aToB = selectCall(APPEND, state.factsA, {
      parentId: first[2], childId: CHILD_B, relationKey: "edge:a-b",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
    });
    const bToA = selectCall(APPEND, state.factsA, {
      parentId: second[2], childId: CHILD_A, relationKey: "edge:b-a",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
    });
    const results = await Promise.all([
      asyncSql(boundedApp(`${tombstone(first[2], REQUEST_A)} ${aToB}`)),
      asyncSql(boundedApp(`${tombstone(second[2], REQUEST_B)} ${bToA}`)),
    ]);
    assert.doesNotMatch(results.map((result) => result.stderr).join("\n"),
      /40P01|deadlock detected/i);
    assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone
      WHERE workspace_id='${WS_A}';`), "2");
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation relation
      WHERE relation.workspace_id='${WS_A}' AND relation.parent_subject_id=relation.child_subject_id;`), "0");
  });
});
