import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import * as core from "./governed-subject-relation-append-attest.support.mjs";

const { CONTAINER, DATABASE, APPEND, ATTEST, WS_A, WS_B, AUTH_A, AUTH_B, ACCOUNT_A, ACCOUNT_B, OP_A, OP_A2, OP_B, AUTH_H, ACCOUNT_H, OP_H, OP_RESERVED, OP_RECEIPT, OP_ARTIFACT, ARTIFACT_ID, CHILD_A, CHILD_B, SOURCE_A, SOURCE_B, CONTRACT_A, CONTRACT_B, MANAGED_ROLES, TABLES, ARGUMENTS, IDENTITY_TYPES, requireContainer, dockerArgs, rawPsql, psql, asApp, compact, functionCatalog, assertExactFunctionCatalog, assertExactHelperPolicy, createExactMutationBaseline, probeInvalidFunctionCatalog, resetDatabase, seedAuthority, seedOperation, seedReservedOperation, seedArtifactOperation, cloneAckWithDrift, seedDirectRelationForAck, invocation, selectCall, canonicalSnapshot, lifecycleSnapshot, governedGraphSnapshot, captureFailure, parseRow } = core;
const { state } = core;

describe("governed relation append/attest catalog and validation contract", () => {
  before(() => {
    assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global");
  });

  beforeEach(() => {
    resetDatabase();
    state.factsA = seedAuthority({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_A, suffix: "01",
    });
    state.factsB = seedAuthority({
      workspaceId: WS_B, authorityId: AUTH_B, accountId: ACCOUNT_B,
      operationId: OP_B, suffix: "02",
    });
    const snapshot = JSON.parse(canonicalSnapshot());
    assert.equal(snapshot.authority.length, 2);
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.operations.length, 2);
    assert.equal(snapshot.acks.length, 2);
    assert.equal(snapshot.subjects, null);
    assert.equal(snapshot.relations, null);
  });
  it("locks exact installed catalog, owner, search_path, volatility and all ACLs", () => {
    assertExactFunctionCatalog(functionCatalog("public"));
    for (const table of TABLES) {
      const acl = psql(`SELECT COALESCE(jsonb_agg(jsonb_build_array(
        x.grantor::regrole::text,CASE WHEN x.grantee=0 THEN 'PUBLIC'
          ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable)
        ORDER BY x.grantee,x.privilege_type),'[]')::text
      FROM pg_class c CROSS JOIN LATERAL
        aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
      WHERE c.oid='public.${table}'::regclass
        AND (x.grantee=0 OR x.grantee::regrole::text IN (${MANAGED_ROLES.map((role) => `'${role}'`).join(",")}));`);
      assert.equal(acl, "[]");
    }
    const helperLeak = psql(`SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
      WHERE p.pronamespace='public'::regnamespace
        AND p.proname LIKE '\\_governed_subject_relation\\_%'
        AND (x.grantee=0 OR x.grantee::regrole::text IN
          (${MANAGED_ROLES.map((role) => `'${role}'`).join(",")}));`);
    assert.equal(helperLeak, "0");
    assertExactHelperPolicy("public");
  });

  it("shares the exact catalog validator with all catalog mutation probes", () => {
    const signature = (schema) => `${schema}.${ATTEST}(${IDENTITY_TYPES})`;
    probeInvalidFunctionCatalog("stable", (schema) =>
      `ALTER FUNCTION ${signature(schema)} STABLE;`);
    probeInvalidFunctionCatalog("invoker", (schema) =>
      `ALTER FUNCTION ${signature(schema)} SECURITY INVOKER;`);
    probeInvalidFunctionCatalog("search", (schema) =>
      `ALTER FUNCTION ${signature(schema)} SET search_path=pg_catalog,public,pg_temp;`);
    probeInvalidFunctionCatalog("public_acl", (schema) =>
      `GRANT EXECUTE ON FUNCTION ${signature(schema)} TO PUBLIC;`);
    probeInvalidFunctionCatalog("owner", (schema) =>
      `ALTER FUNCTION ${signature(schema)} OWNER TO app_user;`);
    probeInvalidFunctionCatalog("reorder", (schema) => `
      DROP FUNCTION ${signature(schema)};
      CREATE FUNCTION ${schema}.${ATTEST}(
        ${ARGUMENTS.replace("p_workspace_id uuid, p_authority_id uuid", "p_authority_id uuid, p_workspace_id uuid")}
      ) RETURNS TABLE(operation_subject_id uuid,parent_subject_id uuid,
        child_subject_id uuid,relation_id uuid,replay boolean)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
      AS $attest$ BEGIN PERFORM ${schema}._attest_reader(); RETURN; END $attest$;
      REVOKE ALL ON FUNCTION ${schema}.${ATTEST}(${IDENTITY_TYPES}) FROM PUBLIC,
        ${MANAGED_ROLES.join(",")};
      GRANT EXECUTE ON FUNCTION ${schema}.${ATTEST}(${IDENTITY_TYPES}) TO app_user;`);
    probeInvalidFunctionCatalog("helper", (schema) => `
      CREATE OR REPLACE FUNCTION ${schema}.${ATTEST}(${ARGUMENTS})
      RETURNS TABLE(operation_subject_id uuid,parent_subject_id uuid,
        child_subject_id uuid,relation_id uuid,replay boolean)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
      AS $attest$ BEGIN PERFORM ${schema}._append_writer(); RETURN; END $attest$;`, true);
  });

  it("denies SET ROLE and temp shadow substitution", () => {
    const denied = rawPsql(asApp("SET ROLE global;", WS_A));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /permission denied to set role/i);
    const shadow = rawPsql(asApp(`CREATE FUNCTION pg_temp.${APPEND}() RETURNS text
      LANGUAGE sql AS $$ SELECT 'shadow' $$;
      CREATE TEMP TABLE governed_subject(marker text);
      CREATE TEMP TABLE tool_operation_subject(marker text);
      CREATE TEMP TABLE governed_subject_relation(marker text);
      INSERT INTO governed_subject VALUES ('shadow');
      ${selectCall(APPEND, state.factsA)}`, WS_A));
    assert.equal(shadow.status, 0, shadow.stderr);
    assert.doesNotMatch(shadow.stdout, /shadow/);
    assert.match(shadow.stdout, /^[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+\|f$/m);
    const selfRole = rawPsql(asApp(`SET ROLE app_user; ${selectCall(APPEND, state.factsA, {
      childId: "51000000-0000-4000-8000-000000000099", relationKey: "role:self",
    })}`, WS_A));
    assert.notEqual(selfRole.status, 0);
    assert.match(selfRole.stderr, /GOVERNED_OPERATION_SUBJECT_INVALID/);
  });

  it("missing attest before append fails inside READ ONLY without any canonical mutation", () => {
    const before = canonicalSnapshot();
    const attempt = rawPsql(asApp(selectCall(ATTEST, state.factsA), WS_A, true));
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE/);
    assert.equal(canonicalSnapshot(), before);
  });

  it("rejects a coherent workspace B tuple when the caller session is workspace A", () => {
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, state.factsB, {}, "GOVERNED_OPERATION_SUBJECT_INVALID", WS_A);
    }
  });

  it("accepts immutable historical settled facts after natural authority expiry and account close", () => {
    const historical = seedAuthority({
      workspaceId: WS_A, authorityId: AUTH_H, accountId: ACCOUNT_H,
      operationId: OP_H, suffix: "03", expired: true, closed: true,
      insertWorkspace: false,
    });
    psql(`UPDATE tool_budget_account SET generation=generation+1
      WHERE id='${historical.accountId}';`);
    const lifecycleBefore = lifecycleSnapshot(
      historical.authorityId, historical.accountId, historical.operationId, historical.ackId,
    );
    const graphBefore = JSON.parse(governedGraphSnapshot());
    assert.deepEqual(graphBefore, { subjects: [], operationSubjects: [], relations: [] });
    const first = parseRow(psql(asApp(selectCall(APPEND, historical), WS_A)));
    assert.equal(lifecycleSnapshot(
      historical.authorityId, historical.accountId, historical.operationId, historical.ackId,
    ), lifecycleBefore);
    const graphAfterAppendText = governedGraphSnapshot();
    const graphAfterAppend = JSON.parse(graphAfterAppendText);
    assert.equal(graphAfterAppend.subjects.length, 2);
    assert.equal(graphAfterAppend.operationSubjects.length, 1);
    assert.equal(graphAfterAppend.relations.length, 1);
    const replay = parseRow(psql(asApp(selectCall(APPEND, historical), WS_A)));
    assert.equal(first[4], "f");
    assert.deepEqual(replay.slice(0, 4), first.slice(0, 4));
    assert.equal(replay[4], "t");
    assert.equal(governedGraphSnapshot(), graphAfterAppendText);
    const calls = Array.from({ length: 100 }, () => selectCall(ATTEST, historical)).join("\n");
    const rows = psql(asApp(calls, WS_A, true)).split("\n").filter((line) => line.includes("|"));
    assert.equal(rows.length, 100);
    assert.equal(lifecycleSnapshot(
      historical.authorityId, historical.accountId, historical.operationId, historical.ackId,
    ), lifecycleBefore);
    assert.equal(governedGraphSnapshot(), graphAfterAppendText);
  });

  it("appends, exact-replays and attests 100x with a byte-stable canonical snapshot", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, state.factsA), WS_A)));
    assert.equal(first[4], "f");
    const replay = parseRow(psql(asApp(selectCall(APPEND, state.factsA), WS_A)));
    assert.deepEqual(replay.slice(0,4), first.slice(0,4));
    assert.equal(replay[4], "t");
    const before = canonicalSnapshot();
    const statements = Array.from({ length: 100 }, () => selectCall(ATTEST, state.factsA)).join("\n");
    const rows = psql(asApp(statements, WS_A, true)).split("\n").filter((line) => line.includes("|"));
    assert.equal(rows.length, 100);
    for (const row of rows) {
      const values = row.split("|");
      assert.deepEqual(values.slice(0,4), first.slice(0,4));
      assert.equal(values[4], "t");
    }
    assert.equal(canonicalSnapshot(), before);
  });

  it("fails closed for caller and stored authority/account/operation/ACK/result/root/source drift", () => {
    psql(asApp(selectCall(APPEND, state.factsA), WS_A));
    const vectors = [
      [{ authorityId: state.factsB.authorityId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ accountId: state.factsB.accountId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ generation: 2 }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ operationId: state.factsB.operationId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ ackId: state.factsB.ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ resultDigest: state.factsB.resultDigest }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [{ sourceUuid: null, sourceSha256: null }, "GOVERNED_SUBJECT_RELATION_INVALID"],
      [{ sourceUuid: SOURCE_A, sourceSha256: CONTRACT_A }, "GOVERNED_SUBJECT_RELATION_INVALID"],
      [{ workspaceId: WS_B }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
    ];
    for (const fn of [APPEND, ATTEST]) {
      for (const [override, code] of vectors) captureFailure(fn, state.factsA, override, code);
    }
  });

  it("rejects each non-canonical root field for append and attest", () => {
    psql(asApp(selectCall(APPEND, state.factsA), WS_A));
    const rootDrifts = [
      { rootSubjectType: "other" },
      { rootSubjectId: CHILD_A },
      { rootDataClass: "PERSONAL" },
      { rootDsrSubjectType: "company" },
      { rootDsrSubjectId: "71000000-0000-4000-8000-000000000001" },
    ];
    for (const fn of [APPEND, ATTEST]) {
      for (const override of rootDrifts) {
        captureFailure(fn, state.factsA, override, "GOVERNED_OPERATION_SUBJECT_INVALID");
      }
    }
  });

  it("rejects every required NULL while preserving the four nullable union fields", () => {
    psql(asApp(selectCall(APPEND, state.factsA), WS_A));
    const operationNulls = [
      { workspaceId: null }, { authorityId: null }, { accountId: null },
      { operationId: null }, { generation: null }, { ackId: null },
      { resultDigest: null }, { rootSubjectType: null }, { rootSubjectId: null },
      { rootDataClass: null },
    ];
    const relationNulls = [
      { childType: null }, { childId: null }, { childDataClass: null },
      { relationKey: null }, { relationKind: null }, { sourceNamespace: null },
      { contractSha256: null },
    ];
    for (const fn of [APPEND, ATTEST]) {
      for (const override of operationNulls) {
        captureFailure(fn, state.factsA, override, "GOVERNED_OPERATION_SUBJECT_INVALID");
      }
      for (const override of relationNulls) {
        captureFailure(fn, state.factsA, override, "GOVERNED_SUBJECT_RELATION_INVALID");
      }
    }
    const nullable = {
      parentId: null, rootDsrSubjectType: null, rootDsrSubjectId: null,
      childDsrSubjectType: null, childDsrSubjectId: null,
      sourceUuid: null, sourceSha256: CONTRACT_A, relationKey: "nullable:sha",
      childId: "51000000-0000-4000-8000-000000000098",
    };
    psql(asApp(selectCall(APPEND, state.factsA, nullable), WS_A));
    psql(asApp(selectCall(ATTEST, state.factsA, nullable), WS_A, true));
  });

});
