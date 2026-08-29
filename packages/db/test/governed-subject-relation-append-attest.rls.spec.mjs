import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, beforeEach, describe, it } from "node:test";

const CONTAINER = process.env.GOVERNED_RELATION_TASK2_PG_CONTAINER;
const DATABASE = process.env.GOVERNED_RELATION_TASK2_PG_DATABASE ?? "gsr_task2";
const APPEND = "append_workspace_governed_child_relation_v1";
const ATTEST = "attest_workspace_governed_child_relation_v1";
const WS_A = "11000000-0000-4000-8000-000000000001";
const WS_B = "11000000-0000-4000-8000-000000000002";
const AUTH_A = "21000000-0000-4000-8000-000000000001";
const AUTH_B = "21000000-0000-4000-8000-000000000002";
const ACCOUNT_A = "31000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "31000000-0000-4000-8000-000000000002";
const OP_A = "41000000-0000-4000-8000-000000000001";
const OP_A2 = "41000000-0000-4000-8000-000000000011";
const OP_B = "41000000-0000-4000-8000-000000000002";
const CHILD_A = "51000000-0000-4000-8000-000000000001";
const CHILD_B = "51000000-0000-4000-8000-000000000002";
const SOURCE_A = "61000000-0000-4000-8000-000000000001";
const SOURCE_B = "61000000-0000-4000-8000-000000000002";
const CONTRACT_A = "a".repeat(64);
const CONTRACT_B = "b".repeat(64);
const MANAGED_ROLES = [
  "app_user", "execution_budget_platform_writer", "runtime_api",
  "runtime_worker", "runtime_outbox_relay",
];
const TABLES = [
  "governed_subject", "tool_operation_subject", "governed_subject_relation",
  "governed_subject_tombstone", "governed_subject_tombstone_audit",
];
const ARGUMENTS = [
  "p_workspace_id uuid", "p_authority_id uuid", "p_account_id uuid",
  "p_operation_id uuid", "p_operation_generation integer",
  "p_ack_id character", "p_result_digest character",
  "p_root_subject_type character varying", "p_root_subject_id uuid",
  "p_root_data_class character varying",
  "p_root_dsr_subject_type character varying", "p_root_dsr_subject_id uuid",
  "p_parent_governed_subject_id uuid",
  "p_child_subject_type character varying", "p_child_subject_id uuid",
  "p_child_data_class character varying",
  "p_child_dsr_subject_type character varying", "p_child_dsr_subject_id uuid",
  "p_relation_key character varying", "p_relation_kind character varying",
  "p_source_ref_namespace character varying", "p_source_ref_uuid uuid",
  "p_source_ref_sha256 character", "p_contract_sha256 character",
].join(", ");

let factsA;
let factsB;

function requireContainer() {
  assert.match(CONTAINER ?? "", /^codex-gsr-task2-pg-[a-z0-9-]+$/);
  return CONTAINER;
}

function dockerArgs() {
  assert.equal(DATABASE, "gsr_task2");
  return ["exec", "-i", requireContainer(), "psql", "-U", "global", "-d",
    DATABASE, "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

function rawPsql(sql) {
  return spawnSync("docker", dockerArgs(), {
    encoding: "utf8", input: sql, maxBuffer: 16 * 1024 * 1024,
  });
}

function psql(sql) {
  const result = rawPsql(sql);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function asApp(sql, workspaceId, readOnly = false) {
  return `SET SESSION AUTHORIZATION app_user;
    BEGIN${readOnly ? " READ ONLY" : ""};
    SELECT set_config('app.current_workspace_id','${workspaceId}',true);
    ${sql}
    COMMIT;`;
}

function compact(value) {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resetDatabase() {
  psql(`
    DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone;
    DELETE FROM governed_subject_relation;
    DELETE FROM tool_operation_subject;
    DELETE FROM governed_subject;
    DELETE FROM generic_operation_artifact_subject_tombstone_audit;
    DELETE FROM generic_operation_artifact_subject_tombstone;
    DELETE FROM execution_domain_ack;
    DELETE FROM tool_budget_operation;
    DELETE FROM tool_budget_account;
    DELETE FROM execution_budget_authority_revocation;
    DELETE FROM execution_budget_authority;
    DELETE FROM workspace WHERE id IN ('${WS_A}','${WS_B}');
  `);
}

function seedAuthority({ workspaceId, authorityId, accountId, operationId, suffix }) {
  psql(`
    INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${workspaceId}','Task2 ${suffix}',now(),now());
    INSERT INTO execution_budget_authority(
      id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
      schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
      cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at
    ) VALUES (
      '${authorityId}','${workspaceId}','WORKSPACE_GRANT','${workspaceId}',
      'https://task2-${suffix}.test','global-backend:execution-budget',
      '22000000-0000-4000-8000-0000000000${suffix}',repeat(right('${suffix}',1),64),
      'execution-budget-grant/v1','icp.design','company',
      '23000000-0000-4000-8000-0000000000${suffix}',repeat('2',64),
      'USD','microusd',1000,1,statement_timestamp()-interval '30 seconds',
      statement_timestamp()-interval '20 seconds',statement_timestamp()+interval '4 minutes',
      statement_timestamp()-interval '30 seconds'
    );
    INSERT INTO tool_budget_account(
      id,scope_key,account_key,generation,cap_cents,reserved_cents,charged_cents,
      exhausted,ref_count,authority_id,authorized_cap_microusd,
      reserved_microusd,charged_microusd,created_at,updated_at
    ) VALUES (
      '${accountId}','${workspaceId}','task2-account-${suffix}',1,0,0,0,false,1,
      '${authorityId}',1000,0,0,now(),now()
    );
  `);
  return seedOperation({ workspaceId, authorityId, accountId, operationId, suffix });
}

function seedOperation({ workspaceId, authorityId, accountId, operationId, suffix }) {
  const result = psql(`
    DO $seed$
    DECLARE base jsonb; projection jsonb; digest text; usage jsonb;
    BEGIN
      base := jsonb_build_object(
        'schemaVersion','generic-operation-projection/v1','kind','tool',
        'schema','task2-result/v1','data',jsonb_build_object('status','ok-${suffix}')
      );
      digest := generic_operation_projection_digest(base);
      projection := base || jsonb_build_object('digest',digest);
      usage := jsonb_build_object(
        'currency','USD','unit','microusd','callCount',1,'inputTokens',1,
        'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100'
      );
      INSERT INTO tool_budget_operation(
        id,scope_key,account_id,generation,operation_key,amount_unit,
        reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,
        receipt_usage,receipt_cost_basis,settled_at,created_at
      ) VALUES (
        '${operationId}','${workspaceId}','${accountId}',1,'task2-operation-${suffix}',
        'microusd',0,100,50,50,'generic-operation-projection/v1',
        'task2-result/v1',digest,projection,'SETTLED',usage,'token_pricing',now(),now()
      );
      UPDATE tool_budget_account SET charged_microusd=charged_microusd+50
        WHERE id='${accountId}';
    END $seed$;
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id','${workspaceId}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1(
      '${workspaceId}','${operationId}','Task2Consumer${suffix}','Task2Aggregate',
      repeat('3',64),repeat('4',64)
    );
    COMMIT;
  `).split("\n").filter((line) => line.startsWith("{"));
  const ack = JSON.parse(result.at(-1));
  return {
    workspaceId, authorityId, accountId, operationId, generation: 1,
    ackId: ack.ackId, resultDigest: ack.resultDigest,
  };
}

function invocation(functionName, facts, overrides = {}) {
  const input = {
    ...facts,
    rootSubjectType: "tool_operation", rootSubjectId: facts.operationId,
    rootDataClass: "NON_PERSONAL", rootDsrSubjectType: null,
    rootDsrSubjectId: null, parentId: null,
    childType: "materialized_record", childId: CHILD_A,
    childDataClass: "NON_PERSONAL", childDsrSubjectType: null,
    childDsrSubjectId: null, relationKey: "record:0",
    relationKind: "MATERIALIZED_CHILD", sourceNamespace: "source_record",
    sourceUuid: SOURCE_A, sourceSha256: null, contractSha256: CONTRACT_A,
    ...overrides,
  };
  const uuid = (value) => value === null ? "NULL::uuid" : `'${value}'::uuid`;
  const text = (value, type) => value === null ? `NULL::${type}` : `'${value}'::${type}`;
  return `public.${functionName}(
    ${uuid(input.workspaceId)},${uuid(input.authorityId)},${uuid(input.accountId)},
    ${uuid(input.operationId)},${input.generation},${text(input.ackId,"char(64)")},
    ${text(input.resultDigest,"char(64)")},${text(input.rootSubjectType,"varchar(191)")},
    ${uuid(input.rootSubjectId)},${text(input.rootDataClass,"varchar(16)")},
    ${text(input.rootDsrSubjectType,"varchar(191)")},${uuid(input.rootDsrSubjectId)},
    ${uuid(input.parentId)},${text(input.childType,"varchar(191)")},${uuid(input.childId)},
    ${text(input.childDataClass,"varchar(16)")},
    ${text(input.childDsrSubjectType,"varchar(191)")},${uuid(input.childDsrSubjectId)},
    ${text(input.relationKey,"varchar(200)")},${text(input.relationKind,"varchar(32)")},
    ${text(input.sourceNamespace,"varchar(64)")},${uuid(input.sourceUuid)},
    ${text(input.sourceSha256,"char(64)")},${text(input.contractSha256,"char(64)")}
  )`;
}

function selectCall(functionName, facts, overrides = {}) {
  return `SELECT operation_subject_id::text,parent_subject_id::text,
    child_subject_id::text,relation_id::text,replay
    FROM ${invocation(functionName, facts, overrides)};`;
}

function canonicalSnapshot() {
  return psql(`
    SELECT jsonb_build_object(
      'authority',(SELECT jsonb_agg(jsonb_build_array(id::text,scope_key,
        authority_kind::text,workspace_id::text,purpose::text,subject_type,
        subject_id,revoked_at IS NOT NULL) ORDER BY id)
        FROM execution_budget_authority WHERE workspace_id IN ('${WS_A}','${WS_B}')),
      'accounts',(SELECT jsonb_agg(jsonb_build_array(id::text,scope_key,generation,
        authority_id::text,authorized_cap_microusd,reserved_microusd,
        charged_microusd,ref_count,exhausted,closed_at IS NOT NULL) ORDER BY id)
        FROM tool_budget_account WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'operations',(SELECT jsonb_agg(jsonb_build_array(id::text,scope_key,
        account_id::text,generation,operation_key,status::text,result_schema_version,
        result_schema,result_digest,receipt_usage,receipt_cost_basis) ORDER BY id)
        FROM tool_budget_operation WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'acks',(SELECT jsonb_agg(ack_json ORDER BY ack_id) FROM execution_domain_ack
        WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'subjects',(SELECT jsonb_agg(to_jsonb(s)-'created_at' ORDER BY id)
        FROM governed_subject s),
      'operationSubjects',(SELECT jsonb_agg(to_jsonb(s)-'created_at' ORDER BY subject_id)
        FROM tool_operation_subject s),
      'relations',(SELECT jsonb_agg(to_jsonb(r)-'created_at' ORDER BY id)
        FROM governed_subject_relation r),
      'tombstones',(SELECT jsonb_agg(to_jsonb(t)-'tombstoned_at' ORDER BY governed_subject_id)
        FROM governed_subject_tombstone t),
      'artifactTombstones',(SELECT jsonb_agg(to_jsonb(t)-'tombstoned_at'
        ORDER BY workspace_id,subject_type,subject_id)
        FROM generic_operation_artifact_subject_tombstone t)
    )::text;
  `);
}

function captureFailure(functionName, facts, overrides, expectedCode) {
  const before = canonicalSnapshot();
  const captured = psql(`
    BEGIN;
    CREATE TEMP TABLE error_capture(state text,message text) ON COMMIT DROP;
    DO $capture$
    DECLARE state text; message text;
    BEGIN
      BEGIN
        PERFORM * FROM ${invocation(functionName, facts, overrides)};
        INSERT INTO error_capture VALUES ('00000','NO_ERROR');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
        INSERT INTO error_capture VALUES (state,message);
      END;
    END $capture$;
    SELECT state||'|'||message FROM error_capture;
    COMMIT;
  `).split("\n").at(-1);
  assert.equal(captured, `P0001|${expectedCode}`);
  assert.ok(captured.length <= 96);
  assert.doesNotMatch(captured, /@|email|phone|token|secret|prompt|response/i);
  assert.equal(canonicalSnapshot(), before);
}

function parseRow(output) {
  const row = output.split("\n").at(-1)?.split("|");
  assert.equal(row?.length, 5);
  return row;
}

describe("governed relation append/attest database contract", () => {
  before(() => {
    assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global");
  });

  beforeEach(() => {
    resetDatabase();
    factsA = seedAuthority({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_A, suffix: "01",
    });
    factsB = seedAuthority({
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
    const rows = psql(`
      SELECT proname||E'\\t'||pg_get_function_identity_arguments(oid)||E'\\t'
        ||pg_get_function_result(oid)||E'\\t'||provolatile::text||E'\\t'
        ||prosecdef::text||E'\\t'||pg_get_userbyid(proowner)||E'\\t'
        ||COALESCE(array_to_string(proconfig,','),'')
      FROM pg_proc WHERE pronamespace='public'::regnamespace
        AND proname IN ('${APPEND}','${ATTEST}') ORDER BY proname;
    `).split("\n").filter(Boolean);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const [name,args,result,volatility,security,owner,config] = row.split("\t");
      assert.equal(compact(args), compact(ARGUMENTS));
      assert.equal(compact(result), "table(operation_subject_id uuid, parent_subject_id uuid, child_subject_id uuid, relation_id uuid, replay boolean)");
      assert.equal(volatility, "v");
      assert.equal(security, "true");
      assert.equal(owner, "global");
      assert.equal(config, "search_path=pg_catalog, public");
      const acl = psql(`SELECT COALESCE(jsonb_agg(jsonb_build_array(
        grantor::regrole::text,grantee::regrole::text,privilege_type,is_grantable
      ) ORDER BY grantee,privilege_type),'[]')::text
      FROM pg_proc p LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
      WHERE p.oid='public.${name}(${ARGUMENTS.split(',').map((arg) => arg.trim().split(' ').slice(1).join(' ')).join(',')})'::regprocedure;`);
      assert.equal(acl, '[["global", "app_user", "EXECUTE", false]]');
    }
    for (const table of TABLES) {
      const acl = psql(`SELECT COALESCE(jsonb_agg(jsonb_build_array(
        grantor::regrole::text,grantee::regrole::text,privilege_type,is_grantable
      ) ORDER BY grantee,privilege_type),'[]')::text
      FROM pg_class c LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
      WHERE c.oid='public.${table}'::regclass
        AND a.grantee::regrole::text IN (${MANAGED_ROLES.map((role) => `'${role}'`).join(",")});`);
      assert.equal(acl, "[]");
    }
    const helperLeak = psql(`SELECT count(*) FROM pg_proc p
      JOIN LATERAL aclexplode(p.proacl) a ON true
      WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE '\\_%'
        AND a.grantee::regrole::text IN (${MANAGED_ROLES.map((r) => `'${r}'`).join(',')});`);
    assert.equal(helperLeak, "0");
  });

  it("catalog mutation probes reject invoker/STABLE/dynamic-write helpers", () => {
    const row = psql(`BEGIN;
      CREATE SCHEMA task2_mutation;
      CREATE FUNCTION task2_mutation.bad_helper() RETURNS void LANGUAGE plpgsql
        STABLE SECURITY INVOKER AS $$ BEGIN EXECUTE 'UPDATE x SET y=1'; END $$;
      SELECT provolatile::text||'|'||prosecdef::text||'|'
        ||(pg_get_functiondef(oid) ~* '\\mexecute\\M')::text
      FROM pg_proc WHERE pronamespace='task2_mutation'::regnamespace;
      ROLLBACK;`);
    assert.equal(row, "s|false|true");
  });

  it("denies SET ROLE and temp shadow substitution", () => {
    const denied = rawPsql(asApp("SET ROLE global;", WS_A));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /permission denied to set role/i);
    const shadow = rawPsql(asApp(`CREATE FUNCTION pg_temp.${APPEND}() RETURNS text
      LANGUAGE sql AS $$ SELECT 'shadow' $$;
      ${selectCall(APPEND, factsA)}`, WS_A));
    assert.notEqual(shadow.status, 0);
    assert.doesNotMatch(shadow.stdout, /shadow/);
  });

  it("missing attest before append fails inside READ ONLY without any canonical mutation", () => {
    const before = canonicalSnapshot();
    const attempt = rawPsql(asApp(selectCall(ATTEST, factsA), WS_A, true));
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE/);
    assert.equal(canonicalSnapshot(), before);
  });

  it("appends, exact-replays and attests 100x with a byte-stable canonical snapshot", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, factsA), WS_A)));
    assert.equal(first[4], "f");
    const replay = parseRow(psql(asApp(selectCall(APPEND, factsA), WS_A)));
    assert.deepEqual(replay.slice(0,4), first.slice(0,4));
    assert.equal(replay[4], "t");
    const before = canonicalSnapshot();
    const statements = Array.from({ length: 100 }, () => selectCall(ATTEST, factsA)).join("\n");
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
    const vectors = [
      [APPEND, factsA, { authorityId: factsB.authorityId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { accountId: factsB.accountId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { generation: 2 }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { operationId: factsB.operationId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { ackId: factsB.ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { resultDigest: factsB.resultDigest }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { rootSubjectType: "other" }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { rootSubjectId: CHILD_A }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
      [APPEND, factsA, { sourceUuid: null, sourceSha256: null }, "GOVERNED_SUBJECT_RELATION_INVALID"],
      [APPEND, factsA, { sourceUuid: SOURCE_A, sourceSha256: CONTRACT_A }, "GOVERNED_SUBJECT_RELATION_INVALID"],
      [APPEND, factsA, { workspaceId: WS_B }, "GOVERNED_OPERATION_SUBJECT_INVALID"],
    ];
    for (const [fn,facts,override,code] of vectors) captureFailure(fn,facts,override,code);
  });

  it("keeps revocation isolated and never resurrects the same authority", () => {
    psql(asApp(`INSERT INTO execution_budget_authority_revocation(scope_key,authority_id,reason,revoked_at)
      VALUES ('${WS_A}','${AUTH_A}','task2-revoked',now());`, WS_A));
    captureFailure(APPEND, factsA, {}, "GOVERNED_SUBJECT_AUTHORITY_REVOKED");
    captureFailure(ATTEST, factsA, {}, "GOVERNED_SUBJECT_AUTHORITY_REVOKED");
    assert.equal(psql(`SELECT count(*) FROM execution_budget_authority_revocation
      WHERE authority_id='${AUTH_A}';`), "1");
  });

  it("enforces basic reachable parent, self, cycle and other-operation parent rules", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, factsA), WS_A)));
    const childInternal = first[2];
    const second = parseRow(psql(asApp(selectCall(APPEND, factsA, {
      parentId: childInternal, childId: CHILD_B, relationKey: "record:1",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
      contractSha256: CONTRACT_B,
    }), WS_A)));
    assert.equal(second[1], childInternal);
    const otherFacts = seedOperation({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_A2, suffix: "11",
    });
    const other = parseRow(psql(asApp(selectCall(APPEND, otherFacts, {
      childId: "51000000-0000-4000-8000-000000000011", relationKey: "other:0",
    }), WS_A)));
    captureFailure(APPEND, factsA, { parentId: other[2], relationKey: "bad:other" }, "GOVERNED_SUBJECT_RELATION_INVALID");
    captureFailure(APPEND, factsA, { parentId: childInternal, relationKey: "bad:self" }, "GOVERNED_SUBJECT_RELATION_INVALID");
    captureFailure(APPEND, factsA, {
      parentId: second[2], childId: CHILD_A, relationKey: "bad:cycle",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
    }, "GOVERNED_SUBJECT_RELATION_INVALID");
  });

  it("blocks root/parent/child Task1 tombstones and PERSONAL artifact tombstones", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, factsA), WS_A)));
    for (const governedSubjectId of [first[0], first[1], first[2]]) {
      psql(`INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id)
        VALUES ('${WS_A}','${governedSubjectId}');`);
      captureFailure(ATTEST, factsA, {}, "GOVERNED_SUBJECT_TOMBSTONED");
      psql(`DELETE FROM governed_subject_tombstone
        WHERE workspace_id='${WS_A}' AND governed_subject_id='${governedSubjectId}';`);
    }
    resetDatabase();
    factsA = seedAuthority({ workspaceId: WS_A, authorityId: AUTH_A,
      accountId: ACCOUNT_A, operationId: OP_A, suffix: "01" });
    factsB = seedAuthority({ workspaceId: WS_B, authorityId: AUTH_B,
      accountId: ACCOUNT_B, operationId: OP_B, suffix: "02" });
    psql(`INSERT INTO generic_operation_artifact_subject_tombstone(
      workspace_id,subject_type,subject_id,tombstoned_at
    ) VALUES ('${WS_A}','company','71000000-0000-4000-8000-000000000001',now());`);
    captureFailure(APPEND, factsA, {
      childDataClass: "PERSONAL", childDsrSubjectType: "company",
      childDsrSubjectId: "71000000-0000-4000-8000-000000000001",
    }, "GOVERNED_SUBJECT_TOMBSTONED");
  });
});
