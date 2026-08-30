import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

const container = "codex-task6b-identity-authority-pg-20260830-a";
const database = "postgres";
const WORKSPACE_A = "41000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "41000000-0000-4000-8000-000000000002";
const SOURCE = "41100000-0000-4000-8000-000000000001";
const ENTITY = "41200000-0000-4000-8000-000000000001";
const RAW_A = "42000000-0000-4000-8000-000000000001";
const RAW_B = "42000000-0000-4000-8000-000000000002";
const COMPANY_A = "43000000-0000-4000-8000-000000000001";
const COMPANY_B = "43000000-0000-4000-8000-000000000002";
const COMPANY_C = "43000000-0000-4000-8000-000000000003";
const COMPANY_D = "43000000-0000-4000-8000-000000000004";
const COMPANY_FORGED = "43000000-0000-4000-8000-000000000009";
const CONFLICT = "44000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RESOLVER = "organization-identity-resolver/v1";
const INPUT_CREATE =
  "8638cec96b556622eaf916aa938fae169212fd93970b612882fade652d9e3286";
const INPUT_LAZY =
  "3513f6579b2a37dc9e1863ae6abbbbd96a259dbec1cbb8c021fd2c7fea5181e4";
const INPUT_BIND =
  "514e8f8a32eacddb644b897c2fa7a055264d3f7c6045f7ff8e75c492a27596ea";
const INPUT_DISAGREEMENT_A =
  "65a54c4e1fad9635c9e2515487dc30867777260c2510669768f0766475cfa6db";
const INPUT_DISAGREEMENT_B =
  "fdedd3b2b7a1d87dc7e3f4e358ad45947f2c73508654a3c7f67b966186f57d7a";
const INPUT_SPLIT =
  "75f269ad13cb3accd3eec51bc2d37408dca6e1cd6e3be6afaedc7ba875da5482";
const INPUT_SPLIT_ROOTS =
  "c0ac10962197d9e4af78714ee2d4eabd1e4a3d228b4b1a2e34093245459148d2";
const INPUT_BIND_ROOT =
  "000c18eddad729f819d1ad546390dc7a701177e07e55fe1ac159fe132821b7b4";
const FINGERPRINT_DISAGREEMENT =
  "1001eb0a5164bbe8a67227430184a33e96c63dce3dbc1117d1cd582d4214e680";
const FINGERPRINT_SPLIT =
  "d3a3b92142a380eec8aa9c48444472f50efe8dcf3d0ef3e2a87ab9f87ec2898f";
const FINGERPRINT_SPLIT_ROOTS =
  "029b8e60b7821c12cfa8c721ae9fe572e6c4aaf5f6a804081a693a657684f3dd";

const RAW_CREATE = Object.freeze({
  id: RAW_A,
  providerKey: "registry",
  payloadHash: HASH_A,
  ingestVersion: "raw-source/v2",
  ingestStatus: "ACCEPTED",
  payload: {
    name: "A4 Create GmbH",
    country: "DE",
    identifier: { scheme: "registry-id", value: "DE1234" },
  },
});
const RAW_CREATE_B = Object.freeze({ ...RAW_CREATE, id: RAW_B });
const RAW_LAZY = Object.freeze({
  id: RAW_A,
  providerKey: "directory",
  payloadHash: HASH_A,
  ingestVersion: "raw-source/v2",
  ingestStatus: "ACCEPTED",
  payload: { name: "A4 Lazy GmbH", country: "DE" },
});
const RAW_SPLIT = Object.freeze({
  id: RAW_A,
  providerKey: "registry",
  payloadHash: HASH_A,
  ingestVersion: "raw-source/v2",
  ingestStatus: "ACCEPTED",
  payload: {
    name: "A4 Split GmbH",
    domain: "a4-split.example",
    country: "DE",
    identifier: { scheme: "registry-id", value: "DE9999" },
  },
});

const COMPANY_A_BASE = Object.freeze({
  id: COMPANY_A,
  name: "A4 Root A",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 root a:de",
  version: 1,
});
const COMPANY_B_BLOCKER = Object.freeze({
  id: COMPANY_B,
  name: "A4 Create GmbH",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 create:de",
  version: 1,
});
const COMPANY_C_ROOT = Object.freeze({
  id: COMPANY_C,
  name: "A4 Root C",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 root c:de",
  version: 1,
});
const COMPANY_D_ROOT = Object.freeze({
  id: COMPANY_D,
  name: "A4 Root D",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 root d:de",
  version: 1,
});
const COMPANY_LAZY = Object.freeze({
  ...COMPANY_A_BASE,
  name: "A4 Lazy GmbH",
  dedupeKey: "n:a4 lazy:de",
});
const COMPANY_CREATE_RESULT = Object.freeze({
  id: COMPANY_C,
  name: "A4 Create GmbH",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 create:de",
  version: 1,
});
const COMPANY_FORGED_STATE = Object.freeze({
  id: COMPANY_FORGED,
  name: "A4 Forged Target",
  domain: null,
  country: "DE",
  status: "NEW",
  dedupeKey: "n:a4 forged target:de",
  version: 1,
});

const REGISTRY_IDENTIFIER_A = Object.freeze({
  companyId: COMPANY_A,
  scheme: "registry-id",
  jurisdiction: "DE",
  normalizedValue: "DE1234",
  authorityProviderKey: "registry",
  rawRecordId: RAW_A,
  conflictId: null,
  confidence: 1,
  normalizerVersion: "organization-identity-authority/v1",
  validatorVersion: "registry-id-v1",
  provenance: { schemaVersion: "organization-identifier-provenance/v1" },
  status: "ACTIVE",
});
const DOMAIN_IDENTIFIER_A = Object.freeze({
  ...REGISTRY_IDENTIFIER_A,
  scheme: "domain",
  jurisdiction: "GLOBAL",
  normalizedValue: "a4-split.example",
  validatorVersion: "domain-v1",
});
const REGISTRY_IDENTIFIER_B = Object.freeze({
  ...REGISTRY_IDENTIFIER_A,
  companyId: COMPANY_B,
  normalizedValue: "DE9999",
});
const CREATED_REGISTRY_IDENTIFIER_C = Object.freeze({
  ...REGISTRY_IDENTIFIER_A,
  companyId: COMPANY_C,
  provenance: {
    schemaVersion: "organization-identifier-provenance/v1",
    rawRecordId: RAW_A,
    providerKey: "registry",
  },
});

function state({
  raws = [],
  companies = [],
  identifiers = [],
  conflicts = [],
  parties = [],
  links = [],
  mappings = [],
  suppressions = [],
} = {}) {
  return {
    raws,
    companies,
    identifiers,
    conflicts,
    parties,
    links,
    mappings,
    suppressions,
  };
}

const EMPTY_CROSS = Object.freeze({
  raws: 0,
  companies: 0,
  identifiers: 0,
  conflicts: 0,
  parties: 0,
  links: 0,
  mappings: 0,
  suppressions: 0,
});

function rawView(raw) {
  return {
    id: raw.id,
    providerKey: raw.providerKey,
    payloadHash: raw.payloadHash,
    ingestVersion: raw.ingestVersion,
    ingestStatus: raw.ingestStatus,
  };
}

function sqlJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function fixtureSql({
  raws,
  companies = [],
  identifiers = [],
  conflicts = [],
  parties = [],
  links = [],
  mappings = [],
  suppressions = [],
  bypassTriggers = false,
  extraSql = "",
}) {
  const rawRows = raws
    .map(
      (raw) => `('${raw.id}','${WORKSPACE_A}','${ENTITY}',
        '${raw.providerKey}','company_registry','${sqlJson(raw.payload)}'::jsonb,
        'https://fixture.invalid/${raw.id}',now(),'${HASH_B}','a4/v1',
        'a4:${raw.id}','${raw.payloadHash}',1,'${raw.ingestVersion}',
        '${raw.ingestStatus}',30,now()+interval '30 days','{}'::jsonb,now())`,
    )
    .join(",\n");
  const companyRows = companies
    .map(
      (row) => `('${row.id}','${WORKSPACE_A}','${row.name}',${
        row.domain === null ? "NULL" : `'${row.domain}'`
      },${row.country === null ? "NULL" : `'${row.country}'`},
        '${row.status}','${row.dedupeKey}',${row.version},now(),now())`,
    )
    .join(",\n");
  const identifierRows = identifiers
    .map(
      (row) => `('${WORKSPACE_A}','${row.companyId}','${row.scheme}',
        '${row.jurisdiction}','${row.normalizedValue}',
        '${row.authorityProviderKey}','${row.rawRecordId}',
        ${row.conflictId === null ? "NULL" : `'${row.conflictId}'`},
        ${row.confidence},'${row.normalizerVersion}','${row.validatorVersion}',
        '${sqlJson(row.provenance)}'::jsonb,'${row.status}')`,
    )
    .join(",\n");
  const conflictRows = conflicts
    .map(
      (row) => `('${row.id}','${WORKSPACE_A}',${
        row.rawRecordId === null ? "NULL" : `'${row.rawRecordId}'`
      },'${row.conflictType}','${row.fingerprint}','${row.status}',
        ${row.revision},'${sqlJson(row.facts)}'::jsonb,
        ${row.status === "RESOLVED" ? "now()" : "NULL"},now())`,
    )
    .join(",\n");
  const partyRows = parties
    .map(
      (row) => `('${WORKSPACE_A}','${row.conflictId}',
        '${row.companyId}','${row.role}',now())`,
    )
    .join(",\n");
  const linkRows = links
    .map(
      (row, index) => `('46000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        "0",
      )}','${WORKSPACE_A}','company','${row.canonicalId}',
        '${row.rawRecordId}','${row.matchRule}',${row.confidence},
        '${row.status}','${row.resolverVersion}','${row.inputHash}',
        ${row.conflictId === null ? "NULL" : `'${row.conflictId}'`})`,
    )
    .join(",\n");
  const mappingRows = mappings
    .map(
      (row, index) => `('47000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        "0",
      )}','${WORKSPACE_A}','${row.sourceCompanyId}',
        '${row.canonicalCompanyId}','${row.status}',${row.revision},
        '48000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}',NULL,now(),NULL)`,
    )
    .join(",\n");
  const suppressionRows = suppressions
    .map(
      (row, index) => `('49000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        "0",
      )}','${WORKSPACE_A}','${row.type}','${row.value}',
        'a4-test','${row.protectionClass}')`,
    )
    .join(",\n");
  return `INSERT INTO workspace(id,name,updated_at) VALUES
      ('${WORKSPACE_A}','A4 Workspace A',now()),
      ('${WORKSPACE_B}','A4 Workspace B',now());
    INSERT INTO monitored_source(
      id,provider_key,source_key,label,config,status,created_at,updated_at
    ) VALUES ('${SOURCE}','registry','a4:source','A4 Source','{}','ACTIVE',now(),now());
    INSERT INTO source_entity(
      id,source_id,external_id,entity_kind,name,cleaned,content_hash,
      created_at,updated_at
    ) VALUES ('${ENTITY}','${SOURCE}','a4-entity','company','A4 Entity',
      '{}','${HASH_A}',now(),now());
    INSERT INTO raw_source_record(
      id,workspace_id,source_entity_id,provider_key,source_class,payload,
      source_url,fetched_at,content_hash,parser_version,ingest_key,
      payload_hash,payload_bytes,ingest_version,ingest_status,
      retention_days,expires_at,source_policy_snapshot,created_at
    ) VALUES ${rawRows};
    ${
      companyRows === ""
        ? ""
        : `INSERT INTO canonical_company(
      id,workspace_id,name,domain,country,status,dedupe_key,version,
      created_at,updated_at
    ) VALUES ${companyRows};`
    }
    ${bypassTriggers ? "SET LOCAL session_replication_role='replica';" : ""}
    ${
      conflictRows === ""
        ? ""
        : `INSERT INTO organization_identity_conflict(
      id,workspace_id,raw_record_id,conflict_type,fingerprint,status,
      revision,facts,resolved_at,created_at
    ) VALUES ${conflictRows};`
    }
    ${
      identifierRows === ""
        ? ""
        : `INSERT INTO organization_identifier(
      workspace_id,company_id,scheme,jurisdiction,normalized_value,
      authority_provider_key,raw_record_id,conflict_id,confidence,
      normalizer_version,validator_version,provenance,status
    ) VALUES ${identifierRows};`
    }
    ${
      partyRows === ""
        ? ""
        : `INSERT INTO organization_identity_conflict_party(
      workspace_id,conflict_id,company_id,role,created_at
    ) VALUES ${partyRows};`
    }
    ${
      linkRows === ""
        ? ""
        : `INSERT INTO identity_link(
      id,workspace_id,canonical_type,canonical_id,raw_record_id,
      match_rule,confidence,status,resolver_version,input_hash,conflict_id
    ) VALUES ${linkRows};`
    }
    ${
      mappingRows === ""
        ? ""
        : `INSERT INTO organization_canonical_mapping(
      id,workspace_id,source_company_id,canonical_company_id,status,
      revision,merge_decision_id,split_decision_id,created_at,revoked_at
    ) VALUES ${mappingRows};`
    }
    ${
      suppressionRows === ""
        ? ""
        : `INSERT INTO suppression_record(
      id,workspace_id,type,value,reason,protection_class
    ) VALUES ${suppressionRows};`
    }
    ${bypassTriggers ? "SET LOCAL session_replication_role='origin';" : ""}
    ${extraSql}`;
}

function stateSql(workspaceId) {
  const array = (query) => `coalesce((${query}),'[]'::jsonb)`;
  return `jsonb_build_object(
    'raws',${array(`SELECT jsonb_agg(jsonb_build_object(
      'id',id::text,'providerKey',provider_key,'payloadHash',payload_hash::text,
      'ingestVersion',ingest_version,'ingestStatus',ingest_status
    ) ORDER BY id) FROM raw_source_record WHERE workspace_id='${workspaceId}'`)},
    'companies',${array(`SELECT jsonb_agg(jsonb_build_object(
      'id',id::text,'name',name,'domain',domain,'country',country,
      'status',status,'dedupeKey',dedupe_key,'version',version
    ) ORDER BY id) FROM canonical_company WHERE workspace_id='${workspaceId}'`)},
    'identifiers',${array(`SELECT jsonb_agg(jsonb_build_object(
      'companyId',company_id::text,'scheme',scheme,'jurisdiction',jurisdiction,
      'normalizedValue',normalized_value,'authorityProviderKey',authority_provider_key,
      'rawRecordId',raw_record_id::text,'conflictId',conflict_id::text,
      'confidence',confidence,'normalizerVersion',normalizer_version,
      'validatorVersion',validator_version,'provenance',provenance,'status',status
    ) ORDER BY scheme,jurisdiction,normalized_value,company_id)
    FROM organization_identifier WHERE workspace_id='${workspaceId}'`)},
    'conflicts',${array(`SELECT jsonb_agg(jsonb_build_object(
      'id',id::text,'rawRecordId',raw_record_id::text,'conflictType',conflict_type,
      'fingerprint',fingerprint,'status',status,'revision',revision,'facts',facts
    ) ORDER BY id) FROM organization_identity_conflict
    WHERE workspace_id='${workspaceId}'`)},
    'parties',${array(`SELECT jsonb_agg(jsonb_build_object(
      'conflictId',conflict_id::text,'companyId',company_id::text,'role',role
    ) ORDER BY conflict_id,company_id,role) FROM organization_identity_conflict_party
    WHERE workspace_id='${workspaceId}'`)},
    'links',${array(`SELECT jsonb_agg(jsonb_build_object(
      'canonicalId',canonical_id::text,'rawRecordId',raw_record_id::text,
      'matchRule',match_rule,'confidence',confidence,'status',status,
      'resolverVersion',resolver_version,'inputHash',input_hash,
      'conflictId',conflict_id::text
    ) ORDER BY raw_record_id,canonical_id,status) FROM identity_link
    WHERE workspace_id='${workspaceId}'`)},
    'mappings',${array(`SELECT jsonb_agg(jsonb_build_object(
      'sourceCompanyId',source_company_id::text,
      'canonicalCompanyId',canonical_company_id::text,
      'status',status,'revision',revision
    ) ORDER BY source_company_id) FROM organization_canonical_mapping
    WHERE workspace_id='${workspaceId}'`)},
    'suppressions',${array(`SELECT jsonb_agg(jsonb_build_object(
      'type',type,'value',value,'protectionClass',protection_class
    ) ORDER BY type,value) FROM suppression_record
    WHERE workspace_id='${workspaceId}'`)}
  )`;
}

function crossSql() {
  return `jsonb_build_object(
    'raws',(SELECT count(*) FROM raw_source_record WHERE workspace_id='${WORKSPACE_B}'),
    'companies',(SELECT count(*) FROM canonical_company WHERE workspace_id='${WORKSPACE_B}'),
    'identifiers',(SELECT count(*) FROM organization_identifier WHERE workspace_id='${WORKSPACE_B}'),
    'conflicts',(SELECT count(*) FROM organization_identity_conflict WHERE workspace_id='${WORKSPACE_B}'),
    'parties',(SELECT count(*) FROM organization_identity_conflict_party WHERE workspace_id='${WORKSPACE_B}'),
    'links',(SELECT count(*) FROM identity_link WHERE workspace_id='${WORKSPACE_B}'),
    'mappings',(SELECT count(*) FROM organization_canonical_mapping WHERE workspace_id='${WORKSPACE_B}'),
    'suppressions',(SELECT count(*) FROM suppression_record WHERE workspace_id='${WORKSPACE_B}')
  )`;
}

function runScenario(scenario) {
  const sql = `BEGIN;
    ${fixtureSql(scenario.fixture)}
    CREATE TEMP TABLE a4_observed(
      stage text PRIMARY KEY,value jsonb NOT NULL
    ) ON COMMIT DROP;
    GRANT SELECT,INSERT ON a4_observed TO app_user;
    SET SESSION AUTHORIZATION app_user;
    SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
    INSERT INTO a4_observed VALUES ('preA',${stateSql(WORKSPACE_A)});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
    INSERT INTO a4_observed VALUES ('preB',${crossSql()});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
    DO $a4_call$
    DECLARE resolved jsonb;
    BEGIN
      SELECT jsonb_agg(to_jsonb(row)) INTO resolved
      FROM public.resolve_organization_identity_for_raw_v1(
        '${WORKSPACE_A}','${scenario.rawRecordId ?? RAW_A}'
      ) AS row;
      INSERT INTO a4_observed VALUES (
        'outcome',jsonb_build_object('kind','result','rows',resolved)
      );
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO a4_observed VALUES (
        'outcome',jsonb_build_object(
          'kind','error','sqlstate',SQLSTATE,'message',SQLERRM
        )
      );
    END
    $a4_call$;
    INSERT INTO a4_observed VALUES ('postA',${stateSql(WORKSPACE_A)});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
    INSERT INTO a4_observed VALUES ('postB',${crossSql()});
    SELECT jsonb_object_agg(stage,value ORDER BY stage)::text FROM a4_observed;
    ROLLBACK;`;
  const startedAt = Date.now();
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "global",
      "-d",
      database,
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      encoding: "utf8",
      input: sql,
      timeout: scenario.processTimeout ?? 10_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.startsWith("{"));
  assert.ok(line, `scenario emitted no JSON readback:\n${result.stdout}`);
  return { observed: JSON.parse(line), elapsedMs: Date.now() - startedAt };
}

function error(sqlstate, message) {
  return { kind: "error", sqlstate, message };
}

function resultRow(row) {
  return { kind: "result", rows: [row] };
}

function assertScenario(scenario) {
  const { observed, elapsedMs } = runScenario(scenario);
  assert.deepEqual(observed.preA, scenario.expectedPre);
  assert.deepEqual(observed.preB, EMPTY_CROSS);
  const actual = {
    outcome: observed.outcome,
    state: observed.postA,
    crossWorkspace: observed.postB,
  };
  const expected = {
    outcome: scenario.expectedOutcome,
    state: scenario.expectedPost,
    crossWorkspace: EMPTY_CROSS,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    assert.fail(
      [
        "A4_EXPECTED_BEHAVIOR_MISMATCH",
        `actual=${JSON.stringify(actual.outcome)}`,
        `desired=${JSON.stringify(expected.outcome)}`,
        `stateExact=${isDeepStrictEqual(actual.state, expected.state)}`,
        `crossWorkspaceExact=${isDeepStrictEqual(
          actual.crossWorkspace,
          expected.crossWorkspace,
        )}`,
      ].join("|"),
    );
  }
  return elapsedMs;
}

function boundResult({
  rawRecordId = RAW_A,
  companyId,
  matchRule,
  inputHash,
  replayed = false,
  companyCreated = false,
  identifierCount = 0,
}) {
  return resultRow({
    outcome_kind: "bound",
    raw_record_id: rawRecordId,
    company_id: companyId,
    conflict_id: null,
    match_rule: matchRule,
    input_hash: inputHash,
    conflict_fingerprint: null,
    replayed,
    company_created: companyCreated,
    identifier_count: identifierCount,
    party_count: 0,
  });
}

function conflictFacts({
  blockerKey = "n:a4 create:de",
  blockerRule = "name_country",
  conflictType = "blocking_key_disagreement",
  companyIds = [COMPANY_A, COMPANY_B],
  identifierKeys = ["registry-id:DE:DE1234"],
} = {}) {
  return {
    schemaVersion: "organization-identity-conflict/v1",
    resolverVersion: RESOLVER,
    blockerKey,
    blockerRule,
    conflictType,
    companyIds,
    identifierKeys,
  };
}

function conflictState({
  rawRecordId = RAW_A,
  conflictType = "blocking_key_disagreement",
  fingerprint = FINGERPRINT_DISAGREEMENT,
  status = "OPEN",
  revision = 1,
  facts = conflictFacts(),
} = {}) {
  return {
    id: CONFLICT,
    rawRecordId,
    conflictType,
    fingerprint,
    status,
    revision,
    facts,
  };
}

function conflictResult({
  rawRecordId = RAW_A,
  inputHash = INPUT_DISAGREEMENT_A,
  fingerprint = FINGERPRINT_DISAGREEMENT,
  replayed = false,
  partyCount = 2,
} = {}) {
  return resultRow({
    outcome_kind: "conflict",
    raw_record_id: rawRecordId,
    company_id: null,
    conflict_id: CONFLICT,
    match_rule: "identity_conflict",
    input_hash: inputHash,
    conflict_fingerprint: fingerprint,
    replayed,
    company_created: false,
    identifier_count: 0,
    party_count: partyCount,
  });
}

function link({
  canonicalId = COMPANY_A,
  rawRecordId = RAW_A,
  matchRule = "identity_v2",
  confidence = 1,
  status = "ACTIVE",
  resolverVersion = RESOLVER,
  inputHash = INPUT_BIND,
  conflictId = null,
} = {}) {
  return {
    canonicalId,
    rawRecordId,
    matchRule,
    confidence,
    status,
    resolverVersion,
    inputHash,
    conflictId,
  };
}

function party(companyId, role = "CANDIDATE") {
  return { conflictId: CONFLICT, companyId, role };
}

function mapping(sourceCompanyId, canonicalCompanyId) {
  return { sourceCompanyId, canonicalCompanyId, status: "ACTIVE", revision: 1 };
}

function deterministicIdTrigger(table, column, whenSql, id) {
  return `CREATE FUNCTION pg_temp.a4_force_id() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF ${whenSql} THEN NEW.${column}:='${id}'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_force_id BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_force_id();`;
}

function faultTrigger(table, sqlstate, message) {
  return `CREATE FUNCTION pg_temp.a4_fault() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION '${message}' USING ERRCODE='${sqlstate}';
    END $$;
    CREATE TRIGGER a4_fault BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_fault();`;
}

function startHolder(statement) {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "global",
      "-d",
      database,
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let releaseStarted = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise;
    readyReject = rejectPromise;
  });
  const completion = new Promise((resolvePromise) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!readySettled && stdout.includes("A4_HOLDER_READY")) {
        readySettled = true;
        readyResolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      if (!readySettled) {
        readySettled = true;
        readyReject(cause);
      }
    });
    child.on("close", (code) => {
      if (!readySettled) {
        readySettled = true;
        readyReject(
          new Error(`holder closed before ready (${code}): ${stderr}`),
        );
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
  const acquisitionTimer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      child.kill("SIGTERM");
      readyReject(
        new Error("holder did not acquire the lock within 5 seconds"),
      );
    }
  }, 5_000);
  child.stdin.write(`BEGIN; ${statement}; SELECT 'A4_HOLDER_READY';\n`);
  return {
    ready: ready.finally(() => clearTimeout(acquisitionTimer)),
    async release() {
      if (!releaseStarted) {
        releaseStarted = true;
        child.stdin.end("ROLLBACK;\\q\n");
      }
      const result = await completion;
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    },
  };
}

function uncaughtScenario(scenario) {
  const sql = `\\set VERBOSITY verbose
    BEGIN;
    ${fixtureSql(scenario.fixture)}
    SET SESSION AUTHORIZATION app_user;
    SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
    SELECT * FROM public.resolve_organization_identity_for_raw_v1(
      '${WORKSPACE_A}','${scenario.rawRecordId ?? RAW_A}'
    );
    ROLLBACK;`;
  const startedAt = Date.now();
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "global",
      "-d",
      database,
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      encoding: "utf8",
      input: sql,
      timeout: scenario.processTimeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "timeout scenario unexpectedly succeeded");
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/^ERROR:\s+([0-9A-Z]{5}): (.+)$/mu);
  assert.ok(match, `timeout scenario emitted no typed error:\n${output}`);
  return {
    elapsedMs: Date.now() - startedAt,
    outcome: error(match[1], match[2]),
    output,
  };
}

function emptyReadback() {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "app_user",
      "-d",
      database,
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      encoding: "utf8",
      input: `BEGIN;
        SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
        SELECT ${stateSql(WORKSPACE_A)}::text;
        SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
        SELECT ${crossSql()}::text;
        ROLLBACK;`,
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const jsonLines = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"));
  assert.equal(jsonLines.length, 2, result.stdout);
  return jsonLines.map((line) => JSON.parse(line));
}

const CREATE_PRE = state({
  raws: [rawView(RAW_CREATE)],
  companies: [COMPANY_FORGED_STATE],
});
const CREATE_POST = state({
  raws: [rawView(RAW_CREATE)],
  companies: [COMPANY_CREATE_RESULT, COMPANY_FORGED_STATE],
  identifiers: [CREATED_REGISTRY_IDENTIFIER_C],
  links: [link({ canonicalId: COMPANY_C, inputHash: INPUT_CREATE })],
});
const LAZY_PRE = state({
  raws: [rawView(RAW_LAZY)],
  companies: [COMPANY_LAZY, COMPANY_FORGED_STATE],
});
const LAZY_POST = state({
  raws: [rawView(RAW_LAZY)],
  companies: [COMPANY_LAZY, COMPANY_FORGED_STATE],
  links: [
    link({
      matchRule: "name_country",
      confidence: 0.8,
      inputHash: INPUT_LAZY,
    }),
  ],
});
const BIND_PRE = state({
  raws: [rawView(RAW_CREATE)],
  companies: [COMPANY_A_BASE, COMPANY_FORGED_STATE],
  identifiers: [REGISTRY_IDENTIFIER_A],
});
const BIND_POST = state({
  ...BIND_PRE,
  links: [link()],
});

describe("Organization Identity direct-command malicious app_user matrix", () => {
  const directCases = [
    {
      name: "forged-plan create state cannot select an arbitrary existing target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_FORGED_STATE],
        extraSql: deterministicIdTrigger(
          "canonical_company",
          "id",
          `NEW.workspace_id='${WORKSPACE_A}' AND NEW.dedupe_key='n:a4 create:de'`,
          COMPANY_C,
        ),
      },
      expectedPre: CREATE_PRE,
      expectedOutcome: boundResult({
        companyId: COMPANY_C,
        matchRule: "identity_v2",
        inputHash: INPUT_CREATE,
        companyCreated: true,
        identifierCount: 1,
      }),
      expectedPost: CREATE_POST,
    },
    {
      name: "forged-plan lazy state derives the exact blocker target",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY, COMPANY_FORGED_STATE],
      },
      expectedPre: LAZY_PRE,
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "name_country",
        inputHash: INPUT_LAZY,
      }),
      expectedPost: LAZY_POST,
    },
    {
      name: "forged-plan bind state derives the live authority target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
      },
      expectedPre: BIND_PRE,
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "identity_v2",
        inputHash: INPUT_BIND,
        identifierCount: 1,
      }),
      expectedPost: BIND_POST,
    },
    {
      name: "forged-plan disagreement derives conflict rather than caller target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        extraSql: deterministicIdTrigger(
          "organization_identity_conflict",
          "id",
          `NEW.workspace_id='${WORKSPACE_A}'`,
          CONFLICT,
        ),
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
      }),
      expectedOutcome: conflictResult(),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [conflictState()],
        parties: [party(COMPANY_A), party(COMPANY_B)],
        links: [
          link({
            canonicalId: COMPANY_A,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_DISAGREEMENT_A,
            conflictId: CONFLICT,
          }),
          link({
            canonicalId: COMPANY_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_DISAGREEMENT_A,
            conflictId: CONFLICT,
          }),
        ],
      }),
    },
  ];
  for (const scenario of directCases) {
    it(scenario.name, () => assertScenario(scenario));
  }
});

const DISAGREEMENT_CONFLICT = Object.freeze(conflictState());
const DISAGREEMENT_PARTIES = Object.freeze([
  party(COMPANY_A),
  party(COMPANY_B),
]);
const DISAGREEMENT_LINKS_A = Object.freeze([
  link({
    canonicalId: COMPANY_A,
    matchRule: "identity_conflict",
    confidence: 0,
    status: "PENDING_CONFLICT",
    inputHash: INPUT_DISAGREEMENT_A,
    conflictId: CONFLICT,
  }),
  link({
    canonicalId: COMPANY_B,
    matchRule: "identity_conflict",
    confidence: 0,
    status: "PENDING_CONFLICT",
    inputHash: INPUT_DISAGREEMENT_A,
    conflictId: CONFLICT,
  }),
]);
const DISAGREEMENT_BASE = Object.freeze({
  raws: [RAW_CREATE],
  companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
  identifiers: [REGISTRY_IDENTIFIER_A],
});
const DISAGREEMENT_REPLAY_PRE = state({
  raws: [rawView(RAW_CREATE)],
  companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
  identifiers: [REGISTRY_IDENTIFIER_A],
  conflicts: [DISAGREEMENT_CONFLICT],
  parties: DISAGREEMENT_PARTIES,
  links: DISAGREEMENT_LINKS_A,
});

describe("Organization Identity legacy, v2, mixed and damaged replay matrix", () => {
  const legacyLink = link({
    matchRule: "name_country",
    confidence: 0.8,
    resolverVersion: "identity-v1",
    inputHash: "legacy",
  });
  const v2Link = link();
  const activeCompanyC = link({ canonicalId: COMPANY_C });
  const replayCases = [
    {
      name: "legacy replay returns the exact stored target and legacy facts",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
      },
      expectedPre: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
      }),
      expectedOutcome: error("P0001", "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED"),
      expectedPost: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
      }),
    },
    {
      name: "v2 replay returns the exact current hash and target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
      }),
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "identity_v2",
        inputHash: INPUT_BIND,
        replayed: true,
        identifierCount: 1,
      }),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
      }),
    },
    {
      name: "mixed legacy and v2 replay is rejected exactly",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [
          link({ resolverVersion: "identity-v1", inputHash: "legacy" }),
          activeCompanyC,
        ],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [
          link({ resolverVersion: "identity-v1", inputHash: "legacy" }),
          activeCompanyC,
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [
          link({ resolverVersion: "identity-v1", inputHash: "legacy" }),
          activeCompanyC,
        ],
      }),
    },
    {
      name: "foreign resolver replay is rejected exactly",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ resolverVersion: "foreign-resolver/v9" })],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ resolverVersion: "foreign-resolver/v9" })],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ resolverVersion: "foreign-resolver/v9" })],
      }),
    },
    {
      name: "multiple ACTIVE v2 links are rejected rather than selected",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link, activeCompanyC],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link, activeCompanyC],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link, activeCompanyC],
      }),
    },
    {
      name: "ACTIVE plus PENDING_CONFLICT replay is rejected exactly",
      fixture: {
        ...DISAGREEMENT_BASE,
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [
          v2Link,
          link({
            canonicalId: COMPANY_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_BIND,
            conflictId: CONFLICT,
          }),
        ],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [
          v2Link,
          link({
            canonicalId: COMPANY_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_BIND,
            conflictId: CONFLICT,
          }),
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [
          v2Link,
          link({
            canonicalId: COMPANY_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_BIND,
            conflictId: CONFLICT,
          }),
        ],
      }),
    },
    {
      name: "different v2 input hash is rejected as exact drift",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ inputHash: HASH_B })],
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ inputHash: HASH_B })],
      }),
      expectedOutcome: error("P0001", "IDENTITY_INPUT_DRIFT"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ inputHash: HASH_B })],
      }),
    },
    {
      name: "stored v2 target drift is rejected exactly",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [activeCompanyC],
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [activeCompanyC],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [activeCompanyC],
      }),
    },
    {
      name: "stored v2 root drift is rejected exactly",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
        links: [link({ inputHash: INPUT_BIND_ROOT })],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ inputHash: INPUT_BIND_ROOT })],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [link({ inputHash: INPUT_BIND_ROOT })],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
    },
    {
      name: "post-link suppression blocks exact replay without mutation",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
        suppressions: [
          {
            type: "company_name",
            value: "a4 create gmbh",
            protectionClass: "LEGAL",
          },
        ],
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
        suppressions: [
          {
            type: "company_name",
            value: "a4 create gmbh",
            protectionClass: "LEGAL",
          },
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_SUPPRESSED"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        links: [v2Link],
        suppressions: [
          {
            type: "company_name",
            value: "a4 create gmbh",
            protectionClass: "LEGAL",
          },
        ],
      }),
    },
  ];
  for (const scenario of replayCases) {
    it(scenario.name, () => assertScenario(scenario));
  }
});

const SPLIT_FACTS = Object.freeze(
  conflictFacts({
    blockerKey: "d:a4-split.example",
    blockerRule: "domain_exact",
    conflictType: "identifier_split",
    identifierKeys: ["domain:GLOBAL:a4-split.example", "registry-id:DE:DE9999"],
  }),
);
const SPLIT_CONFLICT = Object.freeze(
  conflictState({
    conflictType: "identifier_split",
    fingerprint: FINGERPRINT_SPLIT,
    facts: SPLIT_FACTS,
  }),
);
const SPLIT_ROOT_FACTS = Object.freeze(
  conflictFacts({
    blockerKey: "d:a4-split.example",
    blockerRule: "domain_exact",
    conflictType: "identifier_split",
    companyIds: [COMPANY_C, COMPANY_D],
    identifierKeys: ["domain:GLOBAL:a4-split.example", "registry-id:DE:DE9999"],
  }),
);
const SPLIT_ROOT_CONFLICT = Object.freeze(
  conflictState({
    conflictType: "identifier_split",
    fingerprint: FINGERPRINT_SPLIT_ROOTS,
    facts: SPLIT_ROOT_FACTS,
  }),
);

describe("Organization Identity conflict facts, parties and reuse exactness", () => {
  const splitBase = {
    raws: [RAW_SPLIT],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
  };
  const splitPre = state({
    raws: [rawView(RAW_SPLIT)],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
  });
  const splitLinks = [
    link({
      canonicalId: COMPANY_A,
      matchRule: "identity_conflict",
      confidence: 0,
      status: "PENDING_CONFLICT",
      inputHash: INPUT_SPLIT,
      conflictId: CONFLICT,
    }),
    link({
      canonicalId: COMPANY_B,
      matchRule: "identity_conflict",
      confidence: 0,
      status: "PENDING_CONFLICT",
      inputHash: INPUT_SPLIT,
      conflictId: CONFLICT,
    }),
  ];
  const exactConflictFixture = {
    ...DISAGREEMENT_BASE,
    conflicts: [DISAGREEMENT_CONFLICT],
    parties: DISAGREEMENT_PARTIES,
    links: DISAGREEMENT_LINKS_A,
  };
  const conflictCases = [
    {
      name: "identifier split derives the exact facts, parties and links",
      fixture: {
        ...splitBase,
        extraSql: deterministicIdTrigger(
          "organization_identity_conflict",
          "id",
          `NEW.workspace_id='${WORKSPACE_A}'`,
          CONFLICT,
        ),
      },
      expectedPre: splitPre,
      expectedOutcome: conflictResult({
        inputHash: INPUT_SPLIT,
        fingerprint: FINGERPRINT_SPLIT,
      }),
      expectedPost: state({
        raws: [rawView(RAW_SPLIT)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
        conflicts: [SPLIT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: splitLinks,
      }),
    },
    {
      name: "root-mapped identifier split derives only the exact root parties",
      fixture: {
        raws: [RAW_SPLIT],
        companies: [
          COMPANY_A_BASE,
          COMPANY_B_BLOCKER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_B, COMPANY_D),
        ],
        bypassTriggers: true,
        extraSql: deterministicIdTrigger(
          "organization_identity_conflict",
          "id",
          `NEW.workspace_id='${WORKSPACE_A}'`,
          CONFLICT,
        ),
      },
      expectedPre: state({
        raws: [rawView(RAW_SPLIT)],
        companies: [
          COMPANY_A_BASE,
          COMPANY_B_BLOCKER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_B, COMPANY_D),
        ],
      }),
      expectedOutcome: conflictResult({
        inputHash: INPUT_SPLIT_ROOTS,
        fingerprint: FINGERPRINT_SPLIT_ROOTS,
      }),
      expectedPost: state({
        raws: [rawView(RAW_SPLIT)],
        companies: [
          COMPANY_A_BASE,
          COMPANY_B_BLOCKER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
        conflicts: [SPLIT_ROOT_CONFLICT],
        parties: [party(COMPANY_C), party(COMPANY_D)],
        links: [
          link({
            canonicalId: COMPANY_C,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_SPLIT_ROOTS,
            conflictId: CONFLICT,
          }),
          link({
            canonicalId: COMPANY_D,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_SPLIT_ROOTS,
            conflictId: CONFLICT,
          }),
        ],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_B, COMPANY_D),
        ],
      }),
    },
    {
      name: "exact conflict replay returns exact facts and party count",
      fixture: exactConflictFixture,
      expectedPre: DISAGREEMENT_REPLAY_PRE,
      expectedOutcome: conflictResult({ replayed: true }),
      expectedPost: DISAGREEMENT_REPLAY_PRE,
    },
    {
      name: "equivalent second Raw reuses one conflict and adds exact links only",
      rawRecordId: RAW_B,
      fixture: {
        raws: [RAW_CREATE, RAW_CREATE_B],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: DISAGREEMENT_LINKS_A,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE), rawView(RAW_CREATE_B)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: DISAGREEMENT_LINKS_A,
      }),
      expectedOutcome: conflictResult({
        rawRecordId: RAW_B,
        inputHash: INPUT_DISAGREEMENT_B,
      }),
      expectedPost: state({
        raws: [rawView(RAW_CREATE), rawView(RAW_CREATE_B)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [
          ...DISAGREEMENT_LINKS_A,
          link({
            canonicalId: COMPANY_A,
            rawRecordId: RAW_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_DISAGREEMENT_B,
            conflictId: CONFLICT,
          }),
          link({
            canonicalId: COMPANY_B,
            rawRecordId: RAW_B,
            matchRule: "identity_conflict",
            confidence: 0,
            status: "PENDING_CONFLICT",
            inputHash: INPUT_DISAGREEMENT_B,
            conflictId: CONFLICT,
          }),
        ],
      }),
    },
    {
      name: "same conflict fingerprint with facts drift is rejected exactly",
      fixture: {
        ...DISAGREEMENT_BASE,
        conflicts: [
          conflictState({ facts: { ...conflictFacts(), unexpected: "drift" } }),
        ],
        parties: DISAGREEMENT_PARTIES,
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [
          conflictState({ facts: { ...conflictFacts(), unexpected: "drift" } }),
        ],
        parties: DISAGREEMENT_PARTIES,
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [
          conflictState({ facts: { ...conflictFacts(), unexpected: "drift" } }),
        ],
        parties: DISAGREEMENT_PARTIES,
      }),
    },
    {
      name: "partial conflict links are rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        links: [DISAGREEMENT_LINKS_A[0]],
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        links: [DISAGREEMENT_LINKS_A[0]],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        links: [DISAGREEMENT_LINKS_A[0]],
      }),
    },
    {
      name: "missing exact conflict party is rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        parties: [DISAGREEMENT_PARTIES[0]],
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        parties: [DISAGREEMENT_PARTIES[0]],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        parties: [DISAGREEMENT_PARTIES[0]],
      }),
    },
    {
      name: "extra conflict party is rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_C_ROOT],
        parties: [...DISAGREEMENT_PARTIES, party(COMPANY_C)],
        bypassTriggers: true,
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_C_ROOT],
        parties: [...DISAGREEMENT_PARTIES, party(COMPANY_C)],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_C_ROOT],
        parties: [...DISAGREEMENT_PARTIES, party(COMPANY_C)],
      }),
    },
    {
      name: "wrong conflict party role is rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        parties: [party(COMPANY_A, "BLOCKER"), party(COMPANY_B)],
        bypassTriggers: true,
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        parties: [party(COMPANY_A, "BLOCKER"), party(COMPANY_B)],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        parties: [party(COMPANY_A, "BLOCKER"), party(COMPANY_B)],
      }),
    },
    {
      name: "wrong conflict revision is rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        conflicts: [conflictState({ revision: 2 })],
        bypassTriggers: true,
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        conflicts: [conflictState({ revision: 2 })],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        conflicts: [conflictState({ revision: 2 })],
      }),
    },
    {
      name: "resolved conflict replay is rejected with exact preimage",
      fixture: {
        ...exactConflictFixture,
        conflicts: [conflictState({ status: "RESOLVED" })],
        bypassTriggers: true,
      },
      expectedPre: state({
        ...DISAGREEMENT_REPLAY_PRE,
        conflicts: [conflictState({ status: "RESOLVED" })],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        ...DISAGREEMENT_REPLAY_PRE,
        conflicts: [conflictState({ status: "RESOLVED" })],
      }),
    },
    {
      name: "A to B to C mapping chain is rejected as damaged state",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT, COMPANY_D_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT, COMPANY_D_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_C_ROOT, COMPANY_D_ROOT],
        identifiers: [REGISTRY_IDENTIFIER_A],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
      }),
    },
  ];
  for (const scenario of conflictCases) {
    it(scenario.name, () => assertScenario(scenario));
  }
});

describe("Organization Identity function-owned timeout and fault rollback matrix", () => {
  const createOnlyPreimage = state({ raws: [rawView(RAW_CREATE)] });
  const disagreementPreimage = state({
    raws: [rawView(RAW_CREATE)],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [REGISTRY_IDENTIFIER_A],
  });
  const forceCompanyId = deterministicIdTrigger(
    "canonical_company",
    "id",
    `NEW.workspace_id='${WORKSPACE_A}' AND NEW.dedupe_key='n:a4 create:de'`,
    COMPANY_C,
  );
  const faultCases = [
    {
      name: "company insert fault propagates exactly and restores full preimage",
      fixture: {
        raws: [RAW_CREATE],
        extraSql: faultTrigger(
          "canonical_company",
          "ZX101",
          "A4_COMPANY_INSERT_FAULT",
        ),
      },
      expectedPre: createOnlyPreimage,
      expectedOutcome: error("ZX101", "A4_COMPANY_INSERT_FAULT"),
      expectedPost: createOnlyPreimage,
    },
    {
      name: "identifier insert fault propagates exactly and restores full preimage",
      fixture: {
        raws: [RAW_CREATE],
        extraSql: `${forceCompanyId}
          ${faultTrigger(
            "organization_identifier",
            "ZX102",
            "A4_IDENTIFIER_INSERT_FAULT",
          )}`,
      },
      expectedPre: createOnlyPreimage,
      expectedOutcome: error("ZX102", "A4_IDENTIFIER_INSERT_FAULT"),
      expectedPost: createOnlyPreimage,
    },
    {
      name: "conflict insert fault propagates exactly and restores full preimage",
      fixture: {
        ...DISAGREEMENT_BASE,
        extraSql: faultTrigger(
          "organization_identity_conflict",
          "ZX103",
          "A4_CONFLICT_INSERT_FAULT",
        ),
      },
      expectedPre: disagreementPreimage,
      expectedOutcome: error("ZX103", "A4_CONFLICT_INSERT_FAULT"),
      expectedPost: disagreementPreimage,
    },
    {
      name: "party insert fault propagates exactly and restores full preimage",
      fixture: {
        ...DISAGREEMENT_BASE,
        extraSql: `${deterministicIdTrigger(
          "organization_identity_conflict",
          "id",
          `NEW.workspace_id='${WORKSPACE_A}'`,
          CONFLICT,
        )}
          ${faultTrigger(
            "organization_identity_conflict_party",
            "ZX104",
            "A4_PARTY_INSERT_FAULT",
          )}`,
      },
      expectedPre: disagreementPreimage,
      expectedOutcome: error("ZX104", "A4_PARTY_INSERT_FAULT"),
      expectedPost: disagreementPreimage,
    },
    {
      name: "link insert fault propagates exactly and restores full preimage",
      fixture: {
        raws: [RAW_CREATE],
        extraSql: `${forceCompanyId}
          ${faultTrigger("identity_link", "ZX105", "A4_LINK_INSERT_FAULT")}`,
      },
      expectedPre: createOnlyPreimage,
      expectedOutcome: error("ZX105", "A4_LINK_INSERT_FAULT"),
      expectedPost: createOnlyPreimage,
    },
  ];
  for (const scenario of faultCases) {
    it(scenario.name, () => assertScenario(scenario));
  }

  it("function-owned lock deadline times out behind a real second connection", async () => {
    const holder = startHolder(
      `SELECT pg_advisory_xact_lock(hashtextextended(
        'acquisition-suppression-policy:${WORKSPACE_A}',0
      ))`,
    );
    await holder.ready;
    try {
      const elapsedMs = assertScenario({
        fixture: { raws: [RAW_CREATE] },
        expectedPre: createOnlyPreimage,
        expectedOutcome: error("55P03", "IDENTITY_RESOLUTION_LOCK_TIMEOUT"),
        expectedPost: createOnlyPreimage,
        processTimeout: 10_000,
      });
      assert.ok(
        elapsedMs >= 4_500 && elapsedMs < 9_000,
        `function-owned lock deadline was not near five seconds: ${elapsedMs}`,
      );
    } finally {
      await holder.release();
    }
  });

  it("function-owned statement timeout cancels a bounded downstream trigger", () => {
    const slowTrigger = `CREATE FUNCTION pg_temp.a4_slow_company()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_sleep(61);
        RETURN NEW;
      END $$;
      CREATE TRIGGER a4_slow_company BEFORE INSERT ON canonical_company
      FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_slow_company();`;
    const observed = uncaughtScenario({
      fixture: { raws: [RAW_CREATE], extraSql: slowTrigger },
      processTimeout: 66_000,
    });
    const [workspaceState, crossState] = emptyReadback();
    assert.deepEqual(workspaceState, state());
    assert.deepEqual(crossState, EMPTY_CROSS);
    assert.deepEqual(observed.outcome, {
      kind: "error",
      sqlstate: "57014",
      message: "canceling statement due to statement timeout",
    });
    assert.ok(
      observed.elapsedMs >= 55_000 && observed.elapsedMs < 66_000,
      `function-owned statement timeout was not bounded: ${observed.elapsedMs}`,
    );
  });
});
