import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { materializePinnedPrismaStage } from "./helpers/pinned-prisma-stage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const contractCommit = "400caab2f8d827cc012ee5f928e7af4d6a1d6e08";
const currentSchemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");
const currentMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260830090000_organization_identity_v2_resolver_command/migration.sql",
);

const receiptPath = process.env.TASK6B_A1_RECEIPT_PATH;
const receiptPathExpected =
  "/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A1-disposable-setup-receipt.md";
const receiptHash =
  "4596418fc39fc8b7ce8a6cd9b299e936f5e1e215512e4d1356ad5b95aeb9839c";
const admissionBaseUrl = process.env.TASK6B_A3_DATABASE_URL;
const topology = Object.freeze({
  container: "codex-task6b-identity-authority-pg-20260830-a",
  containerId:
    "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915",
  network: "codex-task6b-identity-authority-net-20260830-a",
  networkId: "14e022a6f17fd723013d2f73ba879927df097c2c3d383adee3381adda689153a",
  volume: "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1",
  image:
    "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
  labels:
    '{"com.openai.codex.artifact":"identity-authority","com.openai.codex.task":"organization-identity-command-expansion"}',
});
const signature = Object.freeze({
  authority: "public.organization_identity_authority_from_raw_v1(text,jsonb)",
  blocker: "public.organization_identity_blocker_from_raw_v1(jsonb)",
  suppression:
    "public.organization_identity_canonical_suppression_value_v1(text,text)",
  planner: "public.organization_identity_plan_from_snapshot_v1(jsonb)",
  advisory:
    "public.organization_identity_acquire_advisory_until_v1(bigint,timestamptz)",
  command: "public.resolve_organization_identity_for_raw_v1(text,text)",
});
const catalogIdentity = Object.freeze({
  [signature.authority]:
    "public|organization_identity_authority_from_raw_v1|text, jsonb",
  [signature.blocker]: "public|organization_identity_blocker_from_raw_v1|jsonb",
  [signature.suppression]:
    "public|organization_identity_canonical_suppression_value_v1|text, text",
  [signature.planner]:
    "public|organization_identity_plan_from_snapshot_v1|jsonb",
  [signature.advisory]:
    "public|organization_identity_acquire_advisory_until_v1|bigint, timestamp with time zone",
  [signature.command]:
    "public|resolve_organization_identity_for_raw_v1|text, text",
});
const ownerOnlyAcl = "global:EXECUTE:false:global";
const catalogContract = Object.freeze({
  [signature.authority]:
    `jsonb|plpgsql|global|false|i|u|false|false|false|f|search_path=pg_catalog, public|${ownerOnlyAcl}`,
  [signature.blocker]:
    `jsonb|plpgsql|global|false|i|u|false|false|false|f|search_path=pg_catalog, public|${ownerOnlyAcl}`,
  [signature.suppression]:
    `text|plpgsql|global|false|i|u|false|false|false|f|search_path=pg_catalog, public|${ownerOnlyAcl}`,
  [signature.planner]:
    `jsonb|plpgsql|global|false|i|u|false|false|false|f|search_path=pg_catalog, public|${ownerOnlyAcl}`,
  [signature.advisory]:
    `void|plpgsql|global|false|v|u|false|false|false|f|search_path=pg_catalog, public|${ownerOnlyAcl}`,
  [signature.command]:
    "TABLE(outcome_kind text, raw_record_id uuid, company_id uuid, conflict_id uuid, match_rule text, input_hash text, conflict_fingerprint text, replayed boolean, company_created boolean, identifier_count integer, party_count integer)|plpgsql|global|true|v|u|true|false|false|f|search_path=pg_catalog, public,row_security=off|app_user:EXECUTE:false:global,global:EXECUTE:false:global",
});
const admissionDatabases = Object.freeze([
  "task_a3_fix3_unrelated_default_positive",
  "task_a3_fix3_owner_defaults_positive",
  "task_a3_fix3_global_default_negative",
  "task_a3_fix3_public_default_negative",
  "task_a3_fix3_direct_membership_negative",
  "task_a3_fix3_transitive_membership_negative",
  "task_a3_fix3_inert_membership_positive",
]);
const admissionDatabaseSet = new Set(admissionDatabases);
const admissionRoles = Object.freeze([
  "task_a3_fix3_direct_member",
  "task_a3_fix3_transitive_leaf",
  "task_a3_fix3_transitive_mid",
  "task_a3_fix3_inert_member",
]);
const finalAclRows = Object.freeze([
  "organization_identity_acquire_advisory_until_v1|global:EXECUTE:false:global",
  "organization_identity_authority_from_raw_v1|global:EXECUTE:false:global",
  "organization_identity_blocker_from_raw_v1|global:EXECUTE:false:global",
  "organization_identity_canonical_suppression_value_v1|global:EXECUTE:false:global",
  "organization_identity_plan_from_snapshot_v1|global:EXECUTE:false:global",
  "resolve_organization_identity_for_raw_v1|app_user:EXECUTE:false:global,global:EXECUTE:false:global",
]);

function docker(args, input = "") {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function psql(statement) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-i",
      topology.container,
      "psql",
      "-U",
      "global",
      "-d",
      "postgres",
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { encoding: "utf8", input: statement, maxBuffer: 4 * 1024 * 1024 },
  );
}

function psqlDatabase(database, statement) {
  assert.ok(
    database === "global" || database === "postgres" || admissionDatabaseSet.has(database),
    `database outside Task A3 admission scope: ${database}`,
  );
  return spawnSync(
    "docker",
    [
      "exec",
      "-i",
      topology.container,
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
    { encoding: "utf8", input: statement, maxBuffer: 16 * 1024 * 1024 },
  );
}

function sqlDatabase(database, statement) {
  const result = psqlDatabase(database, statement);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  return result.stdout.trim();
}

function createAdmissionDatabase(database) {
  assert.ok(admissionDatabaseSet.has(database));
  sqlDatabase("global", `DROP DATABASE IF EXISTS ${database};`);
  sqlDatabase("global", `CREATE DATABASE ${database};`);
}

function dropAdmissionDatabase(database) {
  assert.ok(admissionDatabaseSet.has(database));
  sqlDatabase(
    "global",
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname='${database}' AND pid<>pg_backend_pid();`,
  );
  sqlDatabase("global", `DROP DATABASE IF EXISTS ${database};`);
}

function parseAdmissionDatabaseUrl(input, database) {
  const rejected = Object.freeze({
    ok: false,
    code: "TASK6B_A3_DATABASE_URL_INVALID",
  });

  if (
    !admissionDatabaseSet.has(database) ||
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 2048
  ) {
    return rejected;
  }

  try {
    const parsed = new URL(input);
    if (
      parsed.protocol !== "postgresql:" ||
      parsed.username !== "global" ||
      parsed.password.length === 0 ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "55441" ||
      parsed.pathname !== "/postgres" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !parsed.href.endsWith("/postgres")
    ) {
      return rejected;
    }

    const derived = new URL(parsed.href);
    derived.pathname = `/${database}`;
    derived.searchParams.set("schema", "public");
    return Object.freeze({ ok: true, databaseUrl: derived.href });
  } catch {
    return rejected;
  }
}

function sanitizeAdmissionChildFailure(result) {
  const exit =
    Number.isInteger(result?.status) &&
    result.status >= 0 &&
    result.status <= 255
      ? result.status
      : "UNKNOWN";
  const signal = result?.signal == null ? "NONE" : "PRESENT";
  return Object.freeze({
    ok: false,
    code: "TASK6B_A3_PRISMA_DEPLOY_FAILED",
    exit,
    signal,
  });
}

function formatAdmissionChildFailure(outcome) {
  return `${outcome.code}|exit=${outcome.exit}|signal=${outcome.signal}`;
}

function runPrisma(schemaPath, database) {
  const admission = parseAdmissionDatabaseUrl(admissionBaseUrl, database);
  if (!admission.ok) assert.fail(admission.code);
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      schemaPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: admission.databaseUrl,
        PRISMA_HIDE_UPDATE_MESSAGE: "true",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const outcome = sanitizeAdmissionChildFailure(result);
    assert.fail(formatAdmissionChildFailure(outcome));
  }
  return Object.freeze({
    migrationObserved:
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(
        "20260830090000_organization_identity_v2_resolver_command",
      ),
  });
}

function dropAdmissionRoles() {
  for (const role of [...admissionRoles].reverse()) {
    sqlDatabase("global", `DROP ROLE IF EXISTS ${role};`);
  }
}

function withAdmissionDatabase(database, callback) {
  assert.ok(admissionDatabaseSet.has(database));
  let stage;
  createAdmissionDatabase(database);
  try {
    stage = materializePinnedPrismaStage({
      repositoryRoot,
      commit: contractCommit,
      prefix: "task-a3-fix3-admission-",
    });
    runPrisma(stage.schemaPath, database);
    callback();
  } finally {
    if (stage?.root) rmSync(stage.root, { recursive: true, force: true });
    dropAdmissionDatabase(database);
  }
}

function assertAdmissionSuccess(database) {
  const migrationHash = createHash("sha256")
    .update(readFileSync(currentMigrationPath))
    .digest("hex");
  const deployOutcome = runPrisma(currentSchemaPath, database);
  assert.equal(
    deployOutcome.migrationObserved,
    true,
    "TASK6B_A3_CURRENT_MIGRATION_NOT_OBSERVED",
  );
  assert.equal(
    sqlDatabase(
      database,
      `SELECT count(*)||'|'||min(checksum)||'|'||
        count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
       FROM _prisma_migrations
       WHERE migration_name='20260830090000_organization_identity_v2_resolver_command';`,
    ),
    `1|${migrationHash}|1`,
  );
  assert.deepEqual(
    sqlDatabase(
      database,
      `SELECT p.proname||'|'||coalesce((
        SELECT string_agg(
          CASE WHEN acl.grantee=0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(acl.grantee) END||':'||
          acl.privilege_type||':'||acl.is_grantable::text||':'||
          pg_get_userbyid(acl.grantor),
          ',' ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(acl.grantee) END COLLATE "C"
        )
        FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      ),'')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN (
          'organization_identity_authority_from_raw_v1',
          'organization_identity_blocker_from_raw_v1',
          'organization_identity_canonical_suppression_value_v1',
          'organization_identity_plan_from_snapshot_v1',
          'organization_identity_acquire_advisory_until_v1',
          'resolve_organization_identity_for_raw_v1'
        )
      ORDER BY p.proname;`,
    ).split("\n"),
    finalAclRows,
  );
}

function assertAdmissionFailure(database) {
  const result = psqlDatabase(database, readFileSync(currentMigrationPath, "utf8"));
  assert.notEqual(result.status, 0, "migration admission unexpectedly succeeded");
  assert.match(result.stderr, /IDENTITY_RESOLUTION_CATALOG_RESIDUE/u);
  assert.equal(
    sqlDatabase(
      database,
      `SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN (
           'organization_identity_authority_from_raw_v1',
           'organization_identity_blocker_from_raw_v1',
           'organization_identity_canonical_suppression_value_v1',
           'organization_identity_plan_from_snapshot_v1',
           'organization_identity_acquire_advisory_until_v1',
           'resolve_organization_identity_for_raw_v1'
         );
       SELECT count(*)
       FROM _prisma_migrations
       WHERE migration_name='20260830090000_organization_identity_v2_resolver_command';`,
    ),
    "0\n0",
  );
}

function sql(statement) {
  const result = psql(statement);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  return result.stdout.trim();
}

function exactMachineError(
  statement,
  expected,
  transactionPrefix = "",
  transactionSuffix = "",
) {
  const result = psql(`${transactionPrefix}
DO $task_a2_error_capture$
DECLARE
  captured_state text;
  captured_message text;
BEGIN
  BEGIN
    ${statement}
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TASK_A2_EXPECTED_ERROR_NOT_RAISED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      captured_state = RETURNED_SQLSTATE,
      captured_message = MESSAGE_TEXT;
    RAISE NOTICE 'TASK_A2_ERROR|%|%', captured_state, captured_message;
  END;
END
$task_a2_error_capture$;
${transactionSuffix}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  const notices = result.stderr
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("NOTICE:  TASK_A2_ERROR|"));
  assert.deepEqual(notices, [`NOTICE:  TASK_A2_ERROR|${expected}`]);
}

function exactHelper(name, helperSignature) {
  const [schema, functionName, argumentsText] =
    catalogIdentity[helperSignature].split("|");
  assert.equal(
    sql(`SELECT coalesce((
      SELECT n.nspname||'|'||p.proname||'|'||oidvectortypes(p.proargtypes)
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='${schema}'
        AND p.proname='${functionName}'
        AND oidvectortypes(p.proargtypes)='${argumentsText}'
    ),'<ABSENT>');`),
    catalogIdentity[helperSignature],
    `${name}: exact helper OID/namespace/name/identity arguments are absent`,
  );
}

function valueCase(vector) {
  it(vector.name, () => {
    exactHelper(vector.name, vector.signature);
    assert.equal(sql(vector.call), vector.expected);
  });
}

function errorCase(vector) {
  it(vector.name, () => {
    exactHelper(vector.name, vector.signature);
    exactMachineError(vector.statement, vector.expectedError);
  });
}

function receipt() {
  assert.equal(
    receiptPath,
    receiptPathExpected,
    "TASK6B_A1_RECEIPT_PATH must name the frozen A1 receipt",
  );
  const content = readFileSync(receiptPath, "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), receiptHash);
  for (const value of [
    topology.container,
    topology.containerId,
    topology.network,
    topology.networkId,
    topology.volume,
    topology.image,
  ]) {
    assert.ok(content.includes(value));
  }
  assert.ok(content.includes("com.openai.codex.artifact=identity-authority"));
  assert.ok(
    content.includes(
      "com.openai.codex.task=organization-identity-command-expansion",
    ),
  );
}

const authorityCases = Object.freeze([
  {
    name: "directory remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('directory','{"externalId":"directory:acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"directory","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "Wikidata remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('wikidata','{"externalId":"wikidata:Q1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"wikidata_qid":"Q1","latitude":1,"longitude":2,"source_class":"company_registry"},"license":"CC0-1.0","provenance":{"sourceUrl":"https://www.wikidata.org/wiki/Q1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"wikidata","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "OpenStreetMap remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openstreetmap','{"externalId":"osm:node/1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"osm_id":"node/1","latitude":52.5,"longitude":13.4,"source_class":"industry_data"},"license":"ODbL-1.0","provenance":{"sourceUrl":"https://www.openstreetmap.org/node/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"openstreetmap","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "trade fair remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('trade_fair','{"externalId":"fair-1:company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"stand":"A42","products":["pump"],"source_fair":"fair-1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"trade_fair","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "public web remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('public_web','{"externalId":"acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"keywords":["industrial"],"extraction_confidence":0.9,"extraction_evidence_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source_class":"public_intelligence"},"provenance":{"sourceUrl":"https://acme.example/company","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"public_web","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "registry identifier returns the complete literal authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"de-12/34"}}'::jsonb)='[{"providerKey":"registry","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "checksum-valid LEI returns GLOBAL authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"lei","value":"529900T8BM49AURSDO55"}}'::jsonb)='[{"providerKey":"registry","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"registry","scheme":"lei","jurisdiction":"GLOBAL","normalizedValue":"529900T8BM49AURSDO55","validatorVersion":"lei-v1","normalizerVersion":"organization-identity-authority/v1","key":"lei:GLOBAL:529900T8BM49AURSDO55"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "TED suffix supplies jurisdiction without country",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"de291499156"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb)='[{"providerKey":"ted","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"ted","scheme":"ted-natid","jurisdiction":"DE","normalizedValue":"DE291499156","validatorVersion":"ted-natid-v1","normalizerVersion":"organization-identity-authority/v1","key":"ted-natid:DE:DE291499156"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "FDA accepts its one-digit lower bound",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"1","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"1"}}'::jsonb)='[{"providerKey":"openfda","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"openfda","scheme":"fda-reg","jurisdiction":"US","normalizedValue":"1","validatorVersion":"fda-reg-v1","normalizerVersion":"organization-identity-authority/v1","key":"fda-reg:US:1"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "FDA accepts its thirty-two-digit upper bound",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:12345678901234567890123456789012","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"12345678901234567890123456789012","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"12345678901234567890123456789012"}}'::jsonb)='[{"providerKey":"openfda","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"openfda","scheme":"fda-reg","jurisdiction":"US","normalizedValue":"12345678901234567890123456789012","validatorVersion":"fda-reg-v1","normalizerVersion":"organization-identity-authority/v1","key":"fda-reg:US:12345678901234567890123456789012"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "TED accepts an eighty-byte identifier and returns full authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}}'::jsonb)='[{"providerKey":"ted","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"ted","scheme":"ted-natid","jurisdiction":"DE","normalizedValue":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ","validatorVersion":"ted-natid-v1","normalizerVersion":"organization-identity-authority/v1","key":"ted-natid:DE:ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}]'::jsonb)::text;`,
    expected: "true",
  },
]);

const authorityErrorCases = Object.freeze([
  {
    name: "invalid LEI checksum is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"lei","value":"529900T8BM49AURSDO54"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "TED suffix-country conflict is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"FR","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"de291499156"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "FDA thirty-three-digit identifier is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:123456789012345678901234567890123","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"123456789012345678901234567890123","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"123456789012345678901234567890123"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "otherwise-identical TED eighty-one-byte identifier is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄA"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄA"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "missing identifier scheme is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "extra identifier field is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","extra":"x"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "relabelled identifier scheme is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_NOT_AUTHORIZED",
  },
  {
    name: "wrong identifier provider is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory','{"externalId":"directory:acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_NOT_AUTHORIZED",
  },
  {
    name: "wrong identifier validator version is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","validatorVersion":"registry-id-v999"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "wrong identifier jurisdiction is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"1","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"1","jurisdiction":"GLOBAL"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "wrong identifier key is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","key":"registry-id:DE:OTHER"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "IPv4 literal cannot become domain authority",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory','{"domain":"127.0.0.1"}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "IPv6 literal cannot become domain authority",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory','{"domain":"2001:db8::1"}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "invalid leading-hyphen label cannot become domain authority",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory','{"domain":"-invalid.example"}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "overlong label cannot become domain authority",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory',jsonb_build_object('domain',repeat('a',64)||'.example'));`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
]);

const blockerCases = Object.freeze([
  {
    name: "domain blocker has priority over the name",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Different GmbH","domain":"www.acme.example","country":"DE"}'::jsonb)='{"blockerKey":"d:acme.example","matchRule":"domain_exact"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "legal suffix removal is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"DE"}'::jsonb)='{"blockerKey":"n:acme:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "Unicode company-name normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Äcme Pumps","country":"DE"}'::jsonb)='{"blockerKey":"n:äcme pumps:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "punctuation normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme, Pump-Works","country":"DE"}'::jsonb)='{"blockerKey":"n:acme pump works:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "country case normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme Pumps","country":"DE"}'::jsonb)='{"blockerKey":"n:acme pumps:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "empty normalized company name returns a literal HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":" GmbH ","country":"DE"}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_EMPTY_NORMALIZED_NAME"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "provider identifier is excluded from the v2 fallback blocker",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"DE","identifier":{"scheme":"registry-id","value":"DE1234"}}'::jsonb)='{"blockerKey":"n:acme:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "empty country remains an admitted name-country blocker",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":""}'::jsonb)='{"blockerKey":"n:acme:","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "one-byte country returns a fixed HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"D"}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_INPUT_INVALID"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "punctuation country returns a fixed HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"D!"}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_INPUT_INVALID"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "whitespace country returns a fixed HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":" DE "}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_INPUT_INVALID"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "JSON-null country returns a fixed HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":null}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_INPUT_INVALID"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "over-512-byte multibyte blocker key returns a fixed HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1(jsonb_build_object('name',repeat('Ä',256),'country','DE'))='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_INPUT_INVALID"}'::jsonb)::text;`,
    expected: "true",
  },
]);

const suppressionCases = Object.freeze([
  {
    name: "canonical ASCII domain remains unchanged",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','example.com');`,
    expected: "example.com",
  },
  {
    name: "HTTPS protocol presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','HTTPS://Example.COM');`,
    expected: "example.com",
  },
  {
    name: "www presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','www.Example.COM');`,
    expected: "example.com",
  },
  {
    name: "path presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','Example.COM/directory');`,
    expected: "example.com",
  },
  {
    name: "trailing domain dot is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','Example.COM.');`,
    expected: "example.com",
  },
  {
    name: "malformed domain fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','999.999.999.999'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "IPv4 address fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','127.0.0.1'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "IPv6 address fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','https://[2001:db8::1]/'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "overlong domain label fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.com'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "decomposed company name is normalized to NFC",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('company_name','Äcme GmbH');`,
    expected: "äcme gmbh",
  },
  {
    name: "company-name whitespace is canonicalized",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('company_name','  ACME\t GmbH  ');`,
    expected: "acme gmbh",
  },
  {
    name: "stored domain presentation matches the canonical candidate",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES (' HTTPS://WWW.EXAMPLE.COM/path ')), candidate(value) AS (VALUES ('example.com')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('domain',stored.value)=public.organization_identity_canonical_suppression_value_v1('domain',candidate.value))::text;`,
    expected: "true",
  },
  {
    name: "stored company-name presentation matches the canonical candidate",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES ('  ACME   GmbH ')), candidate(value) AS (VALUES ('Acme GmbH')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('company_name',stored.value)=public.organization_identity_canonical_suppression_value_v1('company_name',candidate.value))::text;`,
    expected: "true",
  },
  {
    name: "legacy noncanonical stored company domain never matches",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES ('not a canonical domain')), candidate(value) AS (VALUES ('example.com')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('domain',stored.value) IS NOT NULL AND public.organization_identity_canonical_suppression_value_v1('domain',stored.value)=public.organization_identity_canonical_suppression_value_v1('domain',candidate.value))::text;`,
    expected: "false",
  },
]);

const plannerCases = Object.freeze([
  {
    name: "create-new plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[],"rootMappings":[]}'::jsonb)='{"kind":"create_new","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"be8c1309ff19260a4b93dca3716d398535a5277067362c91ee01e368cc28aa94"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "lazy-upgrade plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"22222222-2222-4222-8222-222222222222"},"authorityIdentifiers":[],"existingBindings":[],"rootMappings":[]}'::jsonb)='{"kind":"lazy_upgrade","companyId":"22222222-2222-4222-8222-222222222222","matchRule":"domain_exact","identifiers":[],"inputHash":"6952f0036ae5d335e55f536735844bc3e4a73ad3a138c60be5d5efb0db0a8a29"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "direct bind-existing plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"bind_existing","companyId":"22222222-2222-4222-8222-222222222222","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"36b672e096bb2ec860787ea225e1a728da1b9449d16708fce577ae9e79ea2006"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "one-hop bind-existing plan returns the mapped root and complete result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb)='{"kind":"bind_existing","companyId":"44444444-4444-4444-8444-444444444444","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"d8abe41e3201d05746f69cb4e444826451b9d8ff14d8e64eb8ea1077c7967b67"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "blocker-disagreement plan returns its complete literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"33333333-3333-4333-8333-333333333333"},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"blocking_key_disagreement","companyIds":["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"],"identifierKeys":["registry-id:DE:DE1234"],"inputHash":"ebb725ebe12e75778bbee94b60ab062587734263da02842050c4e85fce7136f0","conflictFingerprint":"3d875a6549bdb9afe1dae5d9f3127554e194a1417a7c272ef79498dea303040d"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "new Raw occurrence changes only the literal input hash of the disagreement",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"55555555-5555-4555-8555-555555555555","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"33333333-3333-4333-8333-333333333333"},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"blocking_key_disagreement","companyIds":["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"],"identifierKeys":["registry-id:DE:DE1234"],"inputHash":"837d6648633c20db5001be083b831d433b1c54bacd5a67c8cf159f641cc8baa1","conflictFingerprint":"3d875a6549bdb9afe1dae5d9f3127554e194a1417a7c272ef79498dea303040d"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "random duplicate authority and binding order with two one-hop roots returns the full literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"55555555-5555-4555-8555-555555555555"},{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"identifier_split","companyIds":["44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"identifierKeys":["registry-id:DE:DE1234","registry-id:DE:DE9999"],"inputHash":"0e586afcfa62c7679a530d1d9439fc58f072117b3933a43e75701b293294bad2","conflictFingerprint":"c104982be03334fde490c1345c27888aaa72595b1d8ae97665c129ee2ccbc6bc"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "reversed duplicate authority binding and root order returns the identical full literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"}],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"},{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"55555555-5555-4555-8555-555555555555"}]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"identifier_split","companyIds":["44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"identifierKeys":["registry-id:DE:DE1234","registry-id:DE:DE9999"],"inputHash":"0e586afcfa62c7679a530d1d9439fc58f072117b3933a43e75701b293294bad2","conflictFingerprint":"c104982be03334fde490c1345c27888aaa72595b1d8ae97665c129ee2ccbc6bc"}'::jsonb)::text;`,
    expected: "true",
  },
]);

const plannerErrorCases = Object.freeze([
  {
    name: "alias chain is rejected with the exact planner code",
    signature: signature.planner,
    statement: `PERFORM public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[],"existingBindings":[],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"33333333-3333-4333-8333-333333333333"},{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb);`,
    expectedError: "P0001|IDENTITY_RESOLUTION_INPUT_INVALID",
  },
]);

const plannerRequiredScalarBase =
  '{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}';

const plannerRequiredScalarErrorCases = Object.freeze([
  {
    name: "empty blocker is rejected before nullable predicates",
    expression: `jsonb_set('${plannerRequiredScalarBase}'::jsonb,'{blocker}','{}'::jsonb,false)`,
  },
  ...[
    ["null resolver version", "{resolverVersion}"],
    ["null Raw record ID", "{raw,rawRecordId}"],
    ["null Raw provider", "{raw,providerKey}"],
    ["null Raw payload hash", "{raw,payloadHash}"],
    ["null Raw ingest version", "{raw,ingestVersion}"],
    ["null blocker key", "{blocker,blockerKey}"],
    ["null blocker match rule", "{blocker,matchRule}"],
    ["null authority provider", "{authorityIdentifiers,0,providerKey}"],
    ["null authority scheme", "{authorityIdentifiers,0,scheme}"],
    ["null authority jurisdiction", "{authorityIdentifiers,0,jurisdiction}"],
    ["null authority normalized value", "{authorityIdentifiers,0,normalizedValue}"],
    ["null authority validator version", "{authorityIdentifiers,0,validatorVersion}"],
    ["null authority normalizer version", "{authorityIdentifiers,0,normalizerVersion}"],
    ["null authority key", "{authorityIdentifiers,0,key}"],
    ["null binding identifier key", "{existingBindings,0,identifierKey}"],
    ["null binding company ID", "{existingBindings,0,companyId}"],
    ["null mapping source ID", "{rootMappings,0,sourceCompanyId}"],
    ["null mapping root ID", "{rootMappings,0,rootCompanyId}"],
  ].map(([name, path]) => ({
    name: `${name} is rejected before nullable predicates`,
    expression: `jsonb_set('${plannerRequiredScalarBase}'::jsonb,'${path}','null'::jsonb,false)`,
  })),
].map(({ name, expression }) => ({
  name,
  signature: signature.planner,
  statement: `PERFORM public.organization_identity_plan_from_snapshot_v1(${expression});`,
  expectedError: "P0001|IDENTITY_RESOLUTION_INPUT_INVALID",
})));

const advisoryCases = Object.freeze([
  {
    name: "uncontended advisory acquisition succeeds before its deadline",
    signature: signature.advisory,
    call: `BEGIN; SELECT public.organization_identity_acquire_advisory_until_v1(721234567890123456,clock_timestamp()+interval '1 second'); ROLLBACK;`,
    expected: "",
  },
]);

const advisoryErrorCases = Object.freeze([
  {
    name: "expired advisory deadline returns the fixed lock-timeout code",
    signature: signature.advisory,
    statement: `PERFORM public.organization_identity_acquire_advisory_until_v1(721234567890123457,clock_timestamp()-interval '1 millisecond');`,
    expectedError: "55P03|IDENTITY_RESOLUTION_LOCK_TIMEOUT",
  },
]);

let syntheticAdmissionCredentialSequence = 0;

function syntheticAdmissionCredential() {
  syntheticAdmissionCredentialSequence += 1;
  const password = [
    "task-a3-synthetic",
    process.pid,
    Date.now(),
    syntheticAdmissionCredentialSequence,
    ":@/?#%",
  ].join("-");
  const encodedPassword = encodeURIComponent(password);
  const originalUrl = `postgresql://global:${encodedPassword}@127.0.0.1:55441/postgres`;
  const derivedUrl = `postgresql://global:${encodedPassword}@127.0.0.1:55441/task_a3_fix3_owner_defaults_positive?schema=public`;
  const credentialEnvironment = `DATABASE_URL=${derivedUrl}`;

  return Object.freeze({
    password,
    encodedPassword,
    originalUrl,
    derivedUrl,
    credentialEnvironment,
  });
}

function assertFixedAdmissionUrlRejection(input, sensitiveValues) {
  const outcome = parseAdmissionDatabaseUrl(
    input,
    "task_a3_fix3_owner_defaults_positive",
  );
  assert.equal(outcome?.ok, false);
  assert.equal(outcome?.code, "TASK6B_A3_DATABASE_URL_INVALID");
  assert.equal(
    Object.keys(outcome ?? {})
      .sort()
      .join(","),
    "code,ok",
  );
  const rendered = JSON.stringify(outcome);
  assert.equal(
    sensitiveValues.every((value) => !rendered.includes(value)),
    true,
  );
}

describe("Task A3 admission diagnostics do not disclose credentials", () => {
  it("rejects a malformed URL with only the fixed machine code", () => {
    const fixture = syntheticAdmissionCredential();
    const malformedUrl = `postgresql://global:${fixture.encodedPassword}@[`;
    assertFixedAdmissionUrlRejection(malformedUrl, [
      fixture.password,
      fixture.encodedPassword,
      fixture.originalUrl,
      malformedUrl,
    ]);
  });

  for (const vector of [
    {
      name: "unexpected principal",
      rewrite: (url) => url.replace("global:", "unexpected-principal:"),
    },
    {
      name: "unexpected host",
      rewrite: (url) => url.replace("@127.0.0.1:", "@localhost:"),
    },
    {
      name: "unexpected port",
      rewrite: (url) => url.replace(":55441/", ":55442/"),
    },
    {
      name: "unexpected path",
      rewrite: (url) => url.replace("/postgres", "/global"),
    },
    {
      name: "unexpected search",
      rewrite: (url) => `${url}?`,
    },
    {
      name: "unexpected hash",
      rewrite: (url) => `${url}#`,
    },
  ]) {
    it(`rejects ${vector.name} with only the fixed machine code`, () => {
      const fixture = syntheticAdmissionCredential();
      const input = vector.rewrite(fixture.originalUrl);
      assertFixedAdmissionUrlRejection(input, [
        fixture.password,
        fixture.encodedPassword,
        fixture.originalUrl,
        input,
      ]);
    });
  }

  it("reduces child failure output to bounded non-secret machine fields", () => {
    const fixture = syntheticAdmissionCredential();
    const result = {
      status: 17,
      signal: null,
      stdout: [
        fixture.originalUrl,
        fixture.derivedUrl,
        fixture.credentialEnvironment,
      ].join("\n"),
      stderr: [fixture.password, fixture.encodedPassword].join("\n"),
    };
    const outcome = sanitizeAdmissionChildFailure(result);
    const diagnostic = formatAdmissionChildFailure(outcome);

    assert.equal(outcome?.ok, false);
    assert.equal(outcome?.code, "TASK6B_A3_PRISMA_DEPLOY_FAILED");
    assert.equal(outcome?.exit, 17);
    assert.equal(outcome?.signal, "NONE");
    assert.equal(
      diagnostic,
      "TASK6B_A3_PRISMA_DEPLOY_FAILED|exit=17|signal=NONE",
    );
    assert.equal(
      Object.keys(outcome ?? {})
        .sort()
        .join(","),
      "code,exit,ok,signal",
    );
    const rendered = JSON.stringify(outcome);
    assert.equal(
      [
        fixture.password,
        fixture.encodedPassword,
        fixture.originalUrl,
        fixture.derivedUrl,
        fixture.credentialEnvironment,
      ].every(
        (value) => !rendered.includes(value) && !diagnostic.includes(value),
      ),
      true,
    );
  });
});

describe("Organization Identity literal TypeScript-SQL parity", () => {
  it("loads and verifies the frozen A1 receipt plus exact disposable topology", () => {
    receipt();
    assert.equal(
      docker([
        "inspect",
        "--format",
        "{{.Id}}|{{json .State.Running}}|{{json .NetworkSettings.Ports}}|{{json .Config.Labels}}|{{.Image}}",
        topology.container,
      ]),
      `${topology.containerId}|true|{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55441"}]}|${topology.labels}|sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`,
    );
    assert.equal(
      docker([
        "network",
        "inspect",
        "--format",
        "{{.Id}}|{{.Driver}}|{{len .Containers}}|{{json .Labels}}",
        topology.network,
      ]),
      `${topology.networkId}|bridge|1|${topology.labels}`,
    );
    const bridgeMembers = JSON.parse(
      docker([
        "network",
        "inspect",
        "--format",
        "{{json .Containers}}",
        topology.network,
      ]),
    );
    assert.deepEqual(Object.keys(bridgeMembers), [topology.containerId]);
    assert.equal(bridgeMembers[topology.containerId].Name, topology.container);
    assert.equal(
      docker([
        "volume",
        "inspect",
        "--format",
        "{{.Name}}|{{.Driver}}|{{json .Labels}}",
        topology.volume,
      ]),
      `${topology.volume}|local|{"com.docker.volume.anonymous":""}`,
    );
    const mounts = JSON.parse(
      docker(["inspect", "--format", "{{json .Mounts}}", topology.container]),
    );
    assert.deepEqual(
      mounts
        .filter((mount) => mount.Name === topology.volume)
        .map((mount) => ({ Destination: mount.Destination, RW: mount.RW })),
      [{ Destination: "/var/lib/postgresql/data", RW: true }],
    );
    assert.equal(
      docker([
        "image",
        "inspect",
        "--format",
        "{{range .RepoDigests}}{{println .}}{{end}}",
        "pgvector/pgvector:pg16",
      ]),
      topology.image,
    );
    assert.equal(
      sql("SELECT current_database() || '|' || current_user;"),
      "postgres|global",
    );
  });

  describe("authority matrix", () => {
    for (const vector of authorityCases) valueCase(vector);
    for (const vector of authorityErrorCases) errorCase(vector);
  });

  describe("blocker matrix", () => {
    for (const vector of blockerCases) valueCase(vector);
  });

  describe("suppression matrix", () => {
    for (const vector of suppressionCases) valueCase(vector);
  });

  describe("planner matrix", () => {
    for (const vector of plannerCases) valueCase(vector);
    for (const vector of plannerErrorCases) errorCase(vector);
    for (const vector of plannerRequiredScalarErrorCases) errorCase(vector);
  });

  describe("advisory matrix", () => {
    for (const vector of advisoryCases) valueCase(vector);
    for (const vector of advisoryErrorCases) errorCase(vector);
  });

  describe("private helper ACL matrix", () => {
    it("denies every private helper to app_user and PUBLIC", () => {
      for (const helperSignature of [
        signature.authority,
        signature.blocker,
        signature.suppression,
        signature.planner,
        signature.advisory,
      ]) {
        exactHelper("private helper ACL", helperSignature);
        const [schema, functionName, argumentsText] =
          catalogIdentity[helperSignature].split("|");
        assert.equal(
          sql(`SELECT
            has_function_privilege('app_user',p.oid,'EXECUTE')::text||'|'||
            has_function_privilege('public',p.oid,'EXECUTE')::text
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid=p.pronamespace
          WHERE n.nspname='${schema}'
            AND p.proname='${functionName}'
            AND oidvectortypes(p.proargtypes)='${argumentsText}';`),
          "false|false",
        );
      }
    });

    it("binds the exact canonical-JSON predecessor catalog and definition", () => {
      assert.equal(
        sql(`SELECT
          pg_get_function_result(p.oid)||'|'||
          l.lanname||'|'||
          pg_get_userbyid(p.proowner)||'|'||
          p.prosecdef::text||'|'||p.provolatile::text||'|'||
          p.proparallel::text||'|'||p.proretset::text||'|'||
          p.proleakproof::text||'|'||p.proisstrict::text||'|'||
          p.prokind::text||'|'||
          coalesce(array_to_string(p.proconfig,','),'<NULL>')||'|'||
          coalesce((
            SELECT string_agg(
              CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END||':'||
              acl.privilege_type||':'||acl.is_grantable::text||':'||
              pg_get_userbyid(acl.grantor),
              ',' ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(acl.grantee) END COLLATE "C"
            )
            FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          ),'')||'|'||
          encode(public.digest(
            convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'
          ),'hex')
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_language l ON l.oid=p.prolang
        WHERE n.nspname='public'
          AND p.proname='raw_source_canonical_json_v1'
          AND oidvectortypes(p.proargtypes)='jsonb';`),
        "text|plpgsql|global|false|i|u|false|false|true|f|search_path=pg_catalog, public|global:EXECUTE:false:global|e9e958c0823409435f4bc1aa093b9c6bd1851eb401b5f07278c224992317ca16",
      );
    });

    it("binds every final helper and command to its complete catalog contract", () => {
      assert.equal(
        sql(`SELECT count(*)||'|'||
          count(*) FILTER (WHERE oidvectortypes(p.proargtypes) IN (
            'text, jsonb','jsonb','text, text',
            'bigint, timestamp with time zone','text, text'
          ))
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND p.proname IN (
            'organization_identity_authority_from_raw_v1',
            'organization_identity_blocker_from_raw_v1',
            'organization_identity_canonical_suppression_value_v1',
            'organization_identity_plan_from_snapshot_v1',
            'organization_identity_acquire_advisory_until_v1',
            'resolve_organization_identity_for_raw_v1'
          );`),
        "6|6",
      );
      for (const helperSignature of Object.values(signature)) {
        exactHelper("complete catalog matrix", helperSignature);
        const [schema, functionName, argumentsText] =
          catalogIdentity[helperSignature].split("|");
        assert.equal(
          sql(`SELECT
            pg_get_function_result(p.oid)||'|'||
            l.lanname||'|'||pg_get_userbyid(p.proowner)||'|'||
            p.prosecdef::text||'|'||p.provolatile::text||'|'||
            p.proparallel::text||'|'||p.proretset::text||'|'||
            p.proleakproof::text||'|'||p.proisstrict::text||'|'||
            p.prokind::text||'|'||
            coalesce(array_to_string(p.proconfig,','),'<NULL>')||'|'||
            coalesce((
              SELECT string_agg(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                  ELSE pg_get_userbyid(acl.grantee) END||':'||
                acl.privilege_type||':'||acl.is_grantable::text||':'||
                pg_get_userbyid(acl.grantor),
                ',' ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC'
                  ELSE pg_get_userbyid(acl.grantee) END COLLATE "C"
              )
              FROM aclexplode(
                coalesce(p.proacl,acldefault('f',p.proowner))
              ) acl
            ),'')
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_language l ON l.oid=p.prolang
          WHERE n.nspname='${schema}'
            AND p.proname='${functionName}'
            AND oidvectortypes(p.proargtypes)='${argumentsText}';`),
          catalogContract[helperSignature],
        );
      }
    });

    it("binds security-relevant roles, transitive owner reachability and applicable defaults", () => {
      assert.equal(
        sql(`SELECT 'current_owner='||current_user;
        SELECT rolname||'|'||rolsuper||'|'||rolcreaterole||'|'||
          rolcreatedb||'|'||rolreplication||'|'||rolbypassrls
        FROM pg_roles
        WHERE rolname='app_user';
        WITH RECURSIVE capability_paths(start_role,reached_role,mode) AS (
          SELECT membership.member,membership.roleid,capability.mode
          FROM pg_auth_members AS membership
          CROSS JOIN LATERAL (VALUES
            ('inherit'::text,membership.inherit_option),
            ('set_role'::text,membership.set_option)
          ) AS capability(mode,enabled)
          WHERE capability.enabled
          UNION
          SELECT path.start_role,next_membership.roleid,path.mode
          FROM capability_paths AS path
          JOIN pg_auth_members AS next_membership
            ON next_membership.member=path.reached_role
          WHERE (
            path.mode='inherit' AND next_membership.inherit_option
          ) OR (
            path.mode='set_role' AND next_membership.set_option
          )
        )
        SELECT 'effective_inherit_paths='||count(*) FILTER (
            WHERE mode='inherit'
              AND reached_role='global'::regrole
              AND start_role<>'global'::regrole
          )||'|effective_set_role_paths='||count(*) FILTER (
            WHERE mode='set_role'
              AND reached_role='global'::regrole
              AND start_role<>'global'::regrole
          )
        FROM capability_paths;
        SELECT 'applicable_nonowner_function_defaults='||count(*)
        FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
        WHERE defaults.defaclrole='global'::regrole
          AND defaults.defaclobjtype='f'
          AND defaults.defaclnamespace IN (0,'public'::regnamespace)
          AND acl.grantee<>'global'::regrole::oid
          AND (acl.privilege_type='EXECUTE' OR acl.is_grantable);`),
        [
          "current_owner=global",
          "app_user|false|false|false|false|false",
          "effective_inherit_paths=0|effective_set_role_paths=0",
          "applicable_nonowner_function_defaults=0",
        ].join("\n"),
      );
    });
  });

  describe("migration admission matrix", { concurrency: 1 }, () => {
    it("admits an unrelated-schema non-owner function default and normalizes final ACL", () => {
      const database = "task_a3_fix3_unrelated_default_positive";
      withAdmissionDatabase(database, () => {
        sqlDatabase(
          database,
          `CREATE SCHEMA task_a3_fix3_unrelated AUTHORIZATION global;
           ALTER DEFAULT PRIVILEGES FOR ROLE global
             IN SCHEMA task_a3_fix3_unrelated
             GRANT EXECUTE ON FUNCTIONS TO app_user WITH GRANT OPTION;`,
        );
        assert.equal(
          sqlDatabase(
            database,
            `SELECT
              count(*) FILTER (
                WHERE defaults.defaclnamespace='task_a3_fix3_unrelated'::regnamespace
                  AND acl.grantee='app_user'::regrole::oid
              )||'|'||
              count(*) FILTER (
                WHERE defaults.defaclnamespace IN (0,'public'::regnamespace)
                  AND acl.grantee<>'global'::regrole::oid
                  AND (acl.privilege_type='EXECUTE' OR acl.is_grantable)
              )
             FROM pg_default_acl defaults
             CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
             WHERE defaults.defaclrole='global'::regrole
               AND defaults.defaclobjtype='f';`,
          ),
          "1|0",
        );
        assertAdmissionSuccess(database);
      });
    });

    it("admits applicable owner-only global and public defaults and normalizes grant options", () => {
      const database = "task_a3_fix3_owner_defaults_positive";
      withAdmissionDatabase(database, () => {
        sqlDatabase(
          database,
          `ALTER DEFAULT PRIVILEGES FOR ROLE global
             REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
           ALTER DEFAULT PRIVILEGES FOR ROLE global
             GRANT EXECUTE ON FUNCTIONS TO global WITH GRANT OPTION;
           ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public
             GRANT EXECUTE ON FUNCTIONS TO global WITH GRANT OPTION;`,
        );
        assert.equal(
          sqlDatabase(
            database,
            `SELECT count(*)
             FROM pg_default_acl defaults
             CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
             WHERE defaults.defaclrole='global'::regrole
               AND defaults.defaclobjtype='f'
               AND defaults.defaclnamespace IN (0,'public'::regnamespace)
               AND acl.grantee='global'::regrole::oid;`,
          ),
          "2",
        );
        assertAdmissionSuccess(database);
      });
    });

    it("rejects a global applicable non-owner function default before first CREATE", () => {
      const database = "task_a3_fix3_global_default_negative";
      withAdmissionDatabase(database, () => {
        sqlDatabase(
          database,
          `ALTER DEFAULT PRIVILEGES FOR ROLE global
             GRANT EXECUTE ON FUNCTIONS TO app_user WITH GRANT OPTION;`,
        );
        assertAdmissionFailure(database);
      });
    });

    it("rejects a public applicable non-owner function default before first CREATE", () => {
      const database = "task_a3_fix3_public_default_negative";
      withAdmissionDatabase(database, () => {
        sqlDatabase(
          database,
          `ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public
             GRANT EXECUTE ON FUNCTIONS TO app_user WITH GRANT OPTION;`,
        );
        assertAdmissionFailure(database);
      });
    });

    it("rejects direct executable inheritance even when the member role is NOINHERIT", () => {
      const database = "task_a3_fix3_direct_membership_negative";
      dropAdmissionRoles();
      try {
        withAdmissionDatabase(database, () => {
          sqlDatabase(
            "global",
            `CREATE ROLE task_a3_fix3_direct_member NOLOGIN NOINHERIT;
             GRANT global TO task_a3_fix3_direct_member
               WITH INHERIT TRUE, SET FALSE;`,
          );
          assert.equal(
            sqlDatabase(
              database,
              `SELECT member_role.rolinherit||'|'||
                membership.inherit_option||'|'||membership.set_option
               FROM pg_auth_members membership
               JOIN pg_roles member_role ON member_role.oid=membership.member
               WHERE member_role.rolname='task_a3_fix3_direct_member'
                 AND membership.roleid='global'::regrole;`,
            ),
            "false|true|false",
          );
          assertAdmissionFailure(database);
        });
      } finally {
        dropAdmissionRoles();
      }
    });

    it("rejects a transitive executable SET ROLE path", () => {
      const database = "task_a3_fix3_transitive_membership_negative";
      dropAdmissionRoles();
      try {
        withAdmissionDatabase(database, () => {
          sqlDatabase(
            "global",
            `CREATE ROLE task_a3_fix3_transitive_leaf NOLOGIN NOINHERIT;
             CREATE ROLE task_a3_fix3_transitive_mid NOLOGIN NOINHERIT;
             GRANT global TO task_a3_fix3_transitive_mid
               WITH INHERIT FALSE, SET TRUE;
             GRANT task_a3_fix3_transitive_mid TO task_a3_fix3_transitive_leaf
               WITH INHERIT FALSE, SET TRUE;`,
          );
          assertAdmissionFailure(database);
        });
      } finally {
        dropAdmissionRoles();
      }
    });

    it("admits inert membership with neither inheritance nor SET ROLE capability", () => {
      const database = "task_a3_fix3_inert_membership_positive";
      dropAdmissionRoles();
      try {
        withAdmissionDatabase(database, () => {
          sqlDatabase(
            "global",
            `CREATE ROLE task_a3_fix3_inert_member NOLOGIN INHERIT;
             GRANT global TO task_a3_fix3_inert_member
               WITH INHERIT FALSE, SET FALSE;`,
          );
          assert.equal(
            sqlDatabase(
              database,
              `SELECT member_role.rolinherit||'|'||
                membership.inherit_option||'|'||membership.set_option
               FROM pg_auth_members membership
               JOIN pg_roles member_role ON member_role.oid=membership.member
               WHERE member_role.rolname='task_a3_fix3_inert_member'
                 AND membership.roleid='global'::regrole;`,
            ),
            "true|false|false",
          );
          assertAdmissionSuccess(database);
        });
      } finally {
        dropAdmissionRoles();
      }
    });

    it("uses mode-bearing UNION recursion for PG16 cycle-safe capability closure", () => {
      assert.match(sql("SHOW server_version_num;"), /^16\d{4}$/u);
      const migration = readFileSync(currentMigrationPath, "utf8");
      assert.match(
        migration,
        /WITH RECURSIVE capability_paths\(start_role, reached_role, mode\)/u,
      );
      assert.match(migration, /membership\.inherit_option/u);
      assert.match(migration, /membership\.set_option/u);
      assert.match(migration, /UNION\s+SELECT path\.start_role/u);
      assert.doesNotMatch(migration, /UNION ALL\s+SELECT path\.start_role/u);
      assert.doesNotMatch(
        migration,
        /(?:INSERT|UPDATE|DELETE)\s+pg_auth_members/iu,
      );
    });
  });

  describe("two-ID command matrix", () => {
    it("persists the exact registry-bound result from transaction-arranged workspace and Raw facts", () => {
      exactHelper("valid two-ID command", signature.command);
      assert.equal(
        sql(`BEGIN;
          INSERT INTO workspace(id,name,updated_at)
          VALUES ('71000000-0000-4000-8000-000000000001','Task A2 command',now());
          INSERT INTO canonical_company(id,workspace_id,name,domain,country,status,dedupe_key,version,created_at,updated_at)
          VALUES ('73000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','Bound Root','bound-root.example','DE','NEW','d:bound-root.example',1,now(),now());
          INSERT INTO monitored_source(id,provider_key,source_key,label,config,status,created_at,updated_at)
          VALUES ('74000000-0000-4000-8000-000000000001','registry','task-a2:registry-source','Task A2 registry source','{}'::jsonb,'ACTIVE',now(),now());
          INSERT INTO source_entity(id,source_id,external_id,entity_kind,name,domain,country,cleaned,content_hash,created_at,updated_at)
          VALUES ('75000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001','company-1','company','Acme GmbH','a2-valid.example','DE','{}'::jsonb,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now(),now());
          INSERT INTO raw_source_record(id,workspace_id,source_entity_id,provider_key,source_class,payload,source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot,created_at)
          VALUES ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000001','registry','company_registry','{"externalId":"company-1","name":"Acme GmbH","domain":"a2-valid.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"de-12/34"}}'::jsonb,'https://registry.example/companies/1',now(),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','registry/v1','task-a2:valid','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now());
          INSERT INTO organization_identifier(workspace_id,company_id,scheme,jurisdiction,normalized_value,authority_provider_key,raw_record_id,confidence,normalizer_version,validator_version,provenance,status)
          VALUES ('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','registry-id','DE','DE1234','registry','72000000-0000-4000-8000-000000000001',1,'organization-identity-authority/v1','registry-id-v1','{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"}'::jsonb,'ACTIVE');
          SET SESSION AUTHORIZATION app_user;
          SET LOCAL lock_timeout = '5s';
          SET LOCAL statement_timeout = '60s';
          SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000001';
          SELECT to_jsonb(result)::text AS command_result
          FROM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001') AS result
          \\gset task_a2_registry_
          WITH command_result AS (
            SELECT :'task_a2_registry_command_result'::jsonb AS value
          ), link_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'raw_record_id', raw_record_id,
                    'canonical_type', canonical_type,
                    'canonical_id', canonical_id,
                    'match_rule', match_rule,
                    'confidence', confidence,
                    'status', status,
                    'resolver_version', resolver_version,
                    'input_hash', input_hash,
                    'conflict_id', conflict_id
                  ) ORDER BY canonical_id
                ),
                '[]'::jsonb
              ) AS rows
            FROM identity_link
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
              AND raw_record_id='72000000-0000-4000-8000-000000000001'
          ), identifier_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  scheme||':'||jurisdiction||':'||normalized_value
                  ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS keys,
              coalesce(
                jsonb_agg(DISTINCT company_id::text),
                '[]'::jsonb
              ) AS company_ids,
              coalesce(
                jsonb_agg(DISTINCT raw_record_id::text),
                '[]'::jsonb
              ) AS raw_record_ids,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'company_id', company_id,
                    'scheme', scheme,
                    'identifier_key', scheme||':'||jurisdiction||':'||normalized_value,
                    'jurisdiction', jurisdiction,
                    'normalized_value', normalized_value,
                    'authority_provider_key', authority_provider_key,
                    'raw_record_id', raw_record_id,
                    'conflict_id', conflict_id,
                    'confidence', confidence,
                    'normalizer_version', normalizer_version,
                    'validator_version', validator_version,
                    'provenance', provenance,
                    'status', status,
                    'revoked_at', revoked_at
                  ) ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS rows
            FROM organization_identifier
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
              AND raw_record_id='72000000-0000-4000-8000-000000000001'
          ), party_readback AS (
            SELECT count(*)::integer AS row_count
            FROM organization_identity_conflict_party
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
          )
          SELECT (jsonb_build_object(
            'returned', command_result.value,
            'persisted', jsonb_build_object(
              'identity_link_count', link_readback.row_count,
              'identity_links', link_readback.rows,
              'identifier_count', identifier_readback.row_count,
              'identifier_keys', identifier_readback.keys,
              'identifiers', identifier_readback.rows
            ),
            'mechanical_consistency', jsonb_build_object(
              'company_matches_identity_link',
                command_result.value->>'company_id' = link_readback.rows->0->>'canonical_id',
              'company_matches_identifiers',
                identifier_readback.company_ids = jsonb_build_array(command_result.value->>'company_id'),
              'conflict_matches_identity_link',
                command_result.value->'conflict_id' IS NOT DISTINCT FROM link_readback.rows->0->'conflict_id',
              'identifier_count_matches',
                (command_result.value->>'identifier_count')::integer = identifier_readback.row_count,
              'input_hash_matches_identity_link',
                command_result.value->>'input_hash' = link_readback.rows->0->>'input_hash',
              'match_rule_matches_identity_link',
                command_result.value->>'match_rule' = link_readback.rows->0->>'match_rule',
              'party_count_matches',
                (command_result.value->>'party_count')::integer = party_readback.row_count,
              'raw_matches_identity_link',
                command_result.value->>'raw_record_id' = link_readback.rows->0->>'raw_record_id',
              'raw_matches_identifiers',
                identifier_readback.raw_record_ids = jsonb_build_array(command_result.value->>'raw_record_id')
            )
          )='{"returned":{"outcome_kind":"bound","raw_record_id":"72000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","conflict_id":null,"match_rule":"identity_v2","input_hash":"e2d767b2b0e679b1f039709da028010b595ddff946115d8531e654f3fa98eb14","conflict_fingerprint":null,"replayed":false,"company_created":false,"identifier_count":2,"party_count":0},"persisted":{"identity_link_count":1,"identity_links":[{"workspace_id":"71000000-0000-4000-8000-000000000001","raw_record_id":"72000000-0000-4000-8000-000000000001","canonical_type":"company","canonical_id":"73000000-0000-4000-8000-000000000001","match_rule":"identity_v2","confidence":1,"status":"ACTIVE","resolver_version":"organization-identity-resolver/v1","input_hash":"e2d767b2b0e679b1f039709da028010b595ddff946115d8531e654f3fa98eb14","conflict_id":null}],"identifier_count":2,"identifier_keys":["domain:GLOBAL:a2-valid.example","registry-id:DE:DE1234"],"identifiers":[{"workspace_id":"71000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","scheme":"domain","identifier_key":"domain:GLOBAL:a2-valid.example","jurisdiction":"GLOBAL","normalized_value":"a2-valid.example","authority_provider_key":"registry","raw_record_id":"72000000-0000-4000-8000-000000000001","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"domain-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"},"status":"ACTIVE","revoked_at":null},{"workspace_id":"71000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","scheme":"registry-id","identifier_key":"registry-id:DE:DE1234","jurisdiction":"DE","normalized_value":"DE1234","authority_provider_key":"registry","raw_record_id":"72000000-0000-4000-8000-000000000001","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"registry-id-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"},"status":"ACTIVE","revoked_at":null}]},"mechanical_consistency":{"company_matches_identity_link":true,"company_matches_identifiers":true,"conflict_matches_identity_link":true,"identifier_count_matches":true,"input_hash_matches_identity_link":true,"match_rule_matches_identity_link":true,"party_count_matches":true,"raw_matches_identity_link":true,"raw_matches_identifiers":true}}'::jsonb)::text
          FROM command_result, link_readback, identifier_readback, party_readback;
          RESET SESSION AUTHORIZATION;
          ROLLBACK;`),
        "true",
      );
    });

    it("persists a different directory-bound result with one literal authority", () => {
      exactHelper("second valid two-ID command", signature.command);
      assert.equal(
        sql(`BEGIN;
          INSERT INTO workspace(id,name,updated_at)
          VALUES ('71000000-0000-4000-8000-000000000002','Task A2 second command',now());
          INSERT INTO canonical_company(id,workspace_id,name,domain,country,status,dedupe_key,version,created_at,updated_at)
          VALUES ('73000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','Secondary Root','secondary-root.example','DE','NEW','d:secondary-root.example',1,now(),now());
          INSERT INTO monitored_source(id,provider_key,source_key,label,config,status,created_at,updated_at)
          VALUES ('74000000-0000-4000-8000-000000000002','directory','task-a2:directory-source','Task A2 directory source','{}'::jsonb,'ACTIVE',now(),now());
          INSERT INTO source_entity(id,source_id,external_id,entity_kind,name,domain,country,cleaned,content_hash,created_at,updated_at)
          VALUES ('75000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000002','directory:a2-secondary.example','company','Secondary GmbH','a2-secondary.example','DE','{}'::jsonb,'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',now(),now());
          INSERT INTO raw_source_record(id,workspace_id,source_entity_id,provider_key,source_class,payload,source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot,created_at)
          VALUES ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','75000000-0000-4000-8000-000000000002','directory','industry_data','{"externalId":"directory:a2-secondary.example","name":"Secondary GmbH","domain":"a2-secondary.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/2","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/2","fetchedAt":"2026-08-26T12:00:00.000Z","contentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","parserVersion":"registry/v1"}}'::jsonb,'https://registry.example/companies/2',now(),'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','registry/v1','task-a2:second-valid','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now());
          INSERT INTO organization_identifier(workspace_id,company_id,scheme,jurisdiction,normalized_value,authority_provider_key,raw_record_id,confidence,normalizer_version,validator_version,provenance,status)
          VALUES ('71000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000002','domain','GLOBAL','a2-secondary.example','directory','72000000-0000-4000-8000-000000000002',1,'organization-identity-authority/v1','domain-v1','{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000002","providerKey":"directory"}'::jsonb,'ACTIVE');
          SET SESSION AUTHORIZATION app_user;
          SET LOCAL lock_timeout = '5s';
          SET LOCAL statement_timeout = '60s';
          SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000002';
          SELECT to_jsonb(result)::text AS command_result
          FROM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002') AS result
          \\gset task_a2_directory_
          WITH command_result AS (
            SELECT :'task_a2_directory_command_result'::jsonb AS value
          ), link_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'raw_record_id', raw_record_id,
                    'canonical_type', canonical_type,
                    'canonical_id', canonical_id,
                    'match_rule', match_rule,
                    'confidence', confidence,
                    'status', status,
                    'resolver_version', resolver_version,
                    'input_hash', input_hash,
                    'conflict_id', conflict_id
                  ) ORDER BY canonical_id
                ),
                '[]'::jsonb
              ) AS rows
            FROM identity_link
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
              AND raw_record_id='72000000-0000-4000-8000-000000000002'
          ), identifier_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  scheme||':'||jurisdiction||':'||normalized_value
                  ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS keys,
              coalesce(
                jsonb_agg(DISTINCT company_id::text),
                '[]'::jsonb
              ) AS company_ids,
              coalesce(
                jsonb_agg(DISTINCT raw_record_id::text),
                '[]'::jsonb
              ) AS raw_record_ids,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'company_id', company_id,
                    'scheme', scheme,
                    'identifier_key', scheme||':'||jurisdiction||':'||normalized_value,
                    'jurisdiction', jurisdiction,
                    'normalized_value', normalized_value,
                    'authority_provider_key', authority_provider_key,
                    'raw_record_id', raw_record_id,
                    'conflict_id', conflict_id,
                    'confidence', confidence,
                    'normalizer_version', normalizer_version,
                    'validator_version', validator_version,
                    'provenance', provenance,
                    'status', status,
                    'revoked_at', revoked_at
                  ) ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS rows
            FROM organization_identifier
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
              AND raw_record_id='72000000-0000-4000-8000-000000000002'
          ), party_readback AS (
            SELECT count(*)::integer AS row_count
            FROM organization_identity_conflict_party
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
          )
          SELECT (jsonb_build_object(
            'returned', command_result.value,
            'persisted', jsonb_build_object(
              'identity_link_count', link_readback.row_count,
              'identity_links', link_readback.rows,
              'identifier_count', identifier_readback.row_count,
              'identifier_keys', identifier_readback.keys,
              'identifiers', identifier_readback.rows
            ),
            'mechanical_consistency', jsonb_build_object(
              'company_matches_identity_link',
                command_result.value->>'company_id' = link_readback.rows->0->>'canonical_id',
              'company_matches_identifiers',
                identifier_readback.company_ids = jsonb_build_array(command_result.value->>'company_id'),
              'conflict_matches_identity_link',
                command_result.value->'conflict_id' IS NOT DISTINCT FROM link_readback.rows->0->'conflict_id',
              'identifier_count_matches',
                (command_result.value->>'identifier_count')::integer = identifier_readback.row_count,
              'input_hash_matches_identity_link',
                command_result.value->>'input_hash' = link_readback.rows->0->>'input_hash',
              'match_rule_matches_identity_link',
                command_result.value->>'match_rule' = link_readback.rows->0->>'match_rule',
              'party_count_matches',
                (command_result.value->>'party_count')::integer = party_readback.row_count,
              'raw_matches_identity_link',
                command_result.value->>'raw_record_id' = link_readback.rows->0->>'raw_record_id',
              'raw_matches_identifiers',
                identifier_readback.raw_record_ids = jsonb_build_array(command_result.value->>'raw_record_id')
            )
          )='{"returned":{"outcome_kind":"bound","raw_record_id":"72000000-0000-4000-8000-000000000002","company_id":"73000000-0000-4000-8000-000000000002","conflict_id":null,"match_rule":"identity_v2","input_hash":"1b1116123797795d5a9d955af10dcf94dff616c557f7d89882c70c3ee44a9393","conflict_fingerprint":null,"replayed":false,"company_created":false,"identifier_count":1,"party_count":0},"persisted":{"identity_link_count":1,"identity_links":[{"workspace_id":"71000000-0000-4000-8000-000000000002","raw_record_id":"72000000-0000-4000-8000-000000000002","canonical_type":"company","canonical_id":"73000000-0000-4000-8000-000000000002","match_rule":"identity_v2","confidence":1,"status":"ACTIVE","resolver_version":"organization-identity-resolver/v1","input_hash":"1b1116123797795d5a9d955af10dcf94dff616c557f7d89882c70c3ee44a9393","conflict_id":null}],"identifier_count":1,"identifier_keys":["domain:GLOBAL:a2-secondary.example"],"identifiers":[{"workspace_id":"71000000-0000-4000-8000-000000000002","company_id":"73000000-0000-4000-8000-000000000002","scheme":"domain","identifier_key":"domain:GLOBAL:a2-secondary.example","jurisdiction":"GLOBAL","normalized_value":"a2-secondary.example","authority_provider_key":"directory","raw_record_id":"72000000-0000-4000-8000-000000000002","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"domain-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000002","providerKey":"directory"},"status":"ACTIVE","revoked_at":null}]},"mechanical_consistency":{"company_matches_identity_link":true,"company_matches_identifiers":true,"conflict_matches_identity_link":true,"identifier_count_matches":true,"input_hash_matches_identity_link":true,"match_rule_matches_identity_link":true,"party_count_matches":true,"raw_matches_identity_link":true,"raw_matches_identifiers":true}}'::jsonb)::text
          FROM command_result, link_readback, identifier_readback, party_readback;
          RESET SESSION AUTHORIZATION;
          ROLLBACK;`),
        "true",
      );
    });

    it("rejects a malformed Raw ID with the exact machine code and value", () => {
      exactHelper("malformed two-ID command", signature.command);
      exactMachineError(
        `PERFORM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000001','not-a-uuid');`,
        "P0001|IDENTITY_RESOLUTION_INPUT_INVALID",
        `BEGIN;
         SET SESSION AUTHORIZATION app_user;
         SET LOCAL lock_timeout = '5s';
         SET LOCAL statement_timeout = '60s';
         SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000001';`,
        `RESET SESSION AUTHORIZATION;
         ROLLBACK;`,
      );
    });
  });
});
