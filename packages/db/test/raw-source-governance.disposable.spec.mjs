// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationRoot = resolve(repositoryRoot, "packages/db/prisma/migrations");
const schemaMigrationName = "20260826090000_raw_source_governance_schema";
const backfillMigrationName = "20260826100000_raw_source_governance_backfill";
const constraintsMigrationName =
  "20260826110000_raw_source_governance_constraints";
const writerMigrationName = "20260826120000_raw_source_governance_writer";
const writerHardeningMigrationName =
  "20260826130000_raw_source_governance_writer_hardening";
const historicalCleanupMigrationName =
  "20260826140000_raw_source_governance_historical_cleanup";
const statusHardeningMigrationName =
  "20260826150000_raw_source_governance_status_hardening";
const finalCorrectionMigrationName =
  "20260826160000_raw_source_governance_final_correction";
const writerParityMigrationName =
  "20260826170000_raw_source_governance_writer_parity";
const evidenceChainMigrationName =
  "20260826180000_raw_source_evidence_chain_correction";
const pathSanitizerMigrationName =
  "20260826190000_raw_source_governance_path_sanitizer";
const pathCleanupMigrationName =
  "20260826200000_raw_source_path_evidence_cleanup";
const storedFieldAdapterMigrationName =
  "20260826210000_raw_source_stored_field_path_adapter";
const storedFieldCleanupMigrationName =
  "20260826220000_raw_source_stored_field_cleanup";
const siteSectionContractMigrationName =
  "20260826230000_raw_source_site_section_key_contract";
const siteSectionCleanupMigrationName =
  "20260826240000_raw_source_site_section_cleanup";
const tedIdentifierContactGateMigrationName =
  "20260826250000_raw_source_ted_identifier_contact_gate";
const schemaMigrationPath = resolve(
  migrationRoot,
  schemaMigrationName,
  "migration.sql",
);
const backfillMigrationPath = resolve(
  migrationRoot,
  backfillMigrationName,
  "migration.sql",
);
const constraintsMigrationPath = resolve(
  migrationRoot,
  constraintsMigrationName,
  "migration.sql",
);
const writerMigrationPath = resolve(
  migrationRoot,
  writerMigrationName,
  "migration.sql",
);
const writerHardeningMigrationPath = resolve(
  migrationRoot,
  writerHardeningMigrationName,
  "migration.sql",
);
const historicalCleanupMigrationPath = resolve(
  migrationRoot,
  historicalCleanupMigrationName,
  "migration.sql",
);
const statusHardeningMigrationPath = resolve(
  migrationRoot,
  statusHardeningMigrationName,
  "migration.sql",
);
const finalCorrectionMigrationPath = resolve(
  migrationRoot,
  finalCorrectionMigrationName,
  "migration.sql",
);
const writerParityMigrationPath = resolve(
  migrationRoot,
  writerParityMigrationName,
  "migration.sql",
);
const evidenceChainMigrationPath = resolve(
  migrationRoot,
  evidenceChainMigrationName,
  "migration.sql",
);
const pathSanitizerMigrationPath = resolve(
  migrationRoot,
  pathSanitizerMigrationName,
  "migration.sql",
);
const pathCleanupMigrationPath = resolve(
  migrationRoot,
  pathCleanupMigrationName,
  "migration.sql",
);
const storedFieldAdapterMigrationPath = resolve(
  migrationRoot,
  storedFieldAdapterMigrationName,
  "migration.sql",
);
const storedFieldCleanupMigrationPath = resolve(
  migrationRoot,
  storedFieldCleanupMigrationName,
  "migration.sql",
);
const siteSectionContractMigrationPath = resolve(
  migrationRoot,
  siteSectionContractMigrationName,
  "migration.sql",
);
const siteSectionCleanupMigrationPath = resolve(
  migrationRoot,
  siteSectionCleanupMigrationName,
  "migration.sql",
);
const tedIdentifierContactGateMigrationPath = resolve(
  migrationRoot,
  tedIdentifierContactGateMigrationName,
  "migration.sql",
);
const baselineLastMigration = "20260824130000_personal_artifact_cleanup";
const container = process.env.TASK6A_PG_CONTAINER;
const port = process.env.TASK6A_PG_PORT;
const databases = Object.freeze({
  fresh: "task6a_raw_fresh",
  upgrade: "task6a_raw_upgrade",
  rollback: "task6a_raw_rollback",
  backfillRollback: "task6a_raw_backfill_rollback",
  writerRollback: "task6a_raw_writer_rollback",
  writerHardeningRollback: "task6a_raw_writer_hardening_rollback",
  historicalCleanupRollback: "task6a_raw_history_cleanup_rollback",
  statusHardeningRollback: "task6a_raw_status_hardening_rollback",
  statusHardeningMinimal: "task6a_raw_status_hardening_minimal",
  finalCorrectionRollback: "task6a_raw_final_correction_rollback",
  writerParityRollback: "task6a_raw_writer_parity_rollback",
  evidenceChainRollback: "task6a_raw_evidence_chain_rollback",
  pathSanitizerRollback: "task6a_raw_path_sanitizer_rollback",
  pathCleanupRollback: "task6a_raw_path_cleanup_rollback",
  pathCleanup: "task6a_raw_path_cleanup",
  storedField: "task6a_raw_stored_field",
  storedFieldAdapterRollback: "task6a_raw_stored_adapter_rollback",
  storedFieldCleanupRollback: "task6a_raw_stored_cleanup_rollback",
  siteSectionContractRollback: "task6a_raw_site_section_contract_rollback",
  siteSectionCleanupRollback: "task6a_raw_site_section_cleanup_rollback",
  tedIdentifierContactGateRollback:
    "task6a_raw_ted_identifier_contact_gate_rollback",
  dottedReceipt: "task6a_raw_dotted_receipt",
  locks: "task6a_raw_locks",
});

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000002";
const RUN_A = "20000000-0000-4000-8000-000000000001";
const RUN_B = "20000000-0000-4000-8000-000000000002";
const SAFE_RAW_A = "30000000-0000-4000-8000-000000000001";
const RESTRICTED_RAW_A = "30000000-0000-4000-8000-000000000002";
const SAFE_RAW_B = "30000000-0000-4000-8000-000000000003";
const EVIDENCE_CHAIN_RAW_A = "30000000-0000-4000-8000-000000000004";
const DOTTED_PRODUCTS_RAW_A = "30000000-0000-4000-8000-000000000005";
const SITE_SECTION_RAW_A = "30000000-0000-4000-8000-000000000006";
const SOURCE = "40000000-0000-4000-8000-000000000001";
const FETCH = "50000000-0000-4000-8000-000000000001";
const SOURCE_ENTITY = "60000000-0000-4000-8000-000000000001";
const COMPANY_A = "70000000-0000-4000-8000-000000000001";
const COMPANY_TENDER = "70000000-0000-4000-8000-000000000101";
const COMPANY_CLEARANCE = "70000000-0000-4000-8000-000000000102";
const COMPANY_SOURCES_SOUGHT = "70000000-0000-4000-8000-000000000103";
const COMPANY_WEBSITE_CHANGE = "70000000-0000-4000-8000-000000000104";
const COMPANY_LINKED_RECOVERY = "70000000-0000-4000-8000-000000000105";
const COMPANY_TENDER_V3 = "70000000-0000-4000-8000-000000000115";
const COMPANY_MINIMAL_1500 = "70000000-0000-4000-8000-000000000150";
const LINKED_RECOVERY_RAW = "30000000-0000-4000-8000-000000000105";
const LOCKED_RAW = "90000000-0000-4000-8000-000000000001";
const POLICY_A = "a0000000-0000-4000-8000-000000000001";
const POLICY_B = "a0000000-0000-4000-8000-000000000002";
const POLICY_TED = "a0000000-0000-4000-8000-000000000025";
const EVIDENCE_CHAIN_ORIGINAL_VALUE_HASH =
  "2613c94b602988c61f1b56c42e51b814a1310baee6a73b999be84460472a7be7";
const EVIDENCE_CHAIN_PREDECESSOR_RECEIPT_HASH =
  "c3c29511a75ec65ac77a677770336c5adb1f0936d94c132139edd11382b2caec";
const DOTTED_PRODUCTS_ORIGINAL_VALUE_HASH =
  "e97c88ca4b437bca8733e84c282fe070cf75af0bac750c818fed33c72d23b6f6";
const WELL_KNOWN_SITE_SECTION_ORIGINAL_VALUE_HASH =
  "b7bb67490a2371c33f625125ff0f25a55f9c5dc7af43c4962b9c32742c7d7bb0";
const PRODUCTS_SITE_SECTION_ORIGINAL_VALUE_HASH =
  "a8fda5acab00edc40db93c7fd977449ea0eb0c9633dd0f22b3153664dd08084d";
const UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH =
  "9b85fcc354a642b4274b3fbf3751b5ca66b54b8653c4e47e62712502d48f2f8d";
const MIXED_SITE_SECTION_ORIGINAL_VALUE_HASH =
  "3d8ee7ad8c041cef294161b8e02d97da50d708b6add4dcff50ff67db4fac286a";
const POST_2200_UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH =
  "81274b3550f64bae21465854464f7a7a83c6e34f309039e49d04973e983dc090";
const TENDER_V2_CURRENT_RECEIPT_HASH =
  "e4e8cb71abd5f7edf9c850b8195913e6453284f0b7c443c93083c804de9bc9ca";
const TENDER_V3_CURRENT_RECEIPT_HASH =
  "5d2c9d65fd8e25089eaf9a782169b358196b06a083a37da24262c3598a26945c";

let baselineDirectory;
let firstDeployOutput = "";
let secondDeployOutput = "";
let baselineDeployOutput = "";
let injectedRollbackOutput = "";
let injectedBackfillRollbackOutput = "";
let injectedWriterRollbackOutput = "";
let injectedWriterHardeningRollbackOutput = "";
let injectedHistoricalCleanupRollbackOutput = "";
let injectedStatusHardeningRollbackOutput = "";
let injectedFinalCorrectionRollbackOutput = "";
let injectedWriterParityRollbackOutput = "";
let injectedEvidenceChainRollbackOutput = "";
let injectedPathSanitizerRollbackOutput = "";
let injectedPathCleanupRollbackOutput = "";
let injectedStoredFieldAdapterRollbackOutput = "";
let injectedStoredFieldCleanupRollbackOutput = "";
let injectedSiteSectionContractRollbackOutput = "";
let injectedSiteSectionCleanupRollbackOutput = "";
let injectedTedIdentifierContactGateRollbackOutput = "";
let storedFieldAfter2000 = "";
let minimal1500Before = "";
let minimal1500After = "";
let minimal1500SecondPass = "";

function requireTopology() {
  assert.match(container ?? "", /^codex-task6a-raw-pg-[a-z0-9-]+$/u);
  assert.match(port ?? "", /^[1-9][0-9]{3,4}$/u);
}

function ownerUrl(database) {
  requireTopology();
  return `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`;
}

function appUrl(database) {
  requireTopology();
  const localTestPassword = ["app", "pw"].join("_");
  return `postgresql://app_user:${localTestPassword}@127.0.0.1:${port}/${database}?schema=public`;
}

function runApplicationWriterFixture(database) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/api",
      "exec",
      "tsx",
      "test/fixtures/raw-source-app-writer.disposable.ts",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: appUrl(database) },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  assert.ok(line, result.stdout);
  return JSON.parse(line);
}

function dockerPsql(database, sql, options = {}) {
  requireTopology();
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
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (options.rejects) {
    assert.notEqual(result.status, 0, `SQL unexpectedly succeeded:\n${output}`);
    assert.match(output, options.rejects);
    return output;
  }
  assert.equal(result.status, 0, output);
  return result.stdout.trim();
}

function migrateDeploy(
  database,
  schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma"),
) {
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
      env: { ...process.env, DATABASE_URL: ownerUrl(database) },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function createBaselineMigrationTree() {
  const root = mkdtempSync(join(tmpdir(), "task6a-current-main-migrations-"));
  const prismaRoot = join(root, "prisma");
  const migrations = join(prismaRoot, "migrations");
  mkdirSync(migrations, { recursive: true, mode: 0o700 });
  cpSync(
    resolve(migrationRoot, "migration_lock.toml"),
    resolve(migrations, "migration_lock.toml"),
  );
  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name > baselineLastMigration) continue;
    cpSync(
      resolve(migrationRoot, entry.name),
      resolve(migrations, entry.name),
      { recursive: true },
    );
  }
  const schemaPath = resolve(prismaRoot, "schema.prisma");
  writeFileSync(
    schemaPath,
    [
      "datasource db {",
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      "}",
      "",
      "generator client {",
      '  provider = "prisma-client-js"',
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, schemaPath };
}

function asApp(workspaceId, sql) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id', '${workspaceId}', true);
    ${sql}
    COMMIT;
  `;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ingestKeyForWriterPayload(payload) {
  if (typeof payload.externalId === "string" && payload.externalId) {
    return `external:${sha256(payload.externalId)}`;
  }
  if (
    payload.identifier &&
    typeof payload.identifier.scheme === "string" &&
    typeof payload.identifier.value === "string"
  ) {
    return `identity:${sha256(
      canonicalJson({
        scheme: payload.identifier.scheme.toLowerCase(),
        value: payload.identifier.value,
      }),
    )}`;
  }
  return `identity:${sha256(
    canonicalJson({
      country:
        typeof payload.country === "string"
          ? payload.country.toUpperCase()
          : undefined,
      domain:
        typeof payload.domain === "string"
          ? payload.domain.toLowerCase()
          : undefined,
      name:
        typeof payload.name === "string"
          ? payload.name.toLowerCase().replaceAll(/\s+/gu, " ")
          : undefined,
    }),
  )}`;
}

function writerCommand(overrides = {}) {
  const fetchedAt = overrides.fetchedAt ?? new Date().toISOString();
  const payload = overrides.payload ?? {
    externalId: overrides.externalId ?? "writer-a",
    name: "Writer A GmbH",
    domain: "writer-a.example",
    attributes: { products: ["pump"] },
    provenance: {
      sourceUrl: "https://registry.example/writer-a",
      fetchedAt,
      contentHash: "a".repeat(64),
      parserVersion: "registry/v2",
    },
  };
  return {
    schemaVersion: "raw-source-writer/v2",
    recordId: overrides.recordId ?? "82000000-0000-4000-8000-000000000001",
    workspaceId: overrides.workspaceId ?? WORKSPACE_A,
    runId: overrides.runId === undefined ? RUN_A : overrides.runId,
    sourceEntityId: overrides.sourceEntityId ?? null,
    providerKey: overrides.providerKey ?? "registry",
    sourceClass: overrides.sourceClass ?? "company_registry",
    externalId:
      overrides.commandExternalId === undefined
        ? (payload.externalId ?? null)
        : overrides.commandExternalId,
    payload,
    sourceUrl: payload.provenance?.sourceUrl ?? null,
    fetchedAt: payload.provenance?.fetchedAt ?? null,
    contentHash: payload.provenance?.contentHash ?? null,
    parserVersion: payload.provenance?.parserVersion ?? null,
    ingestKey: overrides.ingestKey ?? ingestKeyForWriterPayload(payload),
    ingestStatus: overrides.ingestStatus ?? "ACCEPTED",
    dispositionCode: overrides.dispositionCode ?? null,
    sourcePolicyId:
      overrides.sourcePolicyId === undefined
        ? POLICY_A
        : overrides.sourcePolicyId,
    retentionDays: overrides.retentionDays ?? 30,
    costCents: overrides.costCents ?? 0,
  };
}

function tedWriterCommand({
  recordId,
  publicationNumber,
  winnerIdentifier,
  withIdentifier,
}) {
  const externalId = `ted:${publicationNumber}:0`;
  const payload = {
    externalId,
    name: "Johnson Controls",
    country: "DE",
    ...(withIdentifier
      ? {
          identifier: {
            scheme: "ted-natid:de",
            value: winnerIdentifier,
          },
        }
      : {}),
    attributes: {
      ted: {
        publication_number: publicationNumber,
        publication_date: "2026-08-25",
        notice_type: "award",
        winner_identifier: winnerIdentifier,
      },
    },
    license: "CC BY 4.0",
    provenance: {
      sourceUrl: "https://api.ted.europa.eu/v3/notices/search",
      fetchedAt: "2026-08-25T12:00:00.000Z",
      contentHash: "a".repeat(64),
      parserVersion: "ted/v1",
    },
  };
  return writerCommand({
    recordId,
    externalId,
    payload,
    providerKey: "ted",
    sourceClass: "public_intelligence",
    sourcePolicyId: POLICY_TED,
  });
}

function nonAcceptedWriterCommand({
  recordId,
  status,
  reason,
  originalPayloadHash = "a".repeat(64),
  originalPayloadBytes = 512,
  conflictWithRawId,
  payloadOverrides = {},
}) {
  const payload = {
    _rawReceipt:
      status === "REJECTED"
        ? "raw-source/rejected/v1"
        : "raw-source/quarantine/v1",
    reason,
    originalPayloadHash,
    originalPayloadBytes,
    ...(conflictWithRawId === undefined ? {} : { conflictWithRawId }),
    ...payloadOverrides,
  };
  return writerCommand({
    recordId,
    payload,
    commandExternalId: null,
    ingestKey: `payload:${sha256(canonicalJson(payload))}`,
    ingestStatus: status,
    dispositionCode: reason,
    sourcePolicyId: null,
  });
}

function writerSql(command) {
  const encoded = JSON.stringify(command).replaceAll("'", "''");
  return `SELECT raw_record_id::text || '|' || payload_hash || '|' ||
    payload_bytes::text || '|' || ingest_status || '|' || inserted::text
    FROM write_raw_source_record_v2('${encoded}'::jsonb);`;
}

function seedCurrentMainClone(database = databases.upgrade) {
  dockerPsql(
    database,
    `
    INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
      VALUES
        (gen_random_uuid(),'registry','company_registry','ENABLED',0,now()),
        (gen_random_uuid(),'ted','public_intelligence','ENABLED',0,now());
    INSERT INTO source_policy(
      id,domain,source_type,access_mode,robots_status,terms_status,
      personal_data,allowed_purpose,crawl_delay_ms,retention_days,
      review_status,owner,created_at,updated_at
    ) VALUES
      ('${POLICY_A}','registry.example','gov_registry','api','ALLOWS',
       'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()),
      ('${POLICY_TED}','api.ted.europa.eu','gov_registry','api','ALLOWS',
       'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now());
    INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}','A',now(),now()),
      ('${WORKSPACE_B}','B',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at) VALUES
      ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now()),
      ('${RUN_B}','${WORKSPACE_B}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    INSERT INTO raw_source_record(
      id,workspace_id,run_id,provider_key,source_class,external_id,payload,
      source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
    ) VALUES
      ('${SAFE_RAW_A}','${WORKSPACE_A}','${RUN_A}','registry','company_registry','safe-a',
       '{"name":"Safe A","domain":"safe-a.example"}',
       'https://registry.example/safe-a',now()-interval '2 days',repeat('a',64),'registry/v1',0,now()-interval '2 days'),
      ('${RESTRICTED_RAW_A}','${WORKSPACE_A}','${RUN_A}','usaspending_awards','public_intelligence','restricted-a',
       '{"name":"Unsafe A","attributes":{"procurement":{"recipient_name":"PERSON","description":"PERSONAL PROSE","query_match":true}}}',
       'https://api.usaspending.gov/awards',now()-interval '2 days',repeat('b',64),'usaspending/v1',0,now()-interval '2 days'),
      ('${SAFE_RAW_B}','${WORKSPACE_B}','${RUN_B}','registry','company_registry','safe-b',
       '{"name":"Safe B","domain":"safe-b.example"}',
       'https://registry.example/safe-b',now()-interval '2 days',repeat('c',64),'registry/v1',0,now()-interval '2 days'),
      ('${EVIDENCE_CHAIN_RAW_A}','${WORKSPACE_A}','${RUN_A}','registry','company_registry','chain-a',
       '{"name":"Chain A","domain":"chain-a.example"}',
       'https://registry.example/chain-a',now()-interval '2 days',repeat('e',64),'registry/v1',0,now()-interval '2 days');
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,attributes,status,dedupe_key,version,created_at,updated_at
    ) VALUES (
      '${COMPANY_A}','${WORKSPACE_A}','Unsafe A',NULL,
      '{
        "products":["pump","LLZ","SECRET","person@example.test"],
        "gleif":{"lei":"529900T8BM49AURSDO55","legal_name":"Parker Hannifin"},
        "contact_email":"person@example.test",
        "owner_name":"alice van smith",
        "custom_payload":{"notes":"unbounded historical prose"}
      }',
      'NEW','n:unsafe a:',1,'2026-08-25T00:00:00Z','2026-08-25T00:00:00Z'
    );
    UPDATE canonical_company
    SET attributes = attributes ||
      '{"digital_footprint":{"structured_org":{"contact_email":"person@example.test"}}}'::jsonb
    WHERE id='${COMPANY_A}';
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,attributes,status,dedupe_key,version,created_at,updated_at
    ) VALUES (
      '70000000-0000-4000-8000-000000000002','${WORKSPACE_A}',
      'Stable GmbH','stable.example','{"products":["pump"]}',
      'NEW','d:stable.example',7,
      '2026-08-25T00:00:00Z','2026-08-25T00:00:00Z'
    );
    INSERT INTO monitored_source(
      id,provider_key,source_key,label,config,status,created_at,updated_at
    ) VALUES (
      '${SOURCE}','mapyourshow','fair:legacy','Legacy Fair',
      '{"host":"legacy.mapyourshow.com"}','ACTIVE',now(),now()
    );
    INSERT INTO source_fetch(
      id,source_id,status,total,parser_version,started_at,finished_at
    ) VALUES (
      '${FETCH}','${SOURCE}','DONE',1,'acquisition/v1',
      '2026-08-25T16:30:00Z','2026-08-25T16:31:00Z'
    );
    INSERT INTO source_entity(
      id,source_id,external_id,entity_kind,name,domain,country,cleaned,
      content_hash,first_seen_at,last_seen_at,miss_count,created_at,updated_at
    ) VALUES (
      '${SOURCE_ENTITY}','${SOURCE}','legacy-entity','company','Legacy GmbH',
      'legacy.example','DE',
      '{"products":["pump"],"email":"person@legacy.example","email_kind":"personal"}',
      repeat('d',64),'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z',0,now(),now()
    );
    INSERT INTO identity_link(
      id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,created_at
    ) VALUES
      (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','${SOURCE_ENTITY}','domain_exact',1,now()),
      (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','${RESTRICTED_RAW_A}','provider_id',1,now());
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,raw_record_id,
      confidence,license,allowed_actions,fetched_at
    ) VALUES
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','name','"Legacy GmbH"',
        'mapyourshow','${SOURCE_ENTITY}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','country','"DE"',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','attributes',
        '{"products":["pump","person@example.test"],"owner_name":"alice van smith","custom_payload":{"notes":"unbounded historical prose"}}',
        'registry','${SAFE_RAW_A}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','contact_email','"person@example.test"',
        'registry','${SAFE_RAW_A}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','contact_email','"protected.person@example.test"',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','attributes',
        '{"products":["LLZ1","AB"]}',
        'mapyourshow','${SOURCE_ENTITY}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','attributes',
        '{"products":["LLZ1","AB"]}',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','attributes',
        '{"products":["AB"],"custom_payload":{"notes":"forbidden free text"}}',
        'registry','${EVIDENCE_CHAIN_RAW_A}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      );
  `,
  );
}

function seedMinimal1500Company(database) {
  dockerPsql(
    database,
    `INSERT INTO canonical_company(
      id,workspace_id,name,attributes,status,dedupe_key,version,
      created_at,updated_at
    ) VALUES (
      '${COMPANY_MINIMAL_1500}','${WORKSPACE_A}','Minimal Products',
      '{"products":["pump","AB"]}','NEW','n:minimal products:',7,
      '2026-08-25T00:00:00Z','2026-08-25T00:00:00Z'
    );`,
  );
}

function readMinimal1500Company(database) {
  return dockerPsql(
    database,
    `SELECT jsonb_build_object(
      'attributes',attributes,
      'version',version,
      'updatedAt',to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text FROM canonical_company WHERE id='${COMPANY_MINIMAL_1500}';`,
  );
}

function seedPathSemanticCollision(database) {
  dockerPsql(
    database,
    `
    UPDATE canonical_company
    SET attributes = attributes ||
      '{"digital_footprint":{"source":"Call 555-0100"}}'::jsonb
    WHERE id='${COMPANY_A}';
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,fetched_at
    ) VALUES (
      gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}',
      'digital_footprint','{"source":"Call 555-0100"}',
      'registry_path_collision','${SAFE_RAW_A}',1,'public',
      '["display","match"]','2026-08-25T16:31:00Z'
    ),(
      gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}',
      'digital_footprint',
      '{
        "_historicalCleanup":"canonical-attribute-cleanup/v2",
        "reason":"UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
        "originalValueHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "predecessorReceiptHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "retainedValue":{"source":"Call 555-0100"}
      }',
      'registry_path_v2_collision','${EVIDENCE_CHAIN_RAW_A}',1,'public',
      '["display","match"]','2026-08-25T16:31:00Z'
    );
  `,
  );
}

function seedDottedProductsEvidence(database) {
  dockerPsql(
    database,
    `
    INSERT INTO raw_source_record(
      id,workspace_id,run_id,provider_key,source_class,external_id,payload,
      source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
    ) VALUES (
      '${DOTTED_PRODUCTS_RAW_A}','${WORKSPACE_A}','${RUN_A}',
      'registry','company_registry','dotted-products-a',
      '{"name":"Dotted Products A","domain":"dotted-products-a.example"}',
      'https://registry.example/dotted-products-a',
      now()-interval '2 days',repeat('f',64),'registry/v1',0,
      now()-interval '2 days'
    );
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,fetched_at
    ) VALUES (
      gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}',
      'gleif.products','["pump","AB"]','registry',
      '${DOTTED_PRODUCTS_RAW_A}',1,'public','["display","match"]',
      '2026-08-25T16:31:00Z'
    );
  `,
  );
}

function seedStoredFieldEvidence(database) {
  const tender = {
    last_change_at: "2026-08-26T00:00:00.000Z",
    intent_score: 0.9,
    counts: { TENDER_PUBLISHED: 1 },
    events: [
      {
        type: "TENDER_PUBLISHED",
        at: "2026-08-26T00:00:00.000Z",
        strength: 0.9,
        evidence: {
          cpv: ["42122130"],
          notice: "notice-1",
          source: "ted",
        },
      },
    ],
    _ts: "2026-08-26T00:00:00.000Z",
  };
  const clearanceEvent = {
    type: "FDA_CLEARANCE",
    at: "2026-08-26T00:00:00.000Z",
    strength: 0.85,
    evidence: {
      product_code: "LLZ",
      k_number: "K123456",
      device: "Industrial pump controller",
      source: "openfda",
    },
  };
  const clearanceIntent = {
    last_change_at: "2026-08-26T00:00:00.000Z",
    intent_score: 0.85,
    counts: { FDA_CLEARANCE: 1 },
    events: [clearanceEvent],
    _ts: "2026-08-26T00:00:00.000Z",
  };
  const sourcesSoughtEvent = {
    type: "US_FED_SOURCES_SOUGHT",
    at: "2026-08-26T00:00:00.000Z",
    strength: 0.7,
    evidence: {
      naics: ["333914"],
      notice: "W912HQ-26-S-0001",
      source: "samgov",
    },
  };
  const sourcesSoughtEvidence = { events: [sourcesSoughtEvent] };
  const sourcesSoughtIntent = {
    last_change_at: "2026-08-26T00:00:00.000Z",
    intent_score: 0.7,
    counts: { US_FED_SOURCES_SOUGHT: 1 },
    events: [sourcesSoughtEvent],
    _ts: "2026-08-26T00:00:00.000Z",
  };
  const websiteChange = {
    last_change_at: "2026-08-26T00:00:00.000Z",
    intent_score: 0.6,
    counts: { PRODUCT_ADDED: 1 },
    events: [
      {
        type: "PRODUCT_ADDED",
        at: "2026-08-26T00:00:00.000Z",
        strength: 0.6,
        page_kind: "products",
        page_url: "https://acme.example/products/pump",
        evidence: { new_products: ["industrial pump"] },
      },
    ],
    _ts: "2026-08-26T00:00:00.000Z",
  };
  dockerPsql(
    database,
    `
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,country,attributes,status,dedupe_key,
      version,created_at,updated_at
    ) VALUES
      ('${COMPANY_TENDER}','${WORKSPACE_A}','Tender Agency',NULL,'DE',
       '${JSON.stringify({ intent: tender })}'::jsonb,'NEW',
       'n:tender agency:de',1,'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z'),
      ('${COMPANY_CLEARANCE}','${WORKSPACE_A}','Clearance Applicant',NULL,'US',
       '${JSON.stringify({ intent: clearanceIntent })}'::jsonb,'NEW',
       'n:clearance applicant:us',1,'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z'),
      ('${COMPANY_SOURCES_SOUGHT}','${WORKSPACE_A}','Federal Buyer',NULL,'US',
       '${JSON.stringify({ intent: sourcesSoughtIntent })}'::jsonb,'NEW',
       'n:federal buyer:us',1,'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z'),
      ('${COMPANY_WEBSITE_CHANGE}','${WORKSPACE_A}','Website Company',
       'website.example','DE','${JSON.stringify({ intent: websiteChange })}'::jsonb,
       'NEW','d:website.example',1,'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z'),
      ('${COMPANY_LINKED_RECOVERY}','${WORKSPACE_A}','Linked Recovery',
       'later.example','DE','{"products":["pump"]}'::jsonb,
       'NEW','d:later.example',1,'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z');
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,country,attributes,status,dedupe_key,
      version,created_at,updated_at
    ) VALUES (
      '${COMPANY_TENDER_V3}','${WORKSPACE_A}','Tender V3 Agency',NULL,'DE',
      '${JSON.stringify({ intent: tender })}'::jsonb,'NEW',
      'n:tender v3 agency:de',1,
      '2026-08-25T16:31:00Z','2026-08-25T16:31:00Z'
    );

    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,data_class,fetched_at
    ) VALUES
      ('81000000-0000-4000-8000-000000000101','${WORKSPACE_A}','company',
       '${COMPANY_TENDER}','intent.tender','${JSON.stringify(tender)}'::jsonb,
       'ted',NULL,1,'CC BY 4.0','["display","match"]','green','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000102','${WORKSPACE_A}','company',
       '${COMPANY_CLEARANCE}','intent.clearance','${JSON.stringify(clearanceEvent)}'::jsonb,
       'openfda',NULL,1,'CC0-1.0','["display","match"]','green','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000103','${WORKSPACE_A}','company',
       '${COMPANY_SOURCES_SOUGHT}','intent.sources_sought',
       '${JSON.stringify(sourcesSoughtEvidence)}'::jsonb,'samgov',NULL,1,
       'US Government Public Domain','["display","match"]','green','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000104','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','intent.website_change',
       '${JSON.stringify(websiteChange)}'::jsonb,'web_watch',NULL,1,'public',
       '["display","match"]','green','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000106','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','source',
       '"Call 555-0100 person@example.test Bearer secret"'::jsonb,
       'unsafe_unknown',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000107','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','digital_footprint.structured_org',
       '{"name":"Acme Pump GmbH","source":"Call 555-0100 person@example.test Bearer secret"}'::jsonb,
       'digital_footprint',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000109','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','name','"Website Company"'::jsonb,
       'registry',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000110','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','gleif.lei','"529900T8BM49AURSDO55"'::jsonb,
       'gleif',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000111','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','wikidata.qid','"Q123"'::jsonb,
       'wikidata',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000112','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.hiring_signal',
       '{"source":"sitemap","open_roles":2,"titles":["Buyer"]}'::jsonb,
       'structured_harvest',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000113','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','identity',
       '{"name":"Website Company","country":"DE","source":"ted","notice":"notice-1","attribution":"TED CC BY 4.0"}'::jsonb,
       'ted',NULL,1,'CC BY 4.0','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000114','${WORKSPACE_A}','company',
       '${COMPANY_LINKED_RECOVERY}','domain',
       '{"_historicalCleanup":"canonical-attribute-cleanup/v2","reason":"UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD","originalValueHash":"13fdcb3e867c757286bd4e924cfd97f77de31d2ca4f856a8110e430fbbfcdedd","predecessorReceiptHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'::jsonb,
       'unrecoverable',NULL,1,'public','[]','red','2026-08-25T16:31:00Z');
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,data_class,fetched_at
    ) VALUES (
      '81000000-0000-4000-8000-000000000115','${WORKSPACE_A}','company',
      '${COMPANY_TENDER_V3}','intent.tender',
      '{"_historicalCleanup":"canonical-attribute-cleanup/v3","reason":"UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD","originalValueHash":"01666d0021c08e02df9edd362eea3ea4af5d6f314c1fa9737aa5ba7647f4c6d3","predecessorReceiptHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
      'ted',NULL,1,'CC BY 4.0','[]','red','2026-08-25T16:31:00Z'
    );
  `,
  );

  dockerPsql(
    database,
    asApp(
      WORKSPACE_A,
      writerSql(
        writerCommand({
          recordId: LINKED_RECOVERY_RAW,
          externalId: "linked-recovery",
          fetchedAt: "2026-08-25T16:31:00.000Z",
          payload: {
            externalId: "linked-recovery",
            name: "Linked Recovery",
            domain: "raw-recover.example",
            country: "DE",
            attributes: { products: ["pump"] },
            provenance: {
              sourceUrl: "https://registry.example/linked-recovery",
              fetchedAt: "2026-08-25T16:31:00.000Z",
              contentHash: "9".repeat(64),
              parserVersion: "registry/v2",
            },
          },
        }),
      ),
    ),
  );
  dockerPsql(
    database,
    `
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,data_class,fetched_at
    ) VALUES (
      '81000000-0000-4000-8000-000000000105','${WORKSPACE_A}','company',
      '${COMPANY_LINKED_RECOVERY}','domain',
      '{"_historicalCleanup":"canonical-attribute-cleanup/v2","reason":"UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD","originalValueHash":"e0abd8c37da5f30a6844e4d90be289f1ad7e8ba1545191f80c87259657088b75","predecessorReceiptHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'::jsonb,
      'registry','${LINKED_RECOVERY_RAW}',1,'public','[]','red',
      '2026-08-25T16:31:00Z'
    );
  `,
  );
}

function seedSiteSectionEvidence(database) {
  dockerPsql(
    database,
    `
    UPDATE canonical_company
    SET attributes=attributes ||
      '{"structured_harvest":{"site_sections":{".well-known":1}}}'::jsonb
    WHERE id='${COMPANY_WEBSITE_CHANGE}';

    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,data_class,fetched_at
    ) VALUES
      ('81000000-0000-4000-8000-000000000202','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
       '{".well-known":1}'::jsonb,'structured_harvest',NULL,1,'public',
       '["display","match"]','green','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000203','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
       '{"555-0100":1,"bearer-secret":1,"contact":1,"notice":1,"source":1}'::jsonb,
       'structured_harvest',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000204','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
       '{"products":2,".well-known":1,"person@example.test":1,"٥٥٥-٠١٠٠":1,"bearer-secret":1,"%70roducts":1,"Ａbout":1,"xxxxxxxxxxxxxxxxxxxxxxxxx":1}'::jsonb,
       'structured_harvest',NULL,1,'public','["display","match"]','green',
       '2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000206','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
       '{".well-known":1}'::jsonb,'structured_harvest','${SAFE_RAW_A}',1,
       'public','["display","match"]','green',
       '2026-08-25T16:31:00Z');
  `,
  );
}

function seedHistoricalSiteSectionRestrictiveEvidence(database) {
  dockerPsql(
    database,
    `INSERT INTO raw_source_record(
      id,workspace_id,run_id,provider_key,source_class,external_id,payload,
      source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
    ) VALUES (
      '${SITE_SECTION_RAW_A}','${WORKSPACE_A}','${RUN_A}',
      'structured_harvest','public_intelligence','site-section-products',
      '{"name":"Website Company","attributes":{"site_sections":{"products":2}}}',
      'https://website.example/sitemap.xml','2026-08-25T16:31:00Z',
      repeat('6',64),'structured-harvest/v1',0,'2026-08-25T16:31:00Z'
    );
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      raw_record_id,confidence,license,allowed_actions,fetched_at
    ) VALUES
      ('81000000-0000-4000-8000-000000000201','${WORKSPACE_A}','company',
       '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
       '{"products":2}'::jsonb,'structured_harvest','${SITE_SECTION_RAW_A}',
       1,'public','["display","match"]','2026-08-25T16:31:00Z'),
      ('81000000-0000-4000-8000-000000000205','${WORKSPACE_A}','company',
       '${COMPANY_A}','structured_harvest.site_sections',
       '{"555-0100":1,"bearer-secret":1}'::jsonb,'structured_harvest',
       '${RESTRICTED_RAW_A}',1,'public','["display","match"]',
       '2026-08-25T16:31:00Z');`,
  );
}

function seedPost2200SiteSectionEvidence(database) {
  dockerPsql(
    database,
    `INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,
      confidence,license,allowed_actions,data_class,fetched_at
    ) VALUES (
      '81000000-0000-4000-8000-000000000207','${WORKSPACE_A}','company',
      '${COMPANY_WEBSITE_CHANGE}','structured_harvest.site_sections',
      '{"555-0100":1,"bearer-secret":1}'::jsonb,'structured_harvest',1,
      'public','["display","match"]','green','2026-08-25T16:31:00Z'
    );`,
  );
}

function openRowLock(database, rowId) {
  requireTopology();
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
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(`BEGIN;\nSELECT 'LOCKED:${rowId}'
    FROM raw_source_record WHERE id='${rowId}' FOR UPDATE;\n`);

  const ready = new Promise((resolveReady, rejectReady) => {
    let poll;
    const timeout = setTimeout(() => {
      clearInterval(poll);
      rejectReady(new Error(`row lock did not become ready:\n${output}`));
    }, 5_000);
    poll = setInterval(() => {
      if (!output.includes(`LOCKED:${rowId}`)) return;
      clearTimeout(timeout);
      clearInterval(poll);
      resolveReady();
    }, 10);
    child.once("exit", (code) => {
      if (output.includes(`LOCKED:${rowId}`)) return;
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`row-lock session exited ${code}:\n${output}`));
    });
  });

  const release = () =>
    new Promise((resolveRelease, rejectRelease) => {
      child.once("exit", (code) => {
        if (code === 0) resolveRelease();
        else
          rejectRelease(
            new Error(`row-lock release exited ${code}:\n${output}`),
          );
      });
      child.stdin.end("ROLLBACK;\n\\q\n");
    });
  return { ready, release };
}

before(() => {
  requireTopology();
  assert.equal(
    existsSync(schemaMigrationPath),
    true,
    `${schemaMigrationName} must exist`,
  );
  assert.equal(
    existsSync(backfillMigrationPath),
    true,
    `${backfillMigrationName} must exist`,
  );
  assert.equal(
    existsSync(constraintsMigrationPath),
    true,
    `${constraintsMigrationName} must exist`,
  );
  assert.equal(
    existsSync(writerMigrationPath),
    true,
    `${writerMigrationName} must exist`,
  );
  assert.equal(
    existsSync(writerHardeningMigrationPath),
    true,
    `${writerHardeningMigrationName} must exist`,
  );
  assert.equal(
    existsSync(historicalCleanupMigrationPath),
    true,
    `${historicalCleanupMigrationName} must exist`,
  );
  assert.equal(
    existsSync(statusHardeningMigrationPath),
    true,
    `${statusHardeningMigrationName} must exist`,
  );
  assert.equal(
    existsSync(finalCorrectionMigrationPath),
    true,
    `${finalCorrectionMigrationName} must exist`,
  );
  assert.equal(
    existsSync(writerParityMigrationPath),
    true,
    `${writerParityMigrationName} must exist`,
  );
  assert.equal(
    existsSync(evidenceChainMigrationPath),
    true,
    `${evidenceChainMigrationName} must exist`,
  );
  assert.equal(
    existsSync(pathSanitizerMigrationPath),
    true,
    `${pathSanitizerMigrationName} must exist`,
  );
  assert.equal(
    existsSync(pathCleanupMigrationPath),
    true,
    `${pathCleanupMigrationName} must exist`,
  );
  assert.equal(
    existsSync(storedFieldAdapterMigrationPath),
    true,
    `${storedFieldAdapterMigrationName} must exist`,
  );
  assert.equal(
    existsSync(storedFieldCleanupMigrationPath),
    true,
    `${storedFieldCleanupMigrationName} must exist`,
  );
  dockerPsql(
    "postgres",
    Object.values(databases)
      .map(
        (database) => `
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${database}' AND pid <> pg_backend_pid();
    DROP DATABASE IF EXISTS ${database};
    CREATE DATABASE ${database} OWNER global;
  `,
      )
      .join("\n"),
  );

  const baseline = createBaselineMigrationTree();
  baselineDirectory = baseline.root;

  firstDeployOutput = migrateDeploy(databases.fresh);
  secondDeployOutput = migrateDeploy(databases.fresh);

  baselineDeployOutput = migrateDeploy(databases.upgrade, baseline.schemaPath);
  assert.match(baselineDeployOutput, new RegExp(baselineLastMigration, "u"));
  assert.equal(
    dockerPsql(
      databases.upgrade,
      `SELECT current_database() || '|' || coalesce((
        SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY table_schema, table_name)
        FROM information_schema.tables
        WHERE table_name IN ('workspace', '_prisma_migrations')
      ), 'missing');`,
    ),
    `${databases.upgrade}|public._prisma_migrations,public.workspace`,
    baselineDeployOutput,
  );
  seedCurrentMainClone();
  migrateDeploy(databases.upgrade);

  migrateDeploy(databases.statusHardeningMinimal, baseline.schemaPath);
  seedCurrentMainClone(databases.statusHardeningMinimal);
  seedMinimal1500Company(databases.statusHardeningMinimal);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
  ]) {
    dockerPsql(
      databases.statusHardeningMinimal,
      readFileSync(migrationPath, "utf8"),
    );
  }
  minimal1500Before = readMinimal1500Company(databases.statusHardeningMinimal);
  dockerPsql(
    databases.statusHardeningMinimal,
    readFileSync(statusHardeningMigrationPath, "utf8"),
  );
  minimal1500After = readMinimal1500Company(databases.statusHardeningMinimal);
  for (const migrationPath of [
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
    pathSanitizerMigrationPath,
    pathCleanupMigrationPath,
  ]) {
    dockerPsql(
      databases.statusHardeningMinimal,
      readFileSync(migrationPath, "utf8"),
    );
  }
  minimal1500SecondPass = readMinimal1500Company(
    databases.statusHardeningMinimal,
  );

  migrateDeploy(databases.dottedReceipt, baseline.schemaPath);
  seedCurrentMainClone(databases.dottedReceipt);
  seedDottedProductsEvidence(databases.dottedReceipt);
  migrateDeploy(databases.dottedReceipt);

  migrateDeploy(databases.pathCleanup, baseline.schemaPath);
  seedCurrentMainClone(databases.pathCleanup);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
  ]) {
    dockerPsql(databases.pathCleanup, readFileSync(migrationPath, "utf8"));
  }
  seedPathSemanticCollision(databases.pathCleanup);
  dockerPsql(
    databases.pathCleanup,
    readFileSync(pathSanitizerMigrationPath, "utf8"),
  );
  dockerPsql(
    databases.pathCleanup,
    readFileSync(pathCleanupMigrationPath, "utf8"),
  );

  migrateDeploy(databases.storedField, baseline.schemaPath);
  seedCurrentMainClone(databases.storedField);
  seedHistoricalSiteSectionRestrictiveEvidence(databases.storedField);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
  ]) {
    dockerPsql(databases.storedField, readFileSync(migrationPath, "utf8"));
  }
  seedStoredFieldEvidence(databases.storedField);
  seedSiteSectionEvidence(databases.storedField);
  dockerPsql(
    databases.storedField,
    readFileSync(pathSanitizerMigrationPath, "utf8"),
  );
  dockerPsql(
    databases.storedField,
    readFileSync(pathCleanupMigrationPath, "utf8"),
  );
  storedFieldAfter2000 = dockerPsql(
    databases.storedField,
    `SELECT jsonb_agg(jsonb_build_object(
       'id',id,'field',field,'cleanup',value->>'_historicalCleanup',
       'originalValueHash',value->>'originalValueHash',
       'class',data_class,'actions',allowed_actions
     ) ORDER BY id)::text
     FROM field_evidence
     WHERE id IN (
       '81000000-0000-4000-8000-000000000101',
       '81000000-0000-4000-8000-000000000102',
       '81000000-0000-4000-8000-000000000103',
       '81000000-0000-4000-8000-000000000104'
     );`,
  );
  dockerPsql(
    databases.storedField,
    readFileSync(storedFieldAdapterMigrationPath, "utf8"),
  );
  dockerPsql(
    databases.storedField,
    readFileSync(storedFieldCleanupMigrationPath, "utf8"),
  );
  seedPost2200SiteSectionEvidence(databases.storedField);
  if (
    existsSync(siteSectionContractMigrationPath) &&
    existsSync(siteSectionCleanupMigrationPath)
  ) {
    dockerPsql(
      databases.storedField,
      readFileSync(siteSectionContractMigrationPath, "utf8"),
    );
    dockerPsql(
      databases.storedField,
      readFileSync(siteSectionCleanupMigrationPath, "utf8"),
    );
  }

  migrateDeploy(databases.backfillRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.backfillRollback);
  dockerPsql(
    databases.backfillRollback,
    readFileSync(schemaMigrationPath, "utf8"),
  );
  // The committed 1000 VALIDATE statements are the transactional integrity
  // gate after its DML. Inject only in-memory after that gate, before COMMIT.
  const injectedBackfill = readFileSync(backfillMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedBackfillRollbackOutput = dockerPsql(
    databases.backfillRollback,
    injectedBackfill,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.writerRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
  ]) {
    dockerPsql(databases.writerRollback, readFileSync(migrationPath, "utf8"));
  }
  const injectedWriter = readFileSync(writerMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedWriterRollbackOutput = dockerPsql(
    databases.writerRollback,
    injectedWriter,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.writerHardeningRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
  ]) {
    dockerPsql(
      databases.writerHardeningRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedWriterHardening = readFileSync(
    writerHardeningMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedWriterHardeningRollbackOutput = dockerPsql(
    databases.writerHardeningRollback,
    injectedWriterHardening,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.historicalCleanupRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.historicalCleanupRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
  ]) {
    dockerPsql(
      databases.historicalCleanupRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedHistoricalCleanup = readFileSync(
    historicalCleanupMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedHistoricalCleanupRollbackOutput = dockerPsql(
    databases.historicalCleanupRollback,
    injectedHistoricalCleanup,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.statusHardeningRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.statusHardeningRollback);
  seedMinimal1500Company(databases.statusHardeningRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
  ]) {
    dockerPsql(
      databases.statusHardeningRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedStatusHardening = readFileSync(
    statusHardeningMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedStatusHardeningRollbackOutput = dockerPsql(
    databases.statusHardeningRollback,
    injectedStatusHardening,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.finalCorrectionRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.finalCorrectionRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
  ]) {
    dockerPsql(
      databases.finalCorrectionRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedFinalCorrection = readFileSync(
    finalCorrectionMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedFinalCorrectionRollbackOutput = dockerPsql(
    databases.finalCorrectionRollback,
    injectedFinalCorrection,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.writerParityRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
  ]) {
    dockerPsql(
      databases.writerParityRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedWriterParity = readFileSync(
    writerParityMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedWriterParityRollbackOutput = dockerPsql(
    databases.writerParityRollback,
    injectedWriterParity,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.evidenceChainRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.evidenceChainRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
  ]) {
    dockerPsql(
      databases.evidenceChainRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedEvidenceChain = readFileSync(
    evidenceChainMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedEvidenceChainRollbackOutput = dockerPsql(
    databases.evidenceChainRollback,
    injectedEvidenceChain,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.pathSanitizerRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
  ]) {
    dockerPsql(
      databases.pathSanitizerRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedPathSanitizer = readFileSync(
    pathSanitizerMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedPathSanitizerRollbackOutput = dockerPsql(
    databases.pathSanitizerRollback,
    injectedPathSanitizer,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.pathCleanupRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.pathCleanupRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
  ]) {
    dockerPsql(
      databases.pathCleanupRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  seedPathSemanticCollision(databases.pathCleanupRollback);
  dockerPsql(
    databases.pathCleanupRollback,
    readFileSync(pathSanitizerMigrationPath, "utf8"),
  );
  const injectedPathCleanup = readFileSync(
    pathCleanupMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedPathCleanupRollbackOutput = dockerPsql(
    databases.pathCleanupRollback,
    injectedPathCleanup,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.storedFieldAdapterRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
    pathSanitizerMigrationPath,
    pathCleanupMigrationPath,
  ]) {
    dockerPsql(
      databases.storedFieldAdapterRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedStoredFieldAdapter = readFileSync(
    storedFieldAdapterMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedStoredFieldAdapterRollbackOutput = dockerPsql(
    databases.storedFieldAdapterRollback,
    injectedStoredFieldAdapter,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.storedFieldCleanupRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.storedFieldCleanupRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
    historicalCleanupMigrationPath,
    statusHardeningMigrationPath,
    finalCorrectionMigrationPath,
    writerParityMigrationPath,
    evidenceChainMigrationPath,
  ]) {
    dockerPsql(
      databases.storedFieldCleanupRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  seedStoredFieldEvidence(databases.storedFieldCleanupRollback);
  for (const migrationPath of [
    pathSanitizerMigrationPath,
    pathCleanupMigrationPath,
    storedFieldAdapterMigrationPath,
  ]) {
    dockerPsql(
      databases.storedFieldCleanupRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedStoredFieldCleanup = readFileSync(
    storedFieldCleanupMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedStoredFieldCleanupRollbackOutput = dockerPsql(
    databases.storedFieldCleanupRollback,
    injectedStoredFieldCleanup,
    { rejects: /division by zero/u },
  );

  if (existsSync(siteSectionContractMigrationPath)) {
    migrateDeploy(databases.siteSectionContractRollback, baseline.schemaPath);
    for (const migrationPath of [
      schemaMigrationPath,
      backfillMigrationPath,
      constraintsMigrationPath,
      writerMigrationPath,
      writerHardeningMigrationPath,
      historicalCleanupMigrationPath,
      statusHardeningMigrationPath,
      finalCorrectionMigrationPath,
      writerParityMigrationPath,
      evidenceChainMigrationPath,
      pathSanitizerMigrationPath,
      pathCleanupMigrationPath,
      storedFieldAdapterMigrationPath,
      storedFieldCleanupMigrationPath,
    ]) {
      dockerPsql(
        databases.siteSectionContractRollback,
        readFileSync(migrationPath, "utf8"),
      );
    }
    const injectedSiteSectionContract = readFileSync(
      siteSectionContractMigrationPath,
      "utf8",
    ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
    injectedSiteSectionContractRollbackOutput = dockerPsql(
      databases.siteSectionContractRollback,
      injectedSiteSectionContract,
      { rejects: /division by zero/u },
    );
  }

  if (
    existsSync(siteSectionContractMigrationPath) &&
    existsSync(siteSectionCleanupMigrationPath)
  ) {
    migrateDeploy(databases.siteSectionCleanupRollback, baseline.schemaPath);
    seedCurrentMainClone(databases.siteSectionCleanupRollback);
    seedHistoricalSiteSectionRestrictiveEvidence(
      databases.siteSectionCleanupRollback,
    );
    for (const migrationPath of [
      schemaMigrationPath,
      backfillMigrationPath,
      constraintsMigrationPath,
      writerMigrationPath,
      writerHardeningMigrationPath,
      historicalCleanupMigrationPath,
      statusHardeningMigrationPath,
      finalCorrectionMigrationPath,
      writerParityMigrationPath,
      evidenceChainMigrationPath,
    ]) {
      dockerPsql(
        databases.siteSectionCleanupRollback,
        readFileSync(migrationPath, "utf8"),
      );
    }
    seedStoredFieldEvidence(databases.siteSectionCleanupRollback);
    seedSiteSectionEvidence(databases.siteSectionCleanupRollback);
    for (const migrationPath of [
      pathSanitizerMigrationPath,
      pathCleanupMigrationPath,
      storedFieldAdapterMigrationPath,
      storedFieldCleanupMigrationPath,
    ]) {
      dockerPsql(
        databases.siteSectionCleanupRollback,
        readFileSync(migrationPath, "utf8"),
      );
    }
    seedPost2200SiteSectionEvidence(databases.siteSectionCleanupRollback);
    dockerPsql(
      databases.siteSectionCleanupRollback,
      readFileSync(siteSectionContractMigrationPath, "utf8"),
    );
    const injectedSiteSectionCleanup = readFileSync(
      siteSectionCleanupMigrationPath,
      "utf8",
    ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
    injectedSiteSectionCleanupRollbackOutput = dockerPsql(
      databases.siteSectionCleanupRollback,
      injectedSiteSectionCleanup,
      { rejects: /division by zero/u },
    );
  }

  if (existsSync(tedIdentifierContactGateMigrationPath)) {
    migrateDeploy(
      databases.tedIdentifierContactGateRollback,
      baseline.schemaPath,
    );
    for (const migrationPath of [
      schemaMigrationPath,
      backfillMigrationPath,
      constraintsMigrationPath,
      writerMigrationPath,
      writerHardeningMigrationPath,
      historicalCleanupMigrationPath,
      statusHardeningMigrationPath,
      finalCorrectionMigrationPath,
      writerParityMigrationPath,
      evidenceChainMigrationPath,
      pathSanitizerMigrationPath,
      pathCleanupMigrationPath,
      storedFieldAdapterMigrationPath,
      storedFieldCleanupMigrationPath,
      siteSectionContractMigrationPath,
      siteSectionCleanupMigrationPath,
    ]) {
      dockerPsql(
        databases.tedIdentifierContactGateRollback,
        readFileSync(migrationPath, "utf8"),
      );
    }
    const injectedTedIdentifierContactGate = readFileSync(
      tedIdentifierContactGateMigrationPath,
      "utf8",
    ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
    injectedTedIdentifierContactGateRollbackOutput = dockerPsql(
      databases.tedIdentifierContactGateRollback,
      injectedTedIdentifierContactGate,
      { rejects: /division by zero/u },
    );
  }

  migrateDeploy(databases.locks);
  dockerPsql(
    databases.locks,
    `
    INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
      VALUES (gen_random_uuid(),'registry','company_registry','ENABLED',0,now());
    INSERT INTO source_policy(
      id,domain,source_type,access_mode,robots_status,terms_status,
      personal_data,allowed_purpose,crawl_delay_ms,retention_days,
      review_status,owner,created_at,updated_at
    ) VALUES (
      '${POLICY_A}','registry.example','gov_registry','api','ALLOWS',
      'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
    );
    INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${WORKSPACE_A}','Locks',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at)
      VALUES ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    ${asApp(
      WORKSPACE_A,
      writerSql(
        writerCommand({
          recordId: LOCKED_RAW,
          externalId: "locked-a",
          fetchedAt: "2000-01-01T00:00:00.000Z",
          payload: {
            externalId: "locked-a",
            name: "Locked A GmbH",
            domain: "locked-a.example",
            attributes: { products: ["pump"] },
            provenance: {
              sourceUrl: "https://registry.example/locked-a",
              fetchedAt: "2000-01-01T00:00:00.000Z",
              contentHash: "a".repeat(64),
              parserVersion: "registry/v2",
            },
          },
        }),
      ),
    )}
  `,
  );

  migrateDeploy(databases.rollback, baseline.schemaPath);
  const injected = readFileSync(schemaMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedRollbackOutput = dockerPsql(databases.rollback, injected, {
    rejects: /division by zero/u,
  });
});

after(() => {
  if (baselineDirectory)
    rmSync(baselineDirectory, { recursive: true, force: true });
  if (container && port) {
    dockerPsql(
      "postgres",
      Object.values(databases)
        .map(
          (database) => `
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '${database}' AND pid <> pg_backend_pid();
      DROP DATABASE IF EXISTS ${database};
    `,
        )
        .join("\n"),
    );
  }
});

describe("Raw Source current-lineage migrations on disposable PostgreSQL 16", () => {
  it("keeps every 0900-2000 migration byte-identical to the authorized Task 6A.3 base", () => {
    assert.deepEqual(
      [
        schemaMigrationPath,
        backfillMigrationPath,
        constraintsMigrationPath,
        writerMigrationPath,
        writerHardeningMigrationPath,
        historicalCleanupMigrationPath,
        statusHardeningMigrationPath,
        finalCorrectionMigrationPath,
        writerParityMigrationPath,
        evidenceChainMigrationPath,
        pathSanitizerMigrationPath,
        pathCleanupMigrationPath,
      ].map((migrationPath) => sha256(readFileSync(migrationPath))),
      [
        "4d9bda5096fc46e2d62918f28d3bfe4207dfbdaadb61f077bf9ae50616b43285",
        "385cafd1226a3c73d148742da4f555652a7f8e862db24b92a419d42e0c26e324",
        "555f04775d091178c817da0f5ea6cf4fce150c2442be58ff0121c31fa68c8ef6",
        "e47383e385783156fda945f70dbeab88cef675777aa09ccf9a1e29d7651f933c",
        "acde428d93524c78eb85250b0534a5ec37f8448abbc2983c52f2a7c07a341cba",
        "b1a22391272ea71285332e8765cd9b92f9a3e4e98fb3a2109226f6537c1ad6cc",
        "952a96461ac38028e758a89c93bf320a4122f3a4db6273ce9355bdfd9262196c",
        "f8909dda8108b75416a050ea8cf29a57e7f2e1387a31f7ac7a9d09211ca42f77",
        "9cf80d782330417fa12f8f500214aa40e1469c4423f462cd2bcd2aa79fe8fe1e",
        "ec18e777ef578d46a90f9158da5cf1942008da36402550877469113b4f80b1b0",
        "5a601a60427fc97f2fd06d5582844ae33441df69d253dbff43fd586700d1a994",
        "39e2d28f7c353b021e7a22fbdc2cdd7fdfcca7d7b66c070a3defbfaab783f5d1",
      ],
    );
  });

  it("applies the entire migration lineage to a fresh database and is idempotent on second deploy", () => {
    assert.match(firstDeployOutput, new RegExp(schemaMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(backfillMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(constraintsMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(writerMigrationName, "u"));
    assert.match(
      firstDeployOutput,
      new RegExp(writerHardeningMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(historicalCleanupMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(statusHardeningMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(finalCorrectionMigrationName, "u"),
    );
    assert.match(firstDeployOutput, new RegExp(writerParityMigrationName, "u"));
    assert.match(
      firstDeployOutput,
      new RegExp(evidenceChainMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(pathSanitizerMigrationName, "u"),
    );
    assert.match(firstDeployOutput, new RegExp(pathCleanupMigrationName, "u"));
    assert.match(
      firstDeployOutput,
      new RegExp(storedFieldAdapterMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(storedFieldCleanupMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(siteSectionContractMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(siteSectionCleanupMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(tedIdentifierContactGateMigrationName, "u"),
    );
    assert.match(secondDeployOutput, /No pending migrations to apply/u);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name IN (
        '${schemaMigrationName}','${backfillMigrationName}',
        '${constraintsMigrationName}','${writerMigrationName}',
        '${writerHardeningMigrationName}','${historicalCleanupMigrationName}',
        '${statusHardeningMigrationName}','${finalCorrectionMigrationName}',
        '${writerParityMigrationName}','${evidenceChainMigrationName}',
        '${pathSanitizerMigrationName}','${pathCleanupMigrationName}',
        '${storedFieldAdapterMigrationName}','${storedFieldCleanupMigrationName}',
        '${siteSectionContractMigrationName}','${siteSectionCleanupMigrationName}',
        '${tedIdentifierContactGateMigrationName}'
      )
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
    `,
      ),
      "17",
    );
  });

  it("upgrades a fully migrated current-main clone without copying old PR migration names", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT last_seen_fetch_id::text FROM source_entity WHERE id='${SOURCE_ENTITY}';
    `,
      ),
      FETCH,
    );
    const bridge = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `
      SELECT jsonb_build_object(
        'id',id,'sourceEntityId',source_entity_id,'runId',run_id,
        'ingestVersion',ingest_version,'ingestStatus',ingest_status,'payload',payload
      )::text
      FROM raw_source_record WHERE workspace_id='${WORKSPACE_A}'
        AND source_entity_id='${SOURCE_ENTITY}';
    `,
      ),
    );
    assert.equal(bridge.sourceEntityId, SOURCE_ENTITY);
    assert.equal(bridge.runId, null);
    assert.equal(bridge.ingestVersion, "raw-source/legacy-reference/v1");
    assert.equal(bridge.ingestStatus, "QUARANTINED");
    assert.equal(
      bridge.payload._rawReceipt,
      "raw-source/legacy-monitored-reference/v1",
    );
    assert.doesNotMatch(
      JSON.stringify(bridge.payload),
      /Legacy GmbH|person@legacy/u,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT concat_ws('|',
        (SELECT raw_record_id::text FROM identity_link
          WHERE canonical_id='${COMPANY_A}' AND match_rule='domain_exact' LIMIT 1),
        (SELECT raw_record_id::text FROM field_evidence
          WHERE entity_id='${COMPANY_A}' AND field='name' LIMIT 1)
      );
    `,
      ),
      `${bridge.id}|${bridge.id}`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name LIKE '20260812%raw_source_v2'
         OR migration_name LIKE '20260813%monitored_source_raw%'
         OR migration_name = '20260814120000_raw_source_governance_disposition';
    `,
      ),
      "0",
    );
  });

  it("advances minimal 1500 product cleanup provenance exactly once", () => {
    const before = JSON.parse(minimal1500Before);
    const after = JSON.parse(minimal1500After);
    const secondPass = JSON.parse(minimal1500SecondPass);

    assert.deepEqual(before, {
      attributes: { products: ["pump", "AB"] },
      version: 7,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    assert.deepEqual(
      { attributes: after.attributes, version: after.version },
      { attributes: { products: ["pump"] }, version: 8 },
    );
    assert.notEqual(after.updatedAt, before.updatedAt);
    assert.deepEqual(secondPass, after);
  });

  it("cleans historical Canonical attributes and redacts unsafe FieldEvidence without deleting provenance rows", () => {
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.upgrade,
          `SELECT attributes::text FROM canonical_company WHERE id='${COMPANY_A}';`,
        ),
      ),
      {
        gleif: {
          lei: "529900T8BM49AURSDO55",
          legal_name: "Parker Hannifin",
        },
        products: ["pump", "LLZ"],
      },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM field_evidence WHERE entity_id='${COMPANY_A}';`,
      ),
      "8",
    );
    const cleanedEvidence = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `SELECT jsonb_agg(jsonb_build_object(
           'field',field,'value',value,'class',data_class,
           'actions',allowed_actions
         ) ORDER BY field)::text
         FROM field_evidence
         WHERE entity_id='${COMPANY_A}'
           AND field IN ('attributes','contact_email')
           AND raw_record_id='${SAFE_RAW_A}';`,
      ),
    );
    assert.equal(cleanedEvidence.length, 2);
    for (const evidence of cleanedEvidence) {
      assert.equal(
        evidence.value._historicalCleanup,
        "canonical-attribute-cleanup/v1",
      );
      assert.match(evidence.value.originalValueHash, /^[0-9a-f]{64}$/u);
      assert.equal(evidence.class, "red");
      assert.deepEqual(evidence.actions, []);
      assert.doesNotMatch(
        JSON.stringify(evidence.value),
        /person@example|alice van smith|unbounded historical prose/u,
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT count(*) FROM field_evidence
           WHERE entity_id='${COMPANY_A}'
             AND value::text ~* '(person@example|alice van smith|unbounded historical prose)';`,
        ),
      ),
      `${WORKSPACE_A}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM field_evidence
         WHERE raw_record_id='${RESTRICTED_RAW_A}'
           AND value::text LIKE '%protected.person@example.test%';`,
      ),
      "1",
    );
    const correctedCanonical = dockerPsql(
      databases.upgrade,
      `SELECT concat_ws('|',version::text,
         (updated_at > '2026-08-25T00:00:00Z'::timestamptz)::text,
         (attributes #> '{digital_footprint,structured_org}' IS NULL)::text)
       FROM canonical_company WHERE id='${COMPANY_A}';`,
    );
    assert.equal(correctedCanonical, "3|true|true");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',version::text,updated_at::text)
         FROM canonical_company
         WHERE id='70000000-0000-4000-8000-000000000002';`,
      ),
      "7|2026-08-25 00:00:00",
    );
    const obsoleteEvidence = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `SELECT jsonb_agg(jsonb_build_object(
           'value',value,'class',data_class,'actions',allowed_actions
         ) ORDER BY provider_key)::text
         FROM field_evidence
         WHERE entity_id='${COMPANY_A}'
           AND field='attributes'
           AND provider_key IN ('mapyourshow','usaspending_awards');`,
      ),
    );
    assert.equal(obsoleteEvidence.length, 2);
    assert.equal(
      obsoleteEvidence[0].value._historicalCleanup,
      "canonical-attribute-cleanup/v2",
    );
    assert.equal(obsoleteEvidence[0].class, "red");
    assert.deepEqual(obsoleteEvidence[0].actions, []);
    assert.deepEqual(obsoleteEvidence[1], {
      value: { products: ["LLZ1", "AB"] },
      class: "green",
      actions: ["display"],
    });
  });

  it("cleans historical full-path collisions once without deleting or weakening restrictive evidence", () => {
    assert.equal(
      dockerPsql(
        databases.pathCleanup,
        `SELECT concat_ws('|',version::text,
          (attributes #> '{digital_footprint,source}' IS NULL)::text,
          (SELECT count(*)::text FROM field_evidence
             WHERE entity_id='${COMPANY_A}'),
          (SELECT count(*)::text FROM field_evidence
             WHERE raw_record_id='${RESTRICTED_RAW_A}'
               AND value::text LIKE '%protected.person@example.test%')
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      "4|true|10|1",
    );
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.pathCleanup,
          `SELECT jsonb_build_object(
             'value',value,'class',data_class,'actions',allowed_actions
           )::text
           FROM field_evidence
           WHERE entity_id='${COMPANY_A}'
             AND field='digital_footprint'
             AND provider_key='registry_path_collision';`,
        ),
      ),
      {
        value: {
          _historicalCleanup: "canonical-attribute-cleanup/v2",
          reason: "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
          originalValueHash:
            "f7b7eecb5b69d0e0f5cf7f7cb4e5f98a6d22c7f141d53ab32352bd9a3ca1b597",
        },
        class: "red",
        actions: [],
      },
    );
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.pathCleanup,
          `SELECT jsonb_build_object(
             'value',value,'class',data_class,'actions',allowed_actions
           )::text
           FROM field_evidence
           WHERE entity_id='${COMPANY_A}'
             AND field='digital_footprint'
             AND provider_key='registry_path_v2_collision';`,
        ),
      ),
      {
        value: {
          _historicalCleanup: "canonical-attribute-cleanup/v3",
          reason: "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
          originalValueHash: "a".repeat(64),
          predecessorReceiptHash:
            "e000760d92e0936eaa0557c1b97a476b728b2a42361d7614e0fcc4bd230e15b7",
        },
        class: "red",
        actions: [],
      },
    );
    const beforeRerun = dockerPsql(
      databases.pathCleanup,
      `SELECT concat_ws('|',version::text,
        (SELECT encode(digest(raw_source_canonical_json_v1(value),'sha256'),'hex')
           FROM field_evidence
           WHERE entity_id='${COMPANY_A}'
             AND field='digital_footprint'
             AND provider_key='registry_path_collision'),
        (SELECT count(*)::text FROM field_evidence
           WHERE entity_id='${COMPANY_A}')
      ) FROM canonical_company WHERE id='${COMPANY_A}';`,
    );
    dockerPsql(
      databases.pathCleanup,
      readFileSync(pathCleanupMigrationPath, "utf8"),
    );
    assert.equal(
      dockerPsql(
        databases.pathCleanup,
        `SELECT concat_ws('|',version::text,
          (SELECT encode(digest(raw_source_canonical_json_v1(value),'sha256'),'hex')
             FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND field='digital_footprint'
               AND provider_key='registry_path_collision'),
          (SELECT count(*)::text FROM field_evidence
             WHERE entity_id='${COMPANY_A}')
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      beforeRerun,
    );
  });

  it("reproduces the frozen 2000 stored-intent misclassification before the forward correction", () => {
    assert.deepEqual(JSON.parse(storedFieldAfter2000), [
      {
        id: "81000000-0000-4000-8000-000000000101",
        field: "intent.tender",
        cleanup: "canonical-attribute-cleanup/v2",
        originalValueHash:
          "01666d0021c08e02df9edd362eea3ea4af5d6f314c1fa9737aa5ba7647f4c6d3",
        class: "red",
        actions: [],
      },
      {
        id: "81000000-0000-4000-8000-000000000102",
        field: "intent.clearance",
        cleanup: "canonical-attribute-cleanup/v2",
        originalValueHash:
          "27632d241236aa702afa8533dae6ae02108ce38917ab59da0b72b62096478309",
        class: "red",
        actions: [],
      },
      {
        id: "81000000-0000-4000-8000-000000000103",
        field: "intent.sources_sought",
        cleanup: "canonical-attribute-cleanup/v2",
        originalValueHash:
          "a66aa3e4376a0e3afd6ba6ac1a67fa42a29acc5a02bc3bc943b3372b36d6e7e7",
        class: "red",
        actions: [],
      },
      {
        id: "81000000-0000-4000-8000-000000000104",
        field: "intent.website_change",
        cleanup: null,
        originalValueHash: null,
        class: "green",
        actions: ["display", "match"],
      },
    ]);
  });

  it("applies the same closed stored-field adapter shapes as the application", () => {
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',
          encode(digest(raw_source_canonical_json_v1(
            raw_source_sanitize_stored_company_field_evidence_v1(
              'intent.tender',
              '${JSON.stringify({
                last_change_at: "2026-08-26T00:00:00.000Z",
                intent_score: 0.9,
                counts: { TENDER_PUBLISHED: 1 },
                events: [
                  {
                    type: "TENDER_PUBLISHED",
                    at: "2026-08-26T00:00:00.000Z",
                    strength: 0.9,
                    evidence: {
                      cpv: ["42122130"],
                      notice: "notice-1",
                      source: "ted",
                    },
                  },
                ],
                _ts: "2026-08-26T00:00:00.000Z",
              })}'::jsonb
            )), 'sha256'),'hex'),
          encode(digest(raw_source_canonical_json_v1(
            raw_source_sanitize_stored_company_field_evidence_v1(
              'intent.clearance',
              '${JSON.stringify({
                type: "FDA_CLEARANCE",
                at: "2026-08-26T00:00:00.000Z",
                strength: 0.85,
                evidence: {
                  product_code: "LLZ",
                  k_number: "K123456",
                  device: "Industrial pump controller",
                  source: "openfda",
                },
              })}'::jsonb
            )), 'sha256'),'hex'),
          encode(digest(raw_source_canonical_json_v1(
            raw_source_sanitize_stored_company_field_evidence_v1(
              'intent.sources_sought',
              '${JSON.stringify({
                events: [
                  {
                    type: "US_FED_SOURCES_SOUGHT",
                    at: "2026-08-26T00:00:00.000Z",
                    strength: 0.7,
                    evidence: {
                      naics: ["333914"],
                      notice: "W912HQ-26-S-0001",
                      source: "samgov",
                    },
                  },
                ],
              })}'::jsonb
            )), 'sha256'),'hex'),
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'source','"Call 555-0100 person@example.test Bearer secret"'::jsonb
          ) IS NULL)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'unknown.lei','"529900T8BM49AURSDO55"'::jsonb
          ) IS NULL)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'digital_footprint.structured_org',
            '{"name":"Acme Pump GmbH","source":"Call 555-0100 person@example.test Bearer secret"}'::jsonb
          ) = '{"name":"Acme Pump GmbH"}'::jsonb)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'intent.tender',
            '{"events":[{"type":"TENDER_PUBLISHED","at":"2026-08-26T00:00:00.000Z","strength":0.9,"evidence":{"cpv":["42122130"],"notice":"123456-2026","source":"ted"}}]}'::jsonb
          ) #>> '{events,0,evidence,notice}' = '123456-2026')::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'gleif.lei','"529900T8BM49AURSDO55"'::jsonb
          ) = '"529900T8BM49AURSDO55"'::jsonb)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'wikidata.qid','"Q123"'::jsonb
          ) = '"Q123"'::jsonb)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.hiring_signal',
            '{"source":"sitemap","open_roles":2,"titles":["Buyer"]}'::jsonb
          ) = '{"source":"sitemap","open_roles":2,"titles":["Buyer"]}'::jsonb)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'identity',
            '{"name":"Website Company","country":"DE","source":"ted","notice":"notice-1","attribution":"TED CC BY 4.0"}'::jsonb
          ) #>> '{source}' = 'ted')::text
        );`,
      ),
      [
        "01666d0021c08e02df9edd362eea3ea4af5d6f314c1fa9737aa5ba7647f4c6d3",
        "27632d241236aa702afa8533dae6ae02108ce38917ab59da0b72b62096478309",
        "a66aa3e4376a0e3afd6ba6ac1a67fa42a29acc5a02bc3bc943b3372b36d6e7e7",
        "true",
        "true",
        "true",
        "true",
        "true",
        "true",
        "true",
        "true",
      ].join("|"),
    );
  });

  it("requires the forward-only site-section contract and cleanup migrations", () => {
    assert.equal(
      existsSync(siteSectionContractMigrationPath),
      true,
      `${siteSectionContractMigrationName} must exist`,
    );
    assert.equal(
      existsSync(siteSectionCleanupMigrationPath),
      true,
      `${siteSectionCleanupMigrationName} must exist`,
    );
  });

  it("matches the hand-fixed application site-section bytes and producer bounds", () => {
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',
          raw_source_canonical_json_v1(
            raw_source_sanitize_stored_company_field_evidence_v1(
              'structured_harvest.site_sections',
              '{
                "products":8,"about":2,".well-known":1,"source":1,
                "notice":1,"contact":1,"person@example.test":1,
                "555-0100":1,"٥٥٥-٠١٠٠":1,"bearer-secret":1,
                "%70roducts":1,"xxxxxxxxxxxxxxxxxxxxxxxxx":1,"Ａbout":1
              }'::jsonb
            )
          ),
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.site_sections',
            '{
              ".well-known":1,"about":1,"blog":1,"careers":1,
              "company":1,"docs":1,"downloads":1,"events":1,
              "industries":1,"insights":1,"jobs":1,"news":1,
              "partners":1,"press":1,"products":5000,
              "publications":1,"resources":1,"services":1,
              "solutions":1,"support":1
            }'::jsonb
          ) IS NOT NULL)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.site_sections',
            '{
              ".well-known":1,"about":1,"blog":1,"careers":1,
              "company":1,"docs":1,"downloads":1,"events":1,
              "industries":1,"insights":1,"jobs":1,"news":1,
              "partners":1,"press":1,"products":1,
              "publications":1,"resources":1,"services":1,
              "solutions":1,"support":1,"sustainability":1
            }'::jsonb
          ) IS NULL)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.site_sections',
            '{"products":5001,"about":0,"careers":1.5}'::jsonb
          ) IS NULL)::text
        );`,
      ),
      '{".well-known":1,"about":2,"products":8}|true|true|true',
    );
  });

  it("restores only exact safe site sections and minimizes every unsafe historical form", () => {
    const rows = JSON.parse(
      dockerPsql(
        databases.storedField,
        `SELECT jsonb_agg(jsonb_build_object(
          'id',evidence.id,
          'value',evidence.value,
          'class',evidence.data_class,
          'actions',evidence.allowed_actions,
          'status',audit.status,
          'original',audit.original_value_hash,
          'predecessor',audit.predecessor_receipt_hash,
          'restored',audit.restored_value_hash
        ) ORDER BY evidence.id)::text
        FROM field_evidence AS evidence
        LEFT JOIN raw_source_field_evidence_cleanup_audit AS audit
          ON audit.field_evidence_id=evidence.id
         AND audit.cleanup_contract='raw-source-site-section-cleanup/v1'
         AND audit.adapter_version='structured-harvest-site-sections/v1'
        WHERE evidence.id IN (
          '81000000-0000-4000-8000-000000000201',
          '81000000-0000-4000-8000-000000000202',
          '81000000-0000-4000-8000-000000000203',
          '81000000-0000-4000-8000-000000000204',
          '81000000-0000-4000-8000-000000000205',
          '81000000-0000-4000-8000-000000000206',
          '81000000-0000-4000-8000-000000000207'
        );`,
      ),
    );

    assert.deepEqual(rows, [
      {
        id: "81000000-0000-4000-8000-000000000201",
        value: { products: 2 },
        class: "green",
        actions: ["display", "match"],
        status: "RESTORED",
        original: PRODUCTS_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor:
          "4a2a6800ad3d813b1a8a8f41e815309845364c3a14a47a315766c1ce932fa810",
        restored: PRODUCTS_SITE_SECTION_ORIGINAL_VALUE_HASH,
      },
      {
        id: "81000000-0000-4000-8000-000000000202",
        value: { ".well-known": 1 },
        class: "green",
        actions: ["display", "match"],
        status: "RESTORED",
        original: WELL_KNOWN_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor:
          "58afd74ac691a441f68cec27bbeff75cb777e612b283018b097fb9481f5a8c43",
        restored: WELL_KNOWN_SITE_SECTION_ORIGINAL_VALUE_HASH,
      },
      {
        id: "81000000-0000-4000-8000-000000000203",
        value: {
          _historicalCleanup: "structured-harvest-site-section-cleanup/v1",
          reason: "UNSAFE_SITE_SECTION_KEY_WITHHELD",
          originalValueHash: UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH,
        },
        class: "red",
        actions: [],
        status: "UNRECOVERABLE_HOLD",
        original: UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor:
          "abba34be33e1b8dfbf4bf5f242cdb850c0429c4d5f72e25de5a608c6b101261f",
        restored: null,
      },
      {
        id: "81000000-0000-4000-8000-000000000204",
        value: {
          _historicalCleanup: "structured-harvest-site-section-cleanup/v1",
          reason: "UNSAFE_SITE_SECTION_KEY_WITHHELD",
          originalValueHash: MIXED_SITE_SECTION_ORIGINAL_VALUE_HASH,
        },
        class: "red",
        actions: [],
        status: "UNRECOVERABLE_HOLD",
        original: MIXED_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor:
          "44cc5a4e9c1cf5fe3ccc8c97b289e472807481dcc3d4d3f1e6fe0b3e0fd13e14",
        restored: null,
      },
      {
        id: "81000000-0000-4000-8000-000000000205",
        value: { "555-0100": 1, "bearer-secret": 1 },
        class: "green",
        actions: ["display", "match"],
        status: null,
        original: null,
        predecessor: null,
        restored: null,
      },
      {
        id: "81000000-0000-4000-8000-000000000206",
        value: {
          _historicalCleanup: "structured-harvest-site-section-cleanup/v1",
          reason: "UNSAFE_SITE_SECTION_KEY_WITHHELD",
          originalValueHash: WELL_KNOWN_SITE_SECTION_ORIGINAL_VALUE_HASH,
        },
        class: "red",
        actions: [],
        status: "UNRECOVERABLE_HOLD",
        original: WELL_KNOWN_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor:
          "58afd74ac691a441f68cec27bbeff75cb777e612b283018b097fb9481f5a8c43",
        restored: null,
      },
      {
        id: "81000000-0000-4000-8000-000000000207",
        value: {
          _historicalCleanup: "structured-harvest-site-section-cleanup/v1",
          reason: "UNSAFE_SITE_SECTION_KEY_WITHHELD",
          originalValueHash: POST_2200_UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH,
        },
        class: "red",
        actions: [],
        status: "UNRECOVERABLE_HOLD",
        original: POST_2200_UNSAFE_SITE_SECTION_ORIGINAL_VALUE_HASH,
        predecessor: null,
        restored: null,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(rows.filter((row) => row.status === "UNRECOVERABLE_HOLD")),
      /555-0100|٥٥٥-٠١٠٠|person@example|bearer-secret|%70roducts|Ａbout|retainedValue/u,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
         WHERE cleanup_contract='raw-source-site-section-cleanup/v1'
           AND field_evidence_id='81000000-0000-4000-8000-000000000205';`,
      ),
      "0",
    );
  });

  it("restores only exact hash-matching current/linked candidates and preserves provenance bytes", () => {
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT string_agg(concat_ws(':',id::text,
          encode(digest(raw_source_canonical_json_v1(value),'sha256'),'hex'),
          data_class,allowed_actions::text,license,
          to_char(fetched_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),E'\n' ORDER BY id)
        FROM field_evidence
        WHERE id IN (
          '81000000-0000-4000-8000-000000000101',
          '81000000-0000-4000-8000-000000000102',
          '81000000-0000-4000-8000-000000000103',
          '81000000-0000-4000-8000-000000000104',
          '81000000-0000-4000-8000-000000000105',
          '81000000-0000-4000-8000-000000000115'
        );`,
      ),
      [
        '81000000-0000-4000-8000-000000000101:01666d0021c08e02df9edd362eea3ea4af5d6f314c1fa9737aa5ba7647f4c6d3:green:["display", "match"]:CC BY 4.0:2026-08-25T16:31:00.000Z',
        '81000000-0000-4000-8000-000000000102:27632d241236aa702afa8533dae6ae02108ce38917ab59da0b72b62096478309:green:["display", "match"]:CC0-1.0:2026-08-25T16:31:00.000Z',
        '81000000-0000-4000-8000-000000000103:a66aa3e4376a0e3afd6ba6ac1a67fa42a29acc5a02bc3bc943b3372b36d6e7e7:green:["display", "match"]:US Government Public Domain:2026-08-25T16:31:00.000Z',
        '81000000-0000-4000-8000-000000000104:dbce91d07200ee4034c7a499d6da5d208877e7e3ab53c1bb4cb542483deffa43:green:["display", "match"]:public:2026-08-25T16:31:00.000Z',
        '81000000-0000-4000-8000-000000000105:e0abd8c37da5f30a6844e4d90be289f1ad7e8ba1545191f80c87259657088b75:green:["display", "match"]:public:2026-08-25T16:31:00.000Z',
        '81000000-0000-4000-8000-000000000115:01666d0021c08e02df9edd362eea3ea4af5d6f314c1fa9737aa5ba7647f4c6d3:green:["display", "match"]:CC BY 4.0:2026-08-25T16:31:00.000Z',
      ].join("\n"),
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
         WHERE field_evidence_id IN (
           '81000000-0000-4000-8000-000000000101',
           '81000000-0000-4000-8000-000000000102',
           '81000000-0000-4000-8000-000000000103',
           '81000000-0000-4000-8000-000000000105',
           '81000000-0000-4000-8000-000000000115'
         )
           AND cleanup_contract='raw-source-stored-field-cleanup/v1'
           AND adapter_version='stored-company-field-evidence/v1'
           AND status='RESTORED'
           AND restored_value_hash=original_value_hash
           AND original_value_hash ~ '^[0-9a-f]{64}$';`,
      ),
      "5",
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
         WHERE field_evidence_id='81000000-0000-4000-8000-000000000104';`,
      ),
      "0",
    );
  });

  it("binds each restored v2/v3 transition to the exact current receipt digest", () => {
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT string_agg(
          field_evidence_id::text || ':' ||
            coalesce(predecessor_receipt_hash,'NULL'),
          E'\n' ORDER BY field_evidence_id
        )
        FROM raw_source_field_evidence_cleanup_audit
        WHERE field_evidence_id IN (
          '81000000-0000-4000-8000-000000000101',
          '81000000-0000-4000-8000-000000000115'
        ) AND status='RESTORED';`,
      ),
      [
        `81000000-0000-4000-8000-000000000101:${TENDER_V2_CURRENT_RECEIPT_HASH}`,
        `81000000-0000-4000-8000-000000000115:${TENDER_V3_CURRENT_RECEIPT_HASH}`,
      ].join("\n"),
    );
  });

  it("keeps unknown or non-matching evidence red/value-free and restrictive evidence byte-identical", () => {
    const restrictedBefore = [
      "protected.person@example.test",
      "green",
      '["display"]',
      "usaspending_awards",
      RESTRICTED_RAW_A,
      "2026-08-25T16:31:00.000Z",
    ].join("|");
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',value #>> '{}',data_class,allowed_actions::text,
          provider_key,raw_record_id::text,
          to_char(fetched_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         FROM field_evidence
         WHERE raw_record_id='${RESTRICTED_RAW_A}'
           AND field='contact_email';`,
      ),
      restrictedBefore,
    );
    const unsafe = JSON.parse(
      dockerPsql(
        databases.storedField,
        `SELECT jsonb_agg(jsonb_build_object(
           'id',evidence.id,'value',evidence.value,
           'class',evidence.data_class,'actions',evidence.allowed_actions,
           'status',audit.status,'original',audit.original_value_hash,
           'predecessor',audit.predecessor_receipt_hash,
           'restored',audit.restored_value_hash
         ) ORDER BY evidence.id)::text
         FROM field_evidence AS evidence
         JOIN raw_source_field_evidence_cleanup_audit AS audit
           ON audit.field_evidence_id=evidence.id
         WHERE evidence.id IN (
           '81000000-0000-4000-8000-000000000106',
           '81000000-0000-4000-8000-000000000107',
           '81000000-0000-4000-8000-000000000114'
         );`,
      ),
    );
    assert.deepEqual(
      unsafe.map((row) => ({
        id: row.id,
        contract: row.value._historicalCleanup,
        reason: row.value.reason,
        original: row.original,
        class: row.class,
        actions: row.actions,
        status: row.status,
        predecessor: row.predecessor,
        restored: row.restored,
      })),
      [
        {
          id: "81000000-0000-4000-8000-000000000106",
          contract: "stored-field-evidence-cleanup/v1",
          reason: "UNRECOVERABLE_STORED_FIELD_VALUE_WITHHELD",
          original:
            "9cb73648154637d87c88bf92036896531ce3fe96fb3a7271aabf0de1d4e5ae02",
          class: "red",
          actions: [],
          status: "UNRECOVERABLE_HOLD",
          predecessor: null,
          restored: null,
        },
        {
          id: "81000000-0000-4000-8000-000000000107",
          contract: "canonical-attribute-cleanup/v2",
          reason: "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
          original:
            "1b00174bbde20a10c55e527d7a39a537049dfe2719e15b7b5cea1e654f980a1f",
          class: "red",
          actions: [],
          status: "UNRECOVERABLE_HOLD",
          predecessor: null,
          restored: null,
        },
        {
          id: "81000000-0000-4000-8000-000000000114",
          contract: "canonical-attribute-cleanup/v2",
          reason: "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
          original:
            "13fdcb3e867c757286bd4e924cfd97f77de31d2ca4f856a8110e430fbbfcdedd",
          class: "red",
          actions: [],
          status: "UNRECOVERABLE_HOLD",
          predecessor:
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          restored: null,
        },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(unsafe),
      /555-0100|person@example|Bearer secret/u,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
         WHERE raw_record_id='${RESTRICTED_RAW_A}';`,
      ),
      "0",
    );
  });

  it("is byte-stable when 2200 is applied a second time", () => {
    const snapshot = () =>
      dockerPsql(
        databases.storedField,
        `SELECT encode(digest(concat_ws(E'\n',
          (SELECT string_agg(concat_ws('|',id::text,field,
            raw_source_canonical_json_v1(value),provider_key,
            coalesce(raw_record_id::text,'null'),coalesce(confidence::text,'null'),
            license,coalesce(allowed_actions::text,'null'),data_class,fetched_at::text
          ),E'\n' ORDER BY id) FROM field_evidence
            WHERE id::text LIKE '81000000-0000-4000-8000-0000000001%'),
          (SELECT string_agg(concat_ws('|',id::text,workspace_id::text,
            field_evidence_id::text,coalesce(raw_record_id::text,'null'),
            cleanup_contract,adapter_version,status,original_value_hash,
            coalesce(predecessor_receipt_hash,'null'),
            coalesce(restored_value_hash,'null'),created_at::text
          ),E'\n' ORDER BY id)
           FROM raw_source_field_evidence_cleanup_audit
           WHERE cleanup_contract='raw-source-stored-field-cleanup/v1'
             AND field_evidence_id::text LIKE
               '81000000-0000-4000-8000-0000000001%')
        ),'sha256'),'hex');`,
      );
    const before = snapshot();
    dockerPsql(
      databases.storedField,
      readFileSync(storedFieldCleanupMigrationPath, "utf8"),
    );
    assert.equal(snapshot(), before);
  });

  it("is byte-stable when 2400 is applied a second time", () => {
    assert.equal(existsSync(siteSectionCleanupMigrationPath), true);
    const snapshot = () =>
      dockerPsql(
        databases.storedField,
        `SELECT encode(digest(concat_ws(E'\n',
          (SELECT string_agg(concat_ws('|',id::text,
            raw_source_canonical_json_v1(value),data_class,
            allowed_actions::text,fetched_at::text
          ),E'\n' ORDER BY id) FROM field_evidence
            WHERE id::text LIKE '81000000-0000-4000-8000-0000000002%'),
          (SELECT string_agg(concat_ws('|',id::text,field_evidence_id::text,
            cleanup_contract,adapter_version,status,original_value_hash,
            coalesce(predecessor_receipt_hash,'null'),
            coalesce(restored_value_hash,'null'),created_at::text
          ),E'\n' ORDER BY id)
           FROM raw_source_field_evidence_cleanup_audit
           WHERE cleanup_contract='raw-source-site-section-cleanup/v1')
        ),'sha256'),'hex');`,
      );
    const before = snapshot();
    dockerPsql(
      databases.storedField,
      readFileSync(siteSectionCleanupMigrationPath, "utf8"),
    );
    assert.equal(snapshot(), before);
  });

  it("keeps the value-free audit surface FORCE-RLS scoped and application-write denied", () => {
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',
          c.relrowsecurity::text,c.relforcerowsecurity::text,
          has_table_privilege('app_user',c.oid,'SELECT')::text,
          has_table_privilege('app_user',c.oid,'INSERT')::text,
          has_table_privilege('app_user',c.oid,'UPDATE')::text,
          has_table_privilege('app_user',c.oid,'DELETE')::text,
          (SELECT (confdeltype='c')::text FROM pg_constraint
             WHERE conrelid=c.oid AND contype='f'
               AND confrelid='field_evidence'::regclass),
          (SELECT count(*)::text FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='raw_source_field_evidence_cleanup_audit'
               AND column_name IN (
                 'workspace_id','field_evidence_id','raw_record_id',
                 'cleanup_contract','adapter_version','status',
                 'original_value_hash','predecessor_receipt_hash',
                 'restored_value_hash','created_at'
               )))
         FROM pg_class AS c
         WHERE c.oid='raw_source_field_evidence_cleanup_audit'::regclass;`,
      ),
      "true|true|true|false|false|false|true|10",
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',
          has_function_privilege('app_user',
            'raw_source_site_section_key_valid_v1(text)','EXECUTE')::text,
          has_function_privilege('app_user',
            'raw_source_sanitize_site_sections_v1(jsonb)','EXECUTE')::text,
          has_function_privilege('app_user',
            'raw_source_sanitize_stored_company_field_evidence_v1(text,jsonb)',
            'EXECUTE')::text,
          has_function_privilege('app_user',
            'raw_source_linked_site_sections_candidate_v1(text,jsonb)',
            'EXECUTE')::text,
          has_function_privilege('app_user',
            'raw_source_current_site_sections_candidate_v1(text,jsonb)',
            'EXECUTE')::text,
          has_function_privilege('app_user',
            'raw_source_site_section_cleanup_receipt_shape_valid_v1(jsonb)',
            'EXECUTE')::text
        );`,
      ),
      "false|false|false|false|false|false",
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        asApp(
          WORKSPACE_A,
          `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
           WHERE field_evidence_id::text LIKE
             '81000000-0000-4000-8000-0000000001%';`,
        ),
      ),
      `${WORKSPACE_A}\n8`,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        asApp(
          WORKSPACE_B,
          `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
           WHERE field_evidence_id::text LIKE
             '81000000-0000-4000-8000-0000000001%';`,
        ),
      ),
      `${WORKSPACE_B}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        asApp(
          WORKSPACE_A,
          `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
           WHERE cleanup_contract='raw-source-site-section-cleanup/v1';`,
        ),
      ),
      `${WORKSPACE_A}\n6`,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        asApp(
          WORKSPACE_B,
          `SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
           WHERE cleanup_contract='raw-source-site-section-cleanup/v1';`,
        ),
      ),
      `${WORKSPACE_B}\n0`,
    );
    for (const statement of [
      `INSERT INTO raw_source_field_evidence_cleanup_audit(
         workspace_id,field_evidence_id,cleanup_contract,adapter_version,
         status,original_value_hash
       ) VALUES (
         '${WORKSPACE_A}','81000000-0000-4000-8000-000000000101',
         'raw-source-stored-field-cleanup/v1',
       'stored-company-field-evidence/v1','UNRECOVERABLE_HOLD',repeat('a',64)
       );`,
      `INSERT INTO raw_source_field_evidence_cleanup_audit(
         workspace_id,field_evidence_id,cleanup_contract,adapter_version,
         status,original_value_hash
       ) VALUES (
         '${WORKSPACE_A}','81000000-0000-4000-8000-000000000201',
         'raw-source-site-section-cleanup/v1',
         'structured-harvest-site-sections/v1','UNRECOVERABLE_HOLD',repeat('a',64)
       );`,
      `UPDATE raw_source_field_evidence_cleanup_audit
       SET status='RESTORED' WHERE workspace_id='${WORKSPACE_A}';`,
      `DELETE FROM raw_source_field_evidence_cleanup_audit
       WHERE workspace_id='${WORKSPACE_A}';`,
    ]) {
      dockerPsql(databases.storedField, asApp(WORKSPACE_A, statement), {
        rejects: /permission denied/u,
      });
    }
    dockerPsql(
      databases.storedField,
      `INSERT INTO raw_source_field_evidence_cleanup_audit(
         workspace_id,field_evidence_id,cleanup_contract,adapter_version,
         status,original_value_hash,evidence_fetched_at
       ) VALUES (
         '${WORKSPACE_A}','81000000-0000-4000-8000-000000000201',
         'raw-source-site-section-cleanup/v1',
         'stored-company-field-evidence/v1','UNRECOVERABLE_HOLD',repeat('a',64),
         '2026-08-25T16:31:00Z'
       );`,
      {
        rejects:
          /raw_source_field_evidence_cleanup_audit_contract_adapter_check/u,
      },
    );
  });

  it("allows parent FieldEvidence erasure to cascade without an audit immutability block", () => {
    dockerPsql(
      databases.storedField,
      `INSERT INTO field_evidence(
         id,workspace_id,entity_type,entity_id,field,value,provider_key,
         confidence,license,allowed_actions,data_class,fetched_at
       ) VALUES (
         '81000000-0000-4000-8000-000000000199','${WORKSPACE_A}','company',
         '${COMPANY_WEBSITE_CHANGE}','name','"Cascade Test"','registry',1,
         'public','["display"]','green','2026-08-25T16:31:00Z'
       );
       INSERT INTO raw_source_field_evidence_cleanup_audit(
         workspace_id,field_evidence_id,cleanup_contract,adapter_version,
         status,original_value_hash,evidence_fetched_at
       ) VALUES (
         '${WORKSPACE_A}','81000000-0000-4000-8000-000000000199',
         'raw-source-stored-field-cleanup/v1',
         'stored-company-field-evidence/v1','UNRECOVERABLE_HOLD',repeat('a',64),
         '2026-08-25T16:31:00Z'
       );
       INSERT INTO raw_source_field_evidence_cleanup_audit(
         workspace_id,field_evidence_id,cleanup_contract,adapter_version,
         status,original_value_hash,evidence_fetched_at
       ) VALUES (
         '${WORKSPACE_A}','81000000-0000-4000-8000-000000000199',
         'raw-source-site-section-cleanup/v1',
         'structured-harvest-site-sections/v1','UNRECOVERABLE_HOLD',repeat('b',64),
         '2026-08-25T16:31:00Z'
       );
       DELETE FROM field_evidence
       WHERE id='81000000-0000-4000-8000-000000000199';`,
    );
    assert.equal(
      dockerPsql(
        databases.storedField,
        `SELECT concat_ws('|',
          (SELECT count(*) FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000199'),
          (SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
            WHERE field_evidence_id='81000000-0000-4000-8000-000000000199')
        );`,
      ),
      "0|0",
    );
  });

  it("keeps a dotted products v2 receipt byte-stable across direct sanitization and a second 1800 pass", () => {
    const readSnapshot = () =>
      JSON.parse(
        dockerPsql(
          databases.dottedReceipt,
          `SELECT jsonb_build_object(
            'value',evidence.value,
            'sanitized',raw_source_sanitize_field_evidence_v4(
              evidence.field,evidence.value
            ),
            'receiptHash',encode(digest(
              raw_source_canonical_json_v1(evidence.value),'sha256'
            ),'hex'),
            'rowDigest',encode(digest(concat_ws('|',
              evidence.id::text,evidence.workspace_id::text,
              evidence.entity_type,evidence.entity_id::text,evidence.field,
              raw_source_canonical_json_v1(evidence.value),
              evidence.provider_key,coalesce(evidence.raw_record_id::text,'null'),
              coalesce(evidence.confidence::text,'null'),evidence.license,
              coalesce(evidence.allowed_actions::text,'null'),
              evidence.data_class,evidence.fetched_at::text
            ),'sha256'),'hex'),
            'rowCount',(SELECT count(*) FROM field_evidence
              WHERE entity_id='${COMPANY_A}'),
            'targetCount',(SELECT count(*) FROM field_evidence
              WHERE entity_id='${COMPANY_A}'
                AND raw_record_id='${DOTTED_PRODUCTS_RAW_A}'),
            'workspaceId',evidence.workspace_id,
            'entityType',evidence.entity_type,
            'entityId',evidence.entity_id,
            'field',evidence.field,
            'providerKey',evidence.provider_key,
            'rawRecordId',evidence.raw_record_id,
            'confidence',evidence.confidence,
            'license',evidence.license,
            'actions',evidence.allowed_actions,
            'dataClass',evidence.data_class,
            'fetchedAt',to_char(
              evidence.fetched_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'predecessorPresent',(evidence.value ? 'predecessorReceiptHash'),
            'containsUnsafe',(evidence.value::text LIKE '%"AB"%'),
            'helperAclClosed',(
              NOT has_function_privilege(
                'app_user',
                'raw_source_sanitize_field_evidence_plain_v5(text,jsonb)',
                'EXECUTE'
              )
              AND NOT has_function_privilege(
                'app_user',
                'raw_source_cleanup_receipt_v2_shape_valid_v1(jsonb)',
                'EXECUTE'
              )
            )
          )::text
          FROM field_evidence AS evidence
          WHERE evidence.entity_id='${COMPANY_A}'
            AND evidence.raw_record_id='${DOTTED_PRODUCTS_RAW_A}';`,
        ),
      );
    const expectedReceipt = {
      _historicalCleanup: "canonical-attribute-cleanup/v2",
      reason: "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
      originalValueHash: DOTTED_PRODUCTS_ORIGINAL_VALUE_HASH,
      retainedValue: ["pump"],
    };
    const expectedMetadata = {
      rowCount: 9,
      targetCount: 1,
      workspaceId: WORKSPACE_A,
      entityType: "company",
      entityId: COMPANY_A,
      field: "gleif.products",
      providerKey: "registry",
      rawRecordId: DOTTED_PRODUCTS_RAW_A,
      confidence: 1,
      license: "public",
      actions: [],
      dataClass: "red",
      fetchedAt: "2026-08-25T16:31:00.000Z",
      predecessorPresent: false,
      containsUnsafe: false,
      helperAclClosed: true,
    };
    const metadata = (snapshot) => ({
      rowCount: snapshot.rowCount,
      targetCount: snapshot.targetCount,
      workspaceId: snapshot.workspaceId,
      entityType: snapshot.entityType,
      entityId: snapshot.entityId,
      field: snapshot.field,
      providerKey: snapshot.providerKey,
      rawRecordId: snapshot.rawRecordId,
      confidence: snapshot.confidence,
      license: snapshot.license,
      actions: snapshot.actions,
      dataClass: snapshot.dataClass,
      fetchedAt: snapshot.fetchedAt,
      predecessorPresent: snapshot.predecessorPresent,
      containsUnsafe: snapshot.containsUnsafe,
      helperAclClosed: snapshot.helperAclClosed,
    });

    const first = readSnapshot();
    dockerPsql(
      databases.dottedReceipt,
      readFileSync(evidenceChainMigrationPath, "utf8"),
    );
    const second = readSnapshot();

    assert.deepEqual(
      {
        firstReceipt: first.value,
        directSanitized: first.sanitized,
        secondReceipt: second.value,
        secondSanitized: second.sanitized,
        receiptBytesStable: first.receiptHash === second.receiptHash,
        rowBytesStable: first.rowDigest === second.rowDigest,
        firstMetadata: metadata(first),
        secondMetadata: metadata(second),
      },
      {
        firstReceipt: expectedReceipt,
        directSanitized: expectedReceipt,
        secondReceipt: expectedReceipt,
        secondSanitized: expectedReceipt,
        receiptBytesStable: true,
        rowBytesStable: true,
        firstMetadata: expectedMetadata,
        secondMetadata: expectedMetadata,
      },
    );

    dockerPsql(
      databases.dottedReceipt,
      `UPDATE field_evidence
       SET value=jsonb_build_object(
         '_historicalCleanup','canonical-attribute-cleanup/v2',
         'reason','UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD',
         'originalValueHash','${DOTTED_PRODUCTS_ORIGINAL_VALUE_HASH}',
         'retainedValue','["pump","AB"]'::jsonb
       )
       WHERE entity_id='${COMPANY_A}'
         AND raw_record_id='${DOTTED_PRODUCTS_RAW_A}';`,
    );
    const readFailClosedSnapshot = () =>
      JSON.parse(
        dockerPsql(
          databases.dottedReceipt,
          `SELECT jsonb_build_object(
            'originalValueHash',value->>'originalValueHash',
            'retainedHasSafe',((value->'retainedValue') ? 'pump'),
            'retainedHasUnsafe',((value->'retainedValue') ? 'AB'),
            'sanitizerIsNull',(
              raw_source_sanitize_field_evidence_v4(field,value) IS NULL
            ),
            'receiptHash',encode(digest(
              raw_source_canonical_json_v1(value),'sha256'
            ),'hex'),
            'rowDigest',encode(digest(concat_ws('|',
              id::text,workspace_id::text,entity_type,entity_id::text,field,
              raw_source_canonical_json_v1(value),provider_key,
              coalesce(raw_record_id::text,'null'),
              coalesce(confidence::text,'null'),license,
              coalesce(allowed_actions::text,'null'),data_class,fetched_at::text
            ),'sha256'),'hex')
          )::text
          FROM field_evidence
          WHERE entity_id='${COMPANY_A}'
            AND raw_record_id='${DOTTED_PRODUCTS_RAW_A}';`,
        ),
      );
    const invalidBefore = readFailClosedSnapshot();
    dockerPsql(
      databases.dottedReceipt,
      readFileSync(evidenceChainMigrationPath, "utf8"),
    );
    const invalidAfter = readFailClosedSnapshot();
    assert.deepEqual(
      {
        originalValueHash: invalidAfter.originalValueHash,
        retainedHasSafe: invalidAfter.retainedHasSafe,
        retainedHasUnsafe: invalidAfter.retainedHasUnsafe,
        sanitizerIsNull: invalidAfter.sanitizerIsNull,
        receiptBytesStable:
          invalidBefore.receiptHash === invalidAfter.receiptHash,
        rowBytesStable: invalidBefore.rowDigest === invalidAfter.rowDigest,
      },
      {
        originalValueHash: DOTTED_PRODUCTS_ORIGINAL_VALUE_HASH,
        retainedHasSafe: true,
        retainedHasUnsafe: true,
        sanitizerIsNull: true,
        receiptBytesStable: true,
        rowBytesStable: true,
      },
    );
  });

  it("preserves the original evidence digest and binds the immediate v1 cleanup receipt", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          value->>'_historicalCleanup',
          value->>'reason',
          value->>'originalValueHash',
          coalesce(value->>'predecessorReceiptHash','MISSING'),
          (value ? 'retainedValue')::text,
          (value::text LIKE '%\"AB\"%')::text,
          (value::text LIKE '%forbidden free text%')::text,
          (workspace_id='${WORKSPACE_A}'::uuid)::text,
          (raw_record_id='${EVIDENCE_CHAIN_RAW_A}'::uuid)::text,
          (field='attributes')::text,
          (provider_key='registry')::text,
          (fetched_at='2026-08-25T16:31:00Z'::timestamptz)::text,
          data_class,
          allowed_actions::text
        ) FROM field_evidence
        WHERE entity_id='${COMPANY_A}'
          AND raw_record_id='${EVIDENCE_CHAIN_RAW_A}';`,
      ),
      [
        "canonical-attribute-cleanup/v2",
        "UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD",
        EVIDENCE_CHAIN_ORIGINAL_VALUE_HASH,
        EVIDENCE_CHAIN_PREDECESSOR_RECEIPT_HASH,
        "false",
        "false",
        "false",
        "true",
        "true",
        "true",
        "true",
        "true",
        "red",
        "[]",
      ].join("|"),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT (
          value IS NOT DISTINCT FROM
            raw_source_sanitize_field_evidence_v4(field,value)
        )::text
        FROM field_evidence
        WHERE entity_id='${COMPANY_A}'
          AND raw_record_id='${EVIDENCE_CHAIN_RAW_A}';`,
      ),
      "true",
    );
    const beforeRerun = dockerPsql(
      databases.upgrade,
      `SELECT concat_ws('|',
        encode(digest(raw_source_canonical_json_v1(value),'sha256'),'hex'),
        data_class,
        allowed_actions::text,
        (SELECT version::text FROM canonical_company
          WHERE id='${COMPANY_A}'),
        (SELECT updated_at::text FROM canonical_company
          WHERE id='${COMPANY_A}'),
        (SELECT count(*)::text FROM field_evidence
          WHERE entity_id='${COMPANY_A}'),
        (SELECT encode(digest(string_agg(
          id::text || '|' || field || '|' ||
          raw_source_canonical_json_v1(value) || '|' || data_class || '|' ||
          coalesce(allowed_actions::text,'null'), E'\n' ORDER BY id
        ),'sha256'),'hex') FROM field_evidence
          WHERE entity_id='${COMPANY_A}')
      ) FROM field_evidence
      WHERE entity_id='${COMPANY_A}'
        AND raw_record_id='${EVIDENCE_CHAIN_RAW_A}';`,
    );
    dockerPsql(
      databases.upgrade,
      readFileSync(evidenceChainMigrationPath, "utf8"),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          encode(digest(raw_source_canonical_json_v1(value),'sha256'),'hex'),
          data_class,
          allowed_actions::text,
          (SELECT version::text FROM canonical_company
            WHERE id='${COMPANY_A}'),
          (SELECT updated_at::text FROM canonical_company
            WHERE id='${COMPANY_A}'),
          (SELECT count(*)::text FROM field_evidence
            WHERE entity_id='${COMPANY_A}'),
          (SELECT encode(digest(string_agg(
            id::text || '|' || field || '|' ||
            raw_source_canonical_json_v1(value) || '|' || data_class || '|' ||
            coalesce(allowed_actions::text,'null'), E'\n' ORDER BY id
          ),'sha256'),'hex') FROM field_evidence
            WHERE entity_id='${COMPANY_A}')
        ) FROM field_evidence
        WHERE entity_id='${COMPANY_A}'
          AND raw_record_id='${EVIDENCE_CHAIN_RAW_A}';`,
      ),
      beforeRerun,
    );
  });

  it("applies the closed PostgreSQL semantic schema to every governed provider payload", () => {
    const provenance = (sourceUrl, parserVersion) => ({
      sourceUrl,
      fetchedAt: "2026-08-26T00:00:00.000Z",
      contentHash: "a".repeat(64),
      parserVersion,
    });
    const payloads = [
      [
        "registry",
        {
          externalId: "registry-alice-van-smith",
          name: "Alice Van Smith",
          attributes: { products: ["pump"] },
          provenance: provenance(
            "https://registry.example/company/alice-van-smith",
            "registry/v2",
          ),
        },
      ],
      [
        "registry",
        {
          externalId: "registry-1",
          name: "Johnson Controls",
          domain: "johnson.example",
          country: "US",
          attributes: {
            products: ["industrial pump"],
            employee_band: "50-100",
          },
          identifier: { scheme: "lei", value: "529900T8BM49AURSDO55" },
          license: "public",
          provenance: provenance(
            "https://registry.example/company/1",
            "registry/v2",
          ),
        },
      ],
      [
        "directory",
        {
          externalId: "directory:parker.example",
          name: "Parker Hannifin",
          domain: "parker.example",
          attributes: {
            detail_url: "https://directory.example/company/parker",
            source_class: "industry_data",
            source_directory: "directory.example",
            source_kind: "directory",
          },
          provenance: provenance(
            "https://directory.example/list",
            "directory/v1",
          ),
        },
      ],
      [
        "directory",
        {
          externalId: "directory:directory.example:parker-hannifin",
          name: "Parker Hannifin",
          attributes: {
            source_class: "industry_data",
            source_directory: "directory.example",
            source_kind: "directory",
          },
          provenance: provenance(
            "https://directory.example/list",
            "directory/v1",
          ),
        },
      ],
      [
        "wikidata",
        {
          externalId: "wikidata:Q1",
          name: "General Dynamics",
          attributes: {
            wikidata_qid: "Q1",
            latitude: 38.95,
            longitude: -77.35,
            source_class: "company_registry",
          },
          license: "CC0-1.0",
          provenance: provenance(
            "https://www.wikidata.org/wiki/Q1",
            "wikidata/v1",
          ),
        },
      ],
      [
        "openstreetmap",
        {
          externalId: "osm:node/1",
          name: "General Dynamics",
          attributes: {
            osm_id: "node/1",
            latitude: 38.95,
            longitude: -77.35,
            source_class: "industry_data",
          },
          license: "ODbL-1.0",
          provenance: provenance(
            "https://overpass-api.de/api/interpreter",
            "osm/v1",
          ),
        },
      ],
      [
        "trade_fair",
        {
          externalId: "fair-2026:ex-1",
          name: "Parker Hannifin",
          attributes: {
            stand: "A42",
            products: ["industrial pump"],
            source_fair: "fair-2026",
            source_class: "industry_data",
          },
          license: "SOURCE_SPECIFIC_RESTRICTED",
          provenance: provenance(
            "https://fair.example/exhibitors",
            "trade-fair/v1",
          ),
        },
      ],
      [
        "ted",
        {
          externalId: "ted:123456-2026:0",
          name: "Johnson Controls",
          country: "DE",
          identifier: { scheme: "ted-natid:de", value: "DE111" },
          attributes: {
            ted: {
              publication_number: "123456-2026",
              publication_date: "2026-08-25",
              notice_type: "can-standard",
              cpv: ["42122000"],
              buyer_countries: ["DEU"],
              winner_identifier: "DE111",
            },
          },
          license: "CC BY 4.0",
          provenance: provenance(
            "https://api.ted.europa.eu/v3/notices/search",
            "ted/v1",
          ),
        },
      ],
      [
        "openfda",
        {
          externalId: "openfda:3004512345",
          name: "Parker Hannifin",
          country: "US",
          identifier: { scheme: "fda-reg", value: "3004512345" },
          attributes: {
            fda: {
              registration_number: "3004512345",
              fei_number: "3004512345",
              status_code: "1",
              state_code: "OH",
              initial_importer: false,
              product_codes: ["LLZ"],
              owner_operator_numbers: ["9012345"],
              created_date: "2009-03-01",
            },
            products: ["LLZ"],
          },
          license: "CC0-1.0",
          provenance: provenance(
            "https://api.fda.gov/device/registrationlisting.json",
            "openfda/v1",
          ),
        },
      ],
      [
        "public_web",
        {
          externalId: "numeric.example",
          name: "General Dynamics",
          domain: "numeric.example",
          attributes: {
            products: ["industrial pump"],
            keywords: ["industrial"],
            extraction_confidence: 1e-7,
            extraction_evidence_digest: "f".repeat(64),
            source_class: "public_intelligence",
          },
          provenance: provenance(
            "https://numeric.example/company",
            "public-web/v1",
          ),
        },
      ],
    ];
    for (const [providerKey, payload] of payloads) {
      const encoded = JSON.stringify(payload).replaceAll("'", "''");
      assert.equal(
        dockerPsql(
          databases.upgrade,
          `SELECT raw_source_provider_payload_valid_v2(
             '${providerKey}','${encoded}'::jsonb
           );`,
        ),
        "t",
        providerKey,
      );
    }
  });

  it("sanitizes semantic identifiers by exact full paths instead of global leaf names", () => {
    const semanticKeys = [
      "cpv",
      "fei_number",
      "isin",
      "k_number",
      "lei",
      "legal_form_code",
      "naics",
      "notice",
      "osm_id",
      "owner_operator_numbers",
      "parent_lei",
      "parent_qid",
      "product_code",
      "publication_number",
      "qid",
      "registration_number",
      "source",
      "ultimate_parent_lei",
      "wikidata_qid",
      "winner_identifier",
    ];
    const hostile = {
      digital_footprint: {
        safe: "industrial",
        phone_collisions: Object.fromEntries(
          semanticKeys.map((key) => [key, "Call 555-0100"]),
        ),
        unicode_phone_collisions: Object.fromEntries(
          semanticKeys.map((key) => [key, "Call ٥٥٥-٠١٠٠"]),
        ),
        secret_collisions: Object.fromEntries(
          semanticKeys.map((key) => [key, "Bearer secret"]),
        ),
        source: "Call 555-0100",
      },
      ted: {
        publication_number: "123456-2026",
        cpv: ["42122130"],
        winner_identifier: "Call 555-0100",
      },
      intent: {
        events: [
          {
            type: "TENDER_PUBLISHED",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.9,
            evidence: {
              cpv: ["42122130"],
              notice: "Call ٥٥٥-٠١٠٠",
              source: "Bearer secret",
            },
          },
        ],
      },
    };
    const sanitized = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `SELECT sanitize_canonical_company_attributes_v3(
          '${JSON.stringify(hostile).replaceAll("'", "''")}'::jsonb
        )::text;`,
      ),
    );
    assert.deepEqual(sanitized, {
      digital_footprint: { safe: "industrial" },
      ted: {
        publication_number: "123456-2026",
        cpv: ["42122130"],
      },
      intent: {
        events: [
          {
            type: "TENDER_PUBLISHED",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.9,
            evidence: { cpv: ["42122130"] },
          },
        ],
      },
    });

    const legitimate = {
      wikidata_qid: "Q206894",
      osm_id: "relation/62422",
      ted: {
        publication_number: "123456-2026",
        cpv: ["42122130"],
        winner_identifier: "DE111",
      },
      fda: {
        registration_number: "3004512345",
        fei_number: "3012345678",
        owner_operator_numbers: ["10001234"],
      },
      gleif: {
        lei: "529900T8BM49AURSDO55",
        legal_form_code: "8888",
        parent_lei: "5493001KJTIIGC8Y1R12",
        ultimate_parent_lei: "213800D1EI4B9WTWWD28",
      },
      wikidata: {
        qid: "Q123",
        parent_qid: "Q456",
        lei: "529900T8BM49AURSDO55",
        isin: "DE000BASF111",
      },
      structured_harvest: {
        hiring_signal: { source: "ats:greenhouse", open_roles: 2 },
      },
      intent: {
        events: [
          {
            type: "US_FED_SOURCES_SOUGHT",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.7,
            evidence: {
              naics: ["333914"],
              notice: "notice-1",
              source: "samgov",
            },
          },
          {
            type: "FDA_CLEARANCE",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.85,
            evidence: {
              product_code: "LLZ",
              k_number: "K123456",
              source: "openfda",
            },
          },
        ],
      },
    };
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.upgrade,
          `SELECT sanitize_canonical_company_attributes_v3(
            '${JSON.stringify(legitimate).replaceAll("'", "''")}'::jsonb
          )::text;`,
        ),
      ),
      legitimate,
    );
  });

  it("keeps the controlled writer in exact company-name parity with application admission", () => {
    const acceptedNames = [
      "Alice Van Smith",
      "Johnson Controls",
      "Parker Hannifin",
      "General Dynamics",
    ];
    acceptedNames.forEach((name, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      const command = writerCommand({
        recordId: `82100000-0000-4000-8000-000000000${sequence}`,
        externalId: `company-parity-valid-${index + 1}`,
        payload: {
          externalId: `company-parity-valid-${index + 1}`,
          name,
          domain: `company-parity-valid-${index + 1}.example`,
          attributes: { products: ["pump"] },
          provenance: {
            sourceUrl: `https://registry.example/company/parity-valid-${index + 1}`,
            fetchedAt: new Date().toISOString(),
            contentHash: "a".repeat(64),
            parserVersion: "registry/v2",
          },
        },
      });
      const receipt = dockerPsql(
        databases.upgrade,
        asApp(WORKSPACE_A, writerSql(command)),
      )
        .split("\n")
        .at(-1)
        .split("|");
      assert.equal(receipt[0], command.recordId);
      assert.match(receipt[1], /^[0-9a-f]{64}$/u);
      assert.ok(Number(receipt[2]) > 0);
      assert.deepEqual(receipt.slice(3), ["ACCEPTED", "true"]);
    });

    const rejectedNames = [
      "Alice Van Smith ",
      " Alice Van Smith",
      "person@example.test",
      "Acme 555-0100",
      "Acme ٥٥٥-٠١٠٠",
      "Bearer secret",
      "Acme api key",
      "https://acme.example",
      "Ａcme GmbH",
      42,
      "John Doe",
      "A".repeat(161),
    ];
    rejectedNames.forEach((name, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      const command = writerCommand({
        recordId: `82200000-0000-4000-8000-000000000${sequence}`,
        externalId: `company-parity-invalid-${index + 1}`,
        payload: {
          externalId: `company-parity-invalid-${index + 1}`,
          name,
          domain: `company-parity-invalid-${index + 1}.example`,
          attributes: { products: ["pump"] },
          provenance: {
            sourceUrl: `https://registry.example/company/parity-invalid-${index + 1}`,
            fetchedAt: new Date().toISOString(),
            contentHash: "a".repeat(64),
            parserVersion: "registry/v2",
          },
        },
      });
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects: /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      });
    });
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id::text LIKE '82200000-0000-4000-8000-%';`,
      ),
      "0",
    );
  });

  it("rejects Unicode phones, secret-shaped FDA codes, booleans, and present JSON null across PostgreSQL provider scalars", () => {
    const registryBase = {
      externalId: "registry-types",
      name: "Parker Hannifin",
      country: "US",
      attributes: { products: ["pump"], employee_band: "50-100" },
      license: "public",
      provenance: {
        sourceUrl: "https://registry.example/company/types",
        fetchedAt: "2026-08-26T00:00:00.000Z",
        contentHash: "a".repeat(64),
        parserVersion: "registry/v2",
      },
    };
    const openFdaBase = {
      externalId: "openfda:3004512345",
      name: "Parker Hannifin",
      country: "US",
      identifier: { scheme: "fda-reg", value: "3004512345" },
      attributes: {
        fda: {
          registration_number: "3004512345",
          fei_number: "3004512345",
          status_code: "1",
          state_code: "OH",
          product_codes: ["LLZ"],
        },
        products: ["LLZ"],
      },
      license: "CC0-1.0",
      provenance: {
        sourceUrl: "https://api.fda.gov/device/registrationlisting.json",
        fetchedAt: "2026-08-26T00:00:00.000Z",
        contentHash: "a".repeat(64),
        parserVersion: "openfda/v1",
      },
    };
    const hostile = [
      ["registry", { ...registryBase, name: true }],
      ["registry", { ...registryBase, country: null }],
      ["registry", { ...registryBase, license: null }],
      [
        "registry",
        {
          ...registryBase,
          attributes: { ...registryBase.attributes, employee_band: null },
        },
      ],
      [
        "registry",
        {
          ...registryBase,
          name: "Acme ٥٥٥-٠١٠٠",
        },
      ],
      [
        "registry",
        {
          ...registryBase,
          name: "https://registry.example/company/acme",
        },
      ],
      [
        "registry",
        {
          ...registryBase,
          provenance: {
            ...registryBase.provenance,
            sourceUrl: "https://registry.example/company/٥٥٥-٠١٠٠",
          },
        },
      ],
      [
        "openfda",
        {
          ...openFdaBase,
          attributes: {
            ...openFdaBase.attributes,
            fda: { ...openFdaBase.attributes.fda, fei_number: null },
          },
        },
      ],
      ...["SECRET", "LLZ1", "AB"].map((productCode) => [
        "openfda",
        {
          ...openFdaBase,
          attributes: {
            fda: {
              ...openFdaBase.attributes.fda,
              product_codes: [productCode],
            },
            products: [productCode],
          },
        },
      ]),
    ];
    for (const [providerKey, payload] of hostile) {
      const encoded = JSON.stringify(payload).replaceAll("'", "''");
      assert.equal(
        dockerPsql(
          databases.upgrade,
          `SELECT raw_source_provider_payload_valid_v2(
             '${providerKey}','${encoded}'::jsonb
           );`,
        ),
        "f",
        `${providerKey}:${encoded.slice(0, 120)}`,
      );
    }
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.upgrade,
          `SELECT sanitize_canonical_company_attributes_v2(
            '{"products":["pump","LLZ","SECRET","LLZ1","AB"]}'::jsonb
          )::text;`,
        ),
      ),
      { products: ["pump", "LLZ"] },
    );
  });

  it("stores an immutable historical restriction with the exact Raw provenance snapshot", () => {
    const snapshot = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `
      SELECT jsonb_build_object(
        'provider',d.provider_key,'runId',d.run_id,'hash',d.raw_payload_hash,
        'ingestVersion',d.raw_ingest_version,'rawCreatedAt',d.raw_created_at,
        'fields',d.detected_fields,'rawProvider',r.provider_key,
        'rawRunId',r.run_id,'rawHash',r.payload_hash,
        'rawIngestVersion',r.ingest_version,'rawCreated',r.created_at
      )::text
      FROM raw_source_governance_disposition d
      JOIN raw_source_record r
        ON r.workspace_id=d.workspace_id AND r.id=d.raw_record_id
      WHERE d.raw_record_id='${RESTRICTED_RAW_A}';
    `,
      ),
    );
    assert.equal(snapshot.provider, snapshot.rawProvider);
    assert.equal(snapshot.runId, snapshot.rawRunId);
    assert.equal(snapshot.hash, snapshot.rawHash);
    assert.equal(snapshot.ingestVersion, snapshot.rawIngestVersion);
    assert.equal(snapshot.rawCreatedAt, snapshot.rawCreated);
    assert.deepEqual(snapshot.fields, ["recipient_name", "description"]);
    dockerPsql(
      databases.upgrade,
      `UPDATE raw_source_governance_disposition SET actor='rewritten'
       WHERE raw_record_id='${RESTRICTED_RAW_A}';`,
      { rejects: /permanent and append-only/u },
    );
    dockerPsql(
      databases.upgrade,
      `DELETE FROM raw_source_governance_disposition
       WHERE raw_record_id='${RESTRICTED_RAW_A}';`,
      { rejects: /permanent and append-only/u },
    );
  });

  it("enforces workspace A/B/unset RLS and a composite workspace/run foreign key", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_A}\n1`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_B,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_B}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SET SESSION AUTHORIZATION app_user;
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
      ),
      "0",
    );

    for (const legacyInsert of [
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
      ) VALUES (
        '81000000-0000-4000-8000-000000000001','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','default-legacy','{"name":"Default Legacy"}',
        'https://registry.example/default-legacy',now(),repeat('a',64),'registry/v1',0,now()
      );`,
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        retention_days,expires_at,source_policy_snapshot
      ) VALUES (
        '81000000-0000-4000-8000-000000000002','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','explicit-legacy','{"name":"Explicit Legacy"}',
        'https://registry.example/explicit-legacy',now(),repeat('b',64),'registry/v1',0,now(),
        'external:${"c".repeat(64)}',repeat('d',64),32,'raw-source/v1','ACCEPTED',
        30,now()+interval '30 days','{"kind":"source_policy","retentionDays":30,"minimizedFields":[]}'
      );`,
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        retention_days,expires_at,source_policy_snapshot
      ) VALUES (
        '81000000-0000-4000-8000-000000000004','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','forged-v2','{"name":"Forged V2"}',
        'https://registry.example/forged-v2',now(),repeat('a',64),'registry/v2',0,now(),
        'external:${"9".repeat(64)}',repeat('0',64),1,'raw-source/v2','ACCEPTED',
        30,now()+interval '30 days','{"kind":"source_policy","id":"${POLICY_A}"}'
      );`,
    ]) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, legacyInsert), {
        rejects:
          /RAW_SOURCE_INSERT_V2_REQUIRED|raw-source\/v2|check constraint|permission denied/u,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id IN (
           '81000000-0000-4000-8000-000000000001',
           '81000000-0000-4000-8000-000000000002',
           '81000000-0000-4000-8000-000000000004'
         );`,
      ),
      "0",
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "81000000-0000-4000-8000-000000000003",
            externalId: "safe-a",
            payload: {
              externalId: "safe-a",
              name: "Safe A GmbH",
              domain: "safe-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/safe-a-v2",
                fetchedAt: "2026-08-26T00:00:00.000Z",
                contentHash: "a".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE run_id='${RUN_A}' AND provider_key='registry'
           AND external_id='safe-a' AND ingest_version='raw-source/v2';`,
      ),
      "1",
    );

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000001",
            externalId: "new-a",
            payload: {
              externalId: "new-a",
              name: "New A GmbH",
              domain: "new-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/new-a",
                fetchedAt: "2000-01-01T00:00:00.000Z",
                contentHash: "e".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000003",
            externalId: "future-a",
            payload: {
              externalId: "future-a",
              name: "Future A GmbH",
              domain: "future-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/future-a",
                fetchedAt: new Date().toISOString(),
                contentHash: "a".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_B,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000002",
            workspaceId: WORKSPACE_B,
            runId: RUN_A,
            externalId: "cross-run",
          }),
        ),
      ),
      { rejects: /RAW_SOURCE_WRITER_RUN_BINDING_INVALID|foreign key/u },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT workspace_id::text
           FROM list_due_raw_retention_workspaces_v1(10, NULL);`,
        ),
      ),
      `${WORKSPACE_A}\n${WORKSPACE_A}`,
    );
  });

  it("admits only the direct app principal through the canonical writer and derives immutable receipt facts", () => {
    const valid = writerCommand({
      recordId: "83000000-0000-4000-8000-000000000001",
      externalId: "writer-valid",
    });
    const firstReceipt = dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql(valid)),
    )
      .split("\n")
      .at(-1);
    const [firstId, firstHash, firstBytes, firstStatus, firstInserted] =
      firstReceipt.split("|");
    assert.equal(firstId, valid.recordId);
    assert.match(firstHash, /^[0-9a-f]{64}$/u);
    assert.ok(Number(firstBytes) > 0);
    assert.equal(firstStatus, "ACCEPTED");
    assert.equal(firstInserted, "true");
    assert.equal(
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(valid))),
      `${WORKSPACE_A}\n${valid.recordId}|${firstHash}|${firstBytes}|ACCEPTED|false`,
    );
    const timeoutScope = dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `SET LOCAL statement_timeout='23s';
         ${writerSql(valid)}
         SELECT current_setting('statement_timeout');`,
      ),
    );
    assert.equal(timeoutScope.split("\n").at(-1), "23s");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (payload_hash = '${firstHash}')::text,
           (payload_bytes = ${firstBytes})::text,
           source_policy_snapshot->>'id',
           source_policy_snapshot->>'domain',
           source_policy_snapshot->>'retentionDays',
           source_policy_snapshot->'allowedPurpose'->>0
         ) FROM raw_source_record WHERE id='${valid.recordId}';`,
      ),
      `true|true|${POLICY_A}|registry.example|30|discovery`,
    );

    dockerPsql(
      databases.upgrade,
      `INSERT INTO source_policy(
        id,domain,source_type,access_mode,robots_status,terms_status,
        personal_data,allowed_purpose,crawl_delay_ms,retention_days,
        review_status,owner,created_at,updated_at
      ) VALUES (
        '${POLICY_B}','other.example','gov_registry','api','ALLOWS',
        'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
      );`,
    );

    const mismatches = [
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000002",
          commandExternalId: "forged-external-id",
        }),
        /RAW_SOURCE_WRITER_EXTERNAL_BINDING_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000003",
          ingestKey: `external:${"5".repeat(64)}`,
        }),
        /RAW_SOURCE_WRITER_INGEST_KEY_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000004",
          sourcePolicyId: POLICY_B,
        }),
        /RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000005",
          providerKey: "missing-provider",
        }),
        /RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID/u,
      ],
    ];
    for (const [command, rejects] of mismatches) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id IN (
           '83000000-0000-4000-8000-000000000002',
           '83000000-0000-4000-8000-000000000003',
           '83000000-0000-4000-8000-000000000004',
           '83000000-0000-4000-8000-000000000005'
         );`,
      ),
      "0",
    );

    for (const deniedInvocation of [
      writerSql(valid),
      `SET SESSION AUTHORIZATION app_user; ${writerSql(valid)}`,
      `SET ROLE app_user;
       SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',false);
       ${writerSql(valid)}`,
    ]) {
      dockerPsql(databases.upgrade, deniedInvocation, {
        rejects: /RAW_SOURCE_WRITER_DENIED|permission denied/u,
      });
    }
  });

  it("persists real application-prepared rejected, quarantined, oversize, and drift receipts through the actual writer", () => {
    const suspendedPolicy = "a0000000-0000-4000-8000-000000000003";
    dockerPsql(
      databases.upgrade,
      `INSERT INTO source_policy(
        id,domain,source_type,access_mode,robots_status,terms_status,
        personal_data,allowed_purpose,crawl_delay_ms,retention_days,
        review_status,owner,created_at,updated_at
      ) VALUES (
        '${suspendedPolicy}','suspended.example','gov_registry','api','ALLOWS',
        'REVIEWED_OK',false,'["discovery"]',0,30,'SUSPENDED','backend',
        '2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z'
      );`,
    );

    const result = runApplicationWriterFixture(databases.upgrade);
    assert.equal(result.receipts.length, 8);
    assert.equal(result.rows.length, 8);
    assert.equal(result.applicationNameDecisions.length, 12);
    for (const decision of result.applicationNameDecisions) {
      assert.equal(decision.ingestStatus, "REJECTED", decision.label);
      assert.equal(
        decision.dispositionCode,
        decision.label === "malformed-type"
          ? "MALFORMED_PAYLOAD"
          : "PROVIDER_PAYLOAD_SCHEMA_INVALID",
        decision.label,
      );
    }
    assert.deepEqual(
      new Set(result.rows.map((row) => row.dispositionCode)),
      new Set([
        null,
        "UNKNOWN_PAYLOAD_FIELD",
        "SOURCE_POLICY_SUSPENDED",
        "PAYLOAD_TOO_LARGE",
        "PROCESSING_KEY_DRIFT",
      ]),
    );
    const acceptedNames = new Set([
      "Alice Van Smith",
      "Johnson Controls",
      "Parker Hannifin",
      "General Dynamics",
    ]);
    for (const row of result.rows) {
      if (row.ingestStatus === "ACCEPTED") {
        assert.equal(row.dispositionCode, null);
        assert.equal(acceptedNames.delete(row.payload.name), true);
        continue;
      }
      assert.notEqual(row.ingestStatus, "ACCEPTED");
      assert.equal(row.ingestKey, `payload:${row.payloadHash}`);
      assert.equal(row.payload.reason, row.dispositionCode);
      assert.match(row.payload.originalPayloadHash, /^[0-9a-f]{64}$/u);
      assert.ok(Number.isSafeInteger(row.payload.originalPayloadBytes));
      assert.ok(row.payload.originalPayloadBytes >= 0);
      const expectedKeys = [
        "_rawReceipt",
        "originalPayloadBytes",
        "originalPayloadHash",
        "reason",
        ...(row.dispositionCode === "PROCESSING_KEY_DRIFT"
          ? ["conflictWithRawId"]
          : []),
      ].sort();
      assert.deepEqual(Object.keys(row.payload).sort(), expectedKeys);
    }
    assert.equal(acceptedNames.size, 0);
  });

  it("accepts only exact closed non-ACCEPTED receipts and denies them for owner, unset app, and SET ROLE", () => {
    const validRejected = nonAcceptedWriterCommand({
      recordId: "83500000-0000-4000-8000-000000000001",
      status: "REJECTED",
      reason: "UNKNOWN_PAYLOAD_FIELD",
    });
    const validQuarantined = nonAcceptedWriterCommand({
      recordId: "83500000-0000-4000-8000-000000000002",
      status: "QUARANTINED",
      reason: "PROCESSING_KEY_DRIFT",
      conflictWithRawId: "83000000-0000-4000-8000-000000000001",
    });
    for (const command of [validRejected, validQuarantined]) {
      const receipt = dockerPsql(
        databases.upgrade,
        asApp(WORKSPACE_A, writerSql(command)),
      )
        .split("\n")
        .at(-1);
      assert.match(receipt, /\|(REJECTED|QUARANTINED)\|true$/u);
    }

    const hostile = [
      nonAcceptedWriterCommand({
        recordId: "83500000-0000-4000-8000-000000000003",
        status: "REJECTED",
        reason: "UNKNOWN_PAYLOAD_FIELD",
        payloadOverrides: { email: "person@example.test" },
      }),
      nonAcceptedWriterCommand({
        recordId: "83500000-0000-4000-8000-000000000004",
        status: "REJECTED",
        reason: "ARBITRARY_REASON",
      }),
      nonAcceptedWriterCommand({
        recordId: "83500000-0000-4000-8000-000000000005",
        status: "QUARANTINED",
        reason: "SOURCE_POLICY_MISSING",
        conflictWithRawId: "person@example.test",
      }),
      nonAcceptedWriterCommand({
        recordId: "83500000-0000-4000-8000-000000000006",
        status: "REJECTED",
        reason: "UNKNOWN_PAYLOAD_FIELD",
        originalPayloadHash: "SECRET",
      }),
      nonAcceptedWriterCommand({
        recordId: "83500000-0000-4000-8000-000000000007",
        status: "QUARANTINED",
        reason: "PAYLOAD_TOO_LARGE",
        originalPayloadBytes: null,
      }),
    ];
    hostile.push({ ...validRejected, contentHash: "SECRET" });
    hostile.push({ ...validRejected, parserVersion: true });
    for (const command of hostile) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects:
          /RAW_SOURCE_WRITER_(COMMAND_INVALID|RECEIPT_INVALID|PROVENANCE_BINDING_INVALID)/u,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id::text LIKE '83500000-0000-4000-8000-%';`,
      ),
      "2",
    );

    const denied = nonAcceptedWriterCommand({
      recordId: "83500000-0000-4000-8000-000000000008",
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
    for (const invocation of [
      writerSql(denied),
      `SET SESSION AUTHORIZATION app_user; ${writerSql(denied)}`,
      `SET ROLE app_user;
       SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',false);
       ${writerSql(denied)}`,
    ]) {
      dockerPsql(databases.upgrade, invocation, {
        rejects: /RAW_SOURCE_WRITER_DENIED|permission denied/u,
      });
    }
  });

  it("requires the forward-only TED identifier contact gate migration", () => {
    assert.equal(
      existsSync(tedIdentifierContactGateMigrationPath),
      true,
      `${tedIdentifierContactGateMigrationName} must exist`,
    );
  });

  it("rejects TED local-phone winner identifiers before the real writer persists Raw and preserves valid equality", () => {
    const hostile = [
      ["85500000-0000-4000-8000-000000000001", "1", "Call 555-0100", false],
      ["85500000-0000-4000-8000-000000000002", "2", "Call 555-0100", true],
      ["85500000-0000-4000-8000-000000000003", "3", "Call ٥٥٥-٠١٠٠", false],
      ["85500000-0000-4000-8000-000000000004", "4", "Call ٥٥٥-٠١٠٠", true],
    ];
    for (const [
      recordId,
      publicationNumber,
      winnerIdentifier,
      withIdentifier,
    ] of hostile) {
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          writerSql(
            tedWriterCommand({
              recordId,
              publicationNumber,
              winnerIdentifier,
              withIdentifier,
            }),
          ),
        ),
        { rejects: /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u },
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id::text LIKE '85500000-0000-4000-8000-%';`,
      ),
      "0",
    );

    for (const [recordId, publicationNumber, withIdentifier] of [
      ["85600000-0000-4000-8000-000000000005", "5", false],
      ["85600000-0000-4000-8000-000000000006", "6", true],
    ]) {
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          writerSql(
            tedWriterCommand({
              recordId,
              publicationNumber,
              winnerIdentifier: "DE111",
              withIdentifier,
            }),
          ),
        ),
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT string_agg(concat_ws('|',id::text,
          payload #>> '{attributes,ted,winner_identifier}',
          coalesce(payload #>> '{identifier,value}','NO_ID')
        ),E'\n' ORDER BY id)
        FROM raw_source_record
        WHERE id::text LIKE '85600000-0000-4000-8000-%';`,
      ),
      [
        "85600000-0000-4000-8000-000000000005|DE111|NO_ID",
        "85600000-0000-4000-8000-000000000006|DE111|DE111",
      ].join("\n"),
    );
  });

  it("denies hostile app_user payload forgery, unbounded JSON, and immutable cost drift", () => {
    const base = writerCommand({
      recordId: "84000000-0000-4000-8000-000000000001",
      externalId: "hostile-base",
    });
    const overDeep = structuredClone(base.payload);
    let cursor = overDeep.attributes;
    for (let depth = 0; depth < 8; depth += 1) {
      cursor.nested = {};
      cursor = cursor.nested;
    }
    const tooManyNodes = structuredClone(base.payload);
    tooManyNodes.attributes.products = Array.from(
      { length: 300 },
      (_, index) => `pump-${index}`,
    );
    const hostile = [
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000002",
          payload: { ...base.payload, secret_extension: "arbitrary object" },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000003",
          externalId: "555-0100",
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000004",
          payload: {
            ...base.payload,
            identifier: { scheme: "registry-id", value: "555-0100" },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000005",
          payload: {
            ...base.payload,
            name: "Bearer secret",
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000006",
          payload: {
            ...base.payload,
            provenance: {
              ...base.payload.provenance,
              sourceUrl: "https://registry.example/company/555-0100",
            },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000007",
          payload: {
            ...base.payload,
            provenance: {
              ...base.payload.provenance,
              sourceUrl: "https://registry.example/api%25255Fkey%25253Dsecret",
            },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000008",
          payload: {
            ...base.payload,
            name: `Acme ${"x".repeat(4 * 1024 * 1024)}`,
          },
        }),
        /RAW_SOURCE_WRITER_COMMAND_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000009",
          payload: overDeep,
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000010",
          payload: tooManyNodes,
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000011",
          payload: {
            ...base.payload,
            identifier: { scheme: "fda-reg", value: "3004512345" },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
    ];
    for (const [command, rejects] of hostile) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects,
      });
    }
    const oversizedUnusedV1 = {
      ...base,
      schemaVersion: "raw-source-writer/v1",
      expectedPayloadHash: "x".repeat(4 * 1024 * 1024),
      expectedPayloadBytes: 1,
    };
    dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql(oversizedUnusedV1)),
      { rejects: /RAW_SOURCE_WRITER_COMMAND_BOUNDS/u },
    );
    for (const malformedV1 of [
      {
        ...base,
        schemaVersion: "raw-source-writer/v1",
        expectedPayloadHash: null,
        expectedPayloadBytes: 1,
      },
      {
        ...base,
        schemaVersion: "raw-source-writer/v1",
        expectedPayloadHash: "a".repeat(64),
        expectedPayloadBytes: true,
      },
    ]) {
      dockerPsql(
        databases.upgrade,
        asApp(WORKSPACE_A, writerSql(malformedV1)),
        {
          rejects: /RAW_SOURCE_WRITER_COMMAND_INVALID/u,
        },
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id::text LIKE '84000000-0000-4000-8000-%';`,
      ),
      "0",
    );

    const immutable = writerCommand({
      recordId: "84000000-0000-4000-8000-000000000012",
      externalId: "immutable-cost",
      costCents: 0,
    });
    dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(immutable)));
    dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql({ ...immutable, costCents: 1 })),
      { rejects: /RAW_SOURCE_WRITER_DRIFT/u },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT cost_cents FROM raw_source_record WHERE id='${immutable.recordId}';`,
      ),
      "0",
    );
  });

  it("requires an explicit discovery purpose and stores the effective purpose in the immutable snapshot", () => {
    const purposePolicies = [
      ["b0000000-0000-4000-8000-000000000001", "purpose-null.example", null],
      ["b0000000-0000-4000-8000-000000000002", "purpose-empty.example", []],
      [
        "b0000000-0000-4000-8000-000000000003",
        "purpose-malformed.example",
        "discovery",
      ],
      [
        "b0000000-0000-4000-8000-000000000004",
        "purpose-other.example",
        ["enrichment"],
      ],
      [
        "b0000000-0000-4000-8000-000000000005",
        "purpose-mixed.example",
        ["discovery", 42],
      ],
    ];
    for (const [id, domain, allowedPurpose] of purposePolicies) {
      const encodedPurpose =
        allowedPurpose === null
          ? "NULL"
          : `'${JSON.stringify(allowedPurpose)}'::jsonb`;
      dockerPsql(
        databases.upgrade,
        `INSERT INTO source_policy(
          id,domain,source_type,access_mode,robots_status,terms_status,
          personal_data,allowed_purpose,crawl_delay_ms,retention_days,
          review_status,owner,created_at,updated_at
        ) VALUES (
          '${id}','${domain}','gov_registry','api','ALLOWS','REVIEWED_OK',
          false,${encodedPurpose},0,30,'APPROVED','backend',now(),now()
        );`,
      );
      const externalId = `purpose-${id.slice(-1)}`;
      const command = writerCommand({
        recordId: `85000000-0000-4000-8000-00000000000${id.slice(-1)}`,
        externalId,
        sourcePolicyId: id,
        payload: {
          externalId,
          name: "Purpose Test GmbH",
          domain: "purpose-test.example",
          attributes: { products: ["pump"] },
          provenance: {
            sourceUrl: `https://${domain}/company`,
            fetchedAt: "2026-08-26T00:00:00.000Z",
            contentHash: "a".repeat(64),
            parserVersion: "registry/v2",
          },
        },
      });
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects: /RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u,
      });
    }
  });

  it("persists PostgreSQL-authoritative digest and bytes for a real 1e-7 JSONB number", () => {
    const numericPolicy = "b0000000-0000-4000-8000-000000000010";
    dockerPsql(
      databases.upgrade,
      `INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
         VALUES (gen_random_uuid(),'public_web','public_intelligence','ENABLED',0,now());
       INSERT INTO source_policy(
         id,domain,source_type,access_mode,robots_status,terms_status,
         personal_data,allowed_purpose,crawl_delay_ms,retention_days,
         review_status,owner,created_at,updated_at
       ) VALUES (
         '${numericPolicy}','numeric.example','official_website','crawl',
         'ALLOWS','REVIEWED_OK',false,'["discovery"]',0,30,
         'APPROVED','backend',now(),now()
       );`,
    );
    const numeric = writerCommand({
      recordId: "86000000-0000-4000-8000-000000000001",
      runId: RUN_A,
      providerKey: "public_web",
      sourceClass: "public_intelligence",
      sourcePolicyId: numericPolicy,
      payload: {
        externalId: "numeric.example",
        name: "General Dynamics",
        domain: "numeric.example",
        attributes: {
          products: ["industrial pump"],
          keywords: ["industrial"],
          extraction_evidence_digest: "f".repeat(64),
          extraction_confidence: 1e-7,
          source_class: "public_intelligence",
        },
        provenance: {
          sourceUrl: "https://numeric.example/company",
          fetchedAt: "2026-08-26T00:00:00.000Z",
          contentHash: "e".repeat(64),
          parserVersion: "public-web/v1",
        },
      },
    });
    const receipt = dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql(numeric)),
    )
      .split("\n")
      .at(-1)
      .split("|");
    assert.equal(receipt[0], numeric.recordId);
    assert.match(receipt[1], /^[0-9a-f]{64}$/u);
    assert.ok(Number(receipt[2]) > 0);
    assert.equal(receipt[3], "ACCEPTED");
    assert.equal(receipt[4], "true");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (payload_hash='${receipt[1]}')::text,
           (payload_bytes=${receipt[2]})::text,
           payload #>> '{attributes,extraction_confidence}'
         ) FROM raw_source_record WHERE id='${numeric.recordId}';`,
      ),
      "true|true|0.0000001",
    );
  });

  it("prevents provenance rewrites and physical delete while allowing one-way minimal expiry", () => {
    for (const mutation of [
      "provider_key='rewritten'",
      `run_id='${RUN_B}'`,
      `source_entity_id='${SOURCE_ENTITY}'`,
      `payload_hash='${"1".repeat(64)}'`,
      `ingest_key='external:${"2".repeat(64)}'`,
      "ingest_version='raw-source/v999'",
      "created_at=created_at + interval '1 second'",
    ]) {
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `UPDATE raw_source_record SET ${mutation}
           WHERE id='80000000-0000-4000-8000-000000000001';`,
        ),
        { rejects: /immutable|permission denied|raw-source\/v2/u },
      );
    }
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `UPDATE raw_source_record
         SET payload=jsonb_build_object(
             '_rawReceipt','raw-source/expired/v1',
             'previousStatus',ingest_status,
             'payloadHash',payload_hash,
             'payloadBytes',payload_bytes
           ), ingest_status='EXPIRED', expired_at=statement_timestamp()
         WHERE id='80000000-0000-4000-8000-000000000003';`,
      ),
      { rejects: /permission denied/u },
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      DELETE FROM raw_source_record
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /permission denied|physical deletion/u },
    );
    dockerPsql(
      databases.upgrade,
      `DELETE FROM raw_source_record
       WHERE id='80000000-0000-4000-8000-000000000001';`,
      { rejects: /physical deletion/u },
    );

    const expiredOutput = dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      SELECT 'result:' || row_to_json(x)::text
      FROM expire_due_raw_source_records_v1(
        '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz
      ) x;
      SELECT 'row:' || jsonb_build_object(
          'status',ingest_status,'expiredAt',expired_at,'payload',payload,
          'payloadHash',payload_hash,'payloadBytes',payload_bytes
        )::text
      FROM raw_source_record WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
    );
    const outputLines = expiredOutput.split("\n");
    const resultLine = outputLines.find((line) => line.startsWith("result:"));
    const rowLine = outputLines.find((line) => line.startsWith("row:"));
    assert.ok(resultLine, expiredOutput);
    assert.ok(rowLine, expiredOutput);
    const result = JSON.parse(resultLine.slice("result:".length));
    const expired = JSON.parse(rowLine.slice("row:".length));
    assert.equal(result.expired, 1);
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.payload._rawReceipt, "raw-source/expired/v1");
    assert.deepEqual(Object.keys(expired.payload).sort(), [
      "_rawReceipt",
      "payloadBytes",
      "payloadHash",
      "previousStatus",
    ]);
    assert.equal(expired.payload.payloadHash, expired.payloadHash);
    assert.equal(expired.payload.payloadBytes, expired.payloadBytes);
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT ingest_status || '|' || (expired_at IS NULL)::text
         FROM raw_source_record
         WHERE id='80000000-0000-4000-8000-000000000003';`,
      ),
      "ACCEPTED|true",
    );

    for (const deniedInvocation of [
      `SELECT * FROM expire_due_raw_source_records_v1(
        '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
      `SET SESSION AUTHORIZATION app_user;
       SELECT * FROM expire_due_raw_source_records_v1(
         '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
      `SET ROLE app_user;
       SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',false);
       SELECT * FROM expire_due_raw_source_records_v1(
         '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
    ]) {
      dockerPsql(databases.upgrade, deniedInvocation, {
        rejects: /RAW_RETENTION_EXPIRE_DENIED|permission denied/u,
      });
    }

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      UPDATE raw_source_record SET ingest_status='ACCEPTED'
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /immutable|one-way|permission denied/u },
    );
  });

  it("hides restricted Raw and rejects every explicit downstream identity/evidence write", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${RESTRICTED_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_A}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT concat_ws('|',
             (SELECT count(*) FROM identity_link
               WHERE raw_record_id='${RESTRICTED_RAW_A}'),
             (SELECT count(*) FROM field_evidence
               WHERE raw_record_id='${RESTRICTED_RAW_A}')
           );`,
        ),
      ),
      `${WORKSPACE_A}\n0|0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (SELECT count(*) FROM identity_link
             WHERE raw_record_id='${RESTRICTED_RAW_A}'),
           (SELECT count(*) FROM field_evidence
             WHERE raw_record_id='${RESTRICTED_RAW_A}')
         );`,
      ),
      "1|3",
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,created_at
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}',
        '${RESTRICTED_RAW_A}','domain_exact',1,now()
      );
    `,
      ),
      { rejects: /restricted from downstream processing|row-level security/u },
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      INSERT INTO field_evidence(
        id,workspace_id,entity_type,entity_id,field,value,provider_key,raw_record_id,
        confidence,license,allowed_actions,data_class,fetched_at
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','name','"Unsafe A"',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','green',now()
      );
    `,
      ),
      { rejects: /restricted from downstream processing|row-level security/u },
    );
  });

  it("reports real SKIP LOCKED deferral and expires the row on the next run", async () => {
    const lock = openRowLock(databases.locks, LOCKED_RAW);
    await lock.ready;
    try {
      assert.equal(
        dockerPsql(
          databases.locks,
          asApp(
            WORKSPACE_A,
            `SELECT expired || '|' || deferred_for_conflict || '|' || has_more
             FROM expire_due_raw_source_records_v1(
               '${WORKSPACE_A}'::uuid,1,NULL
             );`,
          ),
        ),
        `${WORKSPACE_A}\n0|1|true`,
      );
    } finally {
      await lock.release();
    }

    assert.equal(
      dockerPsql(
        databases.locks,
        asApp(
          WORKSPACE_A,
          `SELECT expired || '|' || deferred_for_conflict || '|' || has_more
           FROM expire_due_raw_source_records_v1(
             '${WORKSPACE_A}'::uuid,1,NULL
           );`,
        ),
      ),
      `${WORKSPACE_A}\n1|0|false`,
    );
    assert.equal(
      dockerPsql(
        databases.locks,
        `SELECT ingest_status FROM raw_source_record WHERE id='${LOCKED_RAW}';`,
      ),
      "EXPIRED",
    );
  });

  it("rolls back post-backfill DML and every validation when the integrity gate fails before COMMIT", () => {
    assert.match(injectedBackfillRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.backfillRollback,
        `SELECT concat_ws('|',
           (SELECT (last_seen_fetch_id IS NULL)::text FROM source_entity
             WHERE id='${SOURCE_ENTITY}'),
           (SELECT count(*) FROM raw_source_record
             WHERE source_entity_id='${SOURCE_ENTITY}'),
           (SELECT (payload_hash IS NULL)::text FROM raw_source_record
             WHERE id='${RESTRICTED_RAW_A}'),
           (SELECT count(*) FROM raw_source_governance_disposition),
           (SELECT raw_record_id::text FROM identity_link
             WHERE canonical_id='${COMPANY_A}' AND match_rule='domain_exact'),
           (SELECT raw_record_id::text FROM field_evidence
             WHERE entity_id='${COMPANY_A}' AND field='name')
         );`,
      ),
      `true|0|true|0|${SOURCE_ENTITY}|${SOURCE_ENTITY}`,
    );
    assert.equal(
      dockerPsql(
        databases.backfillRollback,
        `SELECT count(*)
         FROM pg_constraint
         WHERE conname IN (
           'raw_source_record_exactly_one_origin_check',
           'raw_source_record_ingest_status_check',
           'raw_source_record_v2_receipt_check',
           'raw_source_record_source_entity_id_fkey',
           'raw_source_record_workspace_run_fkey',
           'source_entity_last_seen_fetch_id_fkey',
           'source_entity_last_seen_fetch_fkey',
           'identity_link_workspace_raw_fkey',
           'field_evidence_workspace_raw_fkey'
         ) AND NOT convalidated;`,
      ),
      "9",
    );
  });

  it("rolls back the complete schema migration when a failure is injected before commit", () => {
    assert.match(injectedRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='raw_source_record'
        AND column_name='ingest_version';
    `,
      ),
      "0",
    );
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT to_regclass('public.raw_source_governance_disposition') IS NULL;
    `,
      ),
      "t",
    );
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name='${schemaMigrationName}';
    `,
      ),
      "0",
    );
  });

  it("rolls back writer functions and the INSERT revoke when 1200 fails before commit", () => {
    assert.match(injectedWriterRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.writerRollback,
        `SELECT concat_ws('|',
          (to_regprocedure('write_raw_source_record_v2(jsonb)') IS NULL)::text,
          (to_regprocedure('raw_source_canonical_json_v1(jsonb)') IS NULL)::text,
          has_table_privilege('app_user','raw_source_record','INSERT')::text
        );`,
      ),
      "true|true|true",
    );
  });

  it("rolls back every 1300 writer hardening definition when failure is injected before COMMIT", () => {
    assert.match(injectedWriterHardeningRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.writerHardeningRollback,
        `SELECT concat_ws('|',
          (to_regprocedure('raw_source_provider_payload_valid_v2(text,jsonb)') IS NULL)::text,
          (to_regprocedure('sanitize_canonical_company_attributes_v2(jsonb)') IS NULL)::text,
          (position('raw-source-writer/v1' in pg_get_functiondef(
            'write_raw_source_record_v2(jsonb)'::regprocedure
          )) > 0)::text,
          has_table_privilege('app_user','raw_source_record','INSERT')::text
        );`,
      ),
      "true|true|true|false",
    );
  });

  it("rolls back all 1400 historical cleanup DML without deleting evidence", () => {
    assert.match(injectedHistoricalCleanupRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.historicalCleanupRollback,
        `SELECT concat_ws('|',
          (attributes ? 'contact_email')::text,
          (attributes ? 'custom_payload')::text,
          (attributes::text LIKE '%person@example.test%')::text,
          (SELECT count(*) FROM field_evidence WHERE entity_id='${COMPANY_A}'),
          (SELECT count(*) FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND value::text LIKE '%person@example.test%')
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      "true|true|true|8|3",
    );
  });

  it("rolls back all 1500 writer, sanitizer, and historical status hardening before COMMIT", () => {
    assert.match(injectedStatusHardeningRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.statusHardeningRollback,
        `SELECT concat_ws('|',
          (attributes::text LIKE '%SECRET%')::text,
          (sanitize_canonical_company_attributes_v2(
            '{"products":["pump","LLZ","SECRET"]}'::jsonb
          )::text LIKE '%SECRET%')::text,
          (position('set_config(''statement_timeout''' in pg_get_functiondef(
            'write_raw_source_record_v2(jsonb)'::regprocedure
          )) > 0)::text
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      "true|true|true",
    );
    assert.deepEqual(
      JSON.parse(readMinimal1500Company(databases.statusHardeningRollback)),
      {
        attributes: { products: ["pump", "AB"] },
        version: 7,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    );
  });

  it("rolls back all 1600 helper and ACL definitions before COMMIT", () => {
    assert.match(injectedFinalCorrectionRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.finalCorrectionRollback,
        `SELECT concat_ws('|',
          version::text,
          (attributes #> '{digital_footprint,structured_org}' = '{}'::jsonb)::text,
          (SELECT count(*) FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND value::text LIKE '%LLZ1%'),
          raw_source_provider_payload_valid_v2(
            'registry',
            '{"externalId":"rollback-alice","name":"Alice Van Smith","attributes":{"products":["pump"]},"provenance":{"sourceUrl":"https://registry.example/company/rollback-alice","fetchedAt":"2026-08-26T00:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v2"}}'::jsonb
          )::text,
          (to_regprocedure(
            'raw_source_sanitize_field_evidence_plain_v5(text,jsonb)'
          ) IS NULL)::text,
          (to_regprocedure(
            'raw_source_cleanup_receipt_v2_shape_valid_v1(jsonb)'
          ) IS NULL)::text
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      "2|true|2|false|true|true",
    );
  });

  it("rolls back the 1700 company-name parity definition before COMMIT", () => {
    assert.match(injectedWriterParityRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.writerParityRollback,
        `SELECT concat_ws('|',
          raw_source_provider_company_name_valid_v2(
            'Alice Van Smith '
          )::text,
          has_function_privilege(
            'app_user',
            'raw_source_provider_company_name_valid_v2(text)',
            'EXECUTE'
          )::text,
          raw_source_provider_payload_valid_v2(
            'registry',
            '{"externalId":"rollback-alice","name":"Alice Van Smith","attributes":{"products":["pump"]},"provenance":{"sourceUrl":"https://registry.example/company/rollback-alice","fetchedAt":"2026-08-26T00:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v2"}}'::jsonb
          )::text
        );`,
      ),
      "true|false|true",
    );
  });

  it("rolls back all 1800 historical evidence-chain DML before COMMIT", () => {
    assert.match(injectedEvidenceChainRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.evidenceChainRollback,
        `SELECT concat_ws('|',
          value->>'_historicalCleanup',
          value->>'originalValueHash',
          (NOT value ? 'predecessorReceiptHash')::text,
          ((value #> '{retainedValue,products}') ? 'AB')::text,
          data_class,
          allowed_actions::text,
          (SELECT count(*)::text FROM field_evidence
            WHERE entity_id='${COMPANY_A}'),
          (SELECT version::text FROM canonical_company
            WHERE id='${COMPANY_A}'),
          (SELECT attributes #> '{digital_footprint,structured_org}' = '{}'::jsonb
            FROM canonical_company WHERE id='${COMPANY_A}')::text,
          (SELECT count(*)::text FROM field_evidence
            WHERE entity_id='${COMPANY_A}'
              AND value::text LIKE '%LLZ1%')
        ) FROM field_evidence
        WHERE entity_id='${COMPANY_A}'
          AND raw_record_id='${EVIDENCE_CHAIN_RAW_A}';`,
      ),
      [
        "canonical-attribute-cleanup/v1",
        EVIDENCE_CHAIN_ORIGINAL_VALUE_HASH,
        "true",
        "true",
        "red",
        "[]",
        "8",
        "2",
        "true",
        "2",
      ].join("|"),
    );
  });

  it("keeps 1900/2100/2300/2500 DDL-ACL-only and 2000/2200/2400 historical correction DML-only", () => {
    const pathDdl = readFileSync(pathSanitizerMigrationPath, "utf8");
    const pathDml = readFileSync(pathCleanupMigrationPath, "utf8");
    const storedDdl = readFileSync(storedFieldAdapterMigrationPath, "utf8");
    const storedDml = readFileSync(storedFieldCleanupMigrationPath, "utf8");
    const siteSectionDdl = readFileSync(
      siteSectionContractMigrationPath,
      "utf8",
    );
    const siteSectionDml = readFileSync(
      siteSectionCleanupMigrationPath,
      "utf8",
    );
    const tedIdentifierDdl = readFileSync(
      tedIdentifierContactGateMigrationPath,
      "utf8",
    );

    assert.match(pathDdl, /CREATE (?:OR REPLACE )?FUNCTION/u);
    assert.match(pathDdl, /REVOKE ALL ON FUNCTION/u);
    assert.doesNotMatch(
      pathDdl,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:canonical_company|field_evidence)\b/iu,
    );
    assert.match(pathDml, /\bUPDATE\s+canonical_company\b/iu);
    assert.match(pathDml, /\bUPDATE\s+field_evidence\b/iu);
    assert.doesNotMatch(
      pathDml,
      /\b(?:CREATE|ALTER|DROP)\s+(?:FUNCTION|TABLE|INDEX|TYPE|POLICY|TRIGGER|CONSTRAINT)\b|\b(?:GRANT|REVOKE)\b/iu,
    );
    assert.match(
      storedDdl,
      /CREATE TABLE raw_source_field_evidence_cleanup_audit/u,
    );
    assert.match(storedDdl, /CREATE (?:OR REPLACE )?FUNCTION/u);
    assert.match(storedDdl, /ENABLE ROW LEVEL SECURITY/u);
    assert.match(storedDdl, /FORCE ROW LEVEL SECURITY/u);
    assert.match(storedDdl, /REVOKE/u);
    assert.doesNotMatch(
      storedDdl,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:canonical_company|field_evidence)\b/iu,
    );
    assert.match(storedDml, /\bUPDATE\s+field_evidence\b/iu);
    assert.match(
      storedDml,
      /\bINSERT\s+INTO\s+raw_source_field_evidence_cleanup_audit\b/iu,
    );
    assert.doesNotMatch(
      storedDml,
      /\b(?:CREATE|ALTER|DROP)\s+(?:FUNCTION|TABLE|INDEX|TYPE|POLICY|TRIGGER|CONSTRAINT)\b|\b(?:GRANT|REVOKE)\b/iu,
    );
    assert.match(siteSectionDdl, /CREATE (?:OR REPLACE )?FUNCTION/u);
    assert.match(siteSectionDdl, /ALTER TABLE/u);
    assert.match(siteSectionDdl, /REVOKE ALL ON FUNCTION/u);
    assert.doesNotMatch(
      siteSectionDdl,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:canonical_company|field_evidence|raw_source_field_evidence_cleanup_audit)\b/iu,
    );
    assert.match(siteSectionDml, /\bUPDATE\s+field_evidence\b/iu);
    assert.match(
      siteSectionDml,
      /\bINSERT\s+INTO\s+raw_source_field_evidence_cleanup_audit\b/iu,
    );
    assert.doesNotMatch(
      siteSectionDml,
      /\b(?:CREATE|ALTER|DROP)\s+(?:FUNCTION|TABLE|INDEX|TYPE|POLICY|TRIGGER|CONSTRAINT)\b|\b(?:GRANT|REVOKE)\b/iu,
    );
    assert.match(tedIdentifierDdl, /CREATE OR REPLACE FUNCTION/u);
    assert.match(tedIdentifierDdl, /REVOKE ALL ON FUNCTION/u);
    assert.doesNotMatch(
      tedIdentifierDdl,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:raw_source_record|canonical_company|field_evidence)\b/iu,
    );
  });

  it("rolls back every 1900 path-sanitizer definition and ACL change", () => {
    assert.match(injectedPathSanitizerRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.pathSanitizerRollback,
        `SELECT concat_ws('|',
          (to_regprocedure(
            'raw_source_semantic_identifier_valid_v1(text[],text)'
          ) IS NULL)::text,
          (to_regprocedure(
            'raw_source_sanitize_derived_json_v4(jsonb,text[],integer)'
          ) IS NULL)::text,
          (sanitize_canonical_company_attributes_v3(
            '{"digital_footprint":{"source":"Call 555-0100"}}'::jsonb
          ) #>> '{digital_footprint,source}' = 'Call 555-0100')::text
        );`,
      ),
      "true|true|true",
    );
  });

  it("rolls back all 2000 Canonical and FieldEvidence correction bytes", () => {
    assert.match(injectedPathCleanupRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.pathCleanupRollback,
        `SELECT concat_ws('|',
          version::text,
          (attributes #>> '{digital_footprint,source}' =
            'Call 555-0100')::text,
          (SELECT value #>> '{source}' = 'Call 555-0100'
             FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND field='digital_footprint'
               AND provider_key='registry_path_collision')::text,
          (SELECT data_class
             FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND field='digital_footprint'
               AND provider_key='registry_path_collision'),
          (SELECT allowed_actions::text
             FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND field='digital_footprint'
               AND provider_key='registry_path_collision'),
          (SELECT count(*)::text FROM field_evidence
             WHERE entity_id='${COMPANY_A}')
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      '3|true|true|green|["display", "match"]|10',
    );
  });

  it("rolls back every 2100 adapter, audit-table, RLS and ACL definition", () => {
    assert.match(injectedStoredFieldAdapterRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.storedFieldAdapterRollback,
        `SELECT concat_ws('|',
          (to_regclass('raw_source_field_evidence_cleanup_audit') IS NULL)::text,
          (to_regprocedure(
            'raw_source_sanitize_stored_company_field_evidence_v1(text,jsonb)'
          ) IS NULL)::text,
          (to_regprocedure(
            'raw_source_current_stored_field_candidate_v1(text,text,jsonb)'
          ) IS NULL)::text
        );`,
      ),
      "true|true|true",
    );
  });

  it("rolls back every 2200 evidence correction and value-free audit insert", () => {
    assert.match(injectedStoredFieldCleanupRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.storedFieldCleanupRollback,
        `SELECT concat_ws('|',
          (SELECT value->>'_historicalCleanup' FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000101'),
          (SELECT data_class FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000101'),
          (SELECT allowed_actions::text FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000101'),
          (SELECT value #>> '{}' FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000106'),
          (SELECT data_class FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000106'),
          (SELECT count(*) FROM raw_source_field_evidence_cleanup_audit)
        );`,
      ),
      "canonical-attribute-cleanup/v2|red|[]|Call 555-0100 person@example.test Bearer secret|green|0",
    );
  });

  it("rolls back every 2300 helper, audit constraint and ACL replacement", () => {
    assert.match(
      injectedSiteSectionContractRollbackOutput,
      /division by zero/u,
    );
    assert.equal(
      dockerPsql(
        databases.siteSectionContractRollback,
        `SELECT concat_ws('|',
          (to_regprocedure(
            'raw_source_site_section_key_valid_v1(text)'
          ) IS NULL)::text,
          (to_regprocedure(
            'raw_source_sanitize_site_sections_v1(jsonb)'
          ) IS NULL)::text,
          (to_regprocedure(
            'raw_source_site_section_cleanup_receipt_shape_valid_v1(jsonb)'
          ) IS NULL)::text,
          (raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.site_sections',
            '{"source":1,".well-known":1}'::jsonb
          ) ? 'source')::text,
          (NOT raw_source_sanitize_stored_company_field_evidence_v1(
            'structured_harvest.site_sections',
            '{"source":1,".well-known":1}'::jsonb
          ) ? '.well-known')::text,
          (SELECT count(*) FROM pg_constraint
           WHERE conrelid='raw_source_field_evidence_cleanup_audit'::regclass
             AND conname IN (
               'raw_source_field_evidence_cleanup_audit_contract_check',
               'raw_source_field_evidence_cleanup_audit_adapter_check'
             ))::text
        );`,
      ),
      "true|true|true|true|true|2",
    );
  });

  it("rolls back every 2400 evidence correction and site-section audit insert", () => {
    assert.match(injectedSiteSectionCleanupRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.siteSectionCleanupRollback,
        `SELECT concat_ws('|',
          (SELECT value ? '555-0100' FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000207')::text,
          (SELECT data_class FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000207'),
          (SELECT allowed_actions::text FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000207'),
          (SELECT value->>'_historicalCleanup' FROM field_evidence
            WHERE id='81000000-0000-4000-8000-000000000202'),
          (SELECT count(*) FROM raw_source_field_evidence_cleanup_audit
            WHERE cleanup_contract='raw-source-site-section-cleanup/v1')
        );`,
      ),
      'true|green|["display", "match"]|stored-field-evidence-cleanup/v1|0',
    );
  });

  it("rolls back every 2500 TED identifier predicate and ACL replacement", () => {
    assert.match(
      injectedTedIdentifierContactGateRollbackOutput,
      /division by zero/u,
    );
    assert.equal(
      dockerPsql(
        databases.tedIdentifierContactGateRollback,
        `SELECT concat_ws('|',
          raw_source_identifier_valid_v2(
            'ted','{"scheme":"ted-natid:de","value":"Call 555-0100"}'::jsonb
          )::text,
          raw_source_provider_payload_valid_v2(
            'ted','{"externalId":"ted:1:0","name":"Johnson Controls","country":"DE","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"Call 555-0100"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://api.ted.europa.eu/v3/notices/search","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"ted/v1"}}'::jsonb
          )::text,
          raw_source_provider_payload_valid_v2(
            'ted','{"externalId":"ted:2:0","name":"Johnson Controls","country":"DE","identifier":{"scheme":"ted-natid:de","value":"Call ٥٥٥-٠١٠٠"},"attributes":{"ted":{"publication_number":"2","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"Call ٥٥٥-٠١٠٠"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://api.ted.europa.eu/v3/notices/search","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"ted/v1"}}'::jsonb
          )::text,
          has_function_privilege(
            'app_user','raw_source_identifier_valid_v2(text,jsonb)','EXECUTE'
          )::text
        );`,
      ),
      "true|true|true|false",
    );
  });
});
