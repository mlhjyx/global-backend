import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const container = "codex-task6b-identity-authority-pg-20260830-a";
const database = "postgres";
const port = "55441";
const network = "codex-task6b-identity-authority-net-20260830-a";
const volume =
  "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1";
const containerId =
  "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915";
const networkId =
  "14e022a6f17fd723013d2f73ba879927df097c2c3d383adee3381adda689153a";
const migrationChecksums = Object.freeze([
  [
    "20260829090000_organization_identity_v2_expand_ddl",
    "2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119",
  ],
  [
    "20260829091000_organization_identity_v2_legacy_link_backfill_dml",
    "d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426",
  ],
  [
    "20260829092000_organization_identity_v2_contract_ddl",
    "1d8368c81f7af17dcb96999d23a4cd35d387436282935c20eb11befcb8c08396",
  ],
  [
    "20260830090000_organization_identity_v2_resolver_command",
    "3bf6e58db819352ca0777380e9adb2fbf32ca9eeb311b91df696b569302da7af",
  ],
]);
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
const IDENTIFIER_A = "45100000-0000-4000-8000-000000000001";
const IDENTIFIER_DOMAIN_A = "45100000-0000-4000-8000-000000000002";
const IDENTIFIER_REGISTRY_B = "45100000-0000-4000-8000-000000000003";
const IDENTIFIER_CREATED = "45100000-0000-4000-8000-000000000004";
const IDENTIFIER_CREATED_DOMAIN = "45100000-0000-4000-8000-000000000005";
const IDENTIFIER_CREATED_SECOND = "45100000-0000-4000-8000-000000000006";
const PARTY_A = "45200000-0000-4000-8000-000000000001";
const PARTY_B = "45200000-0000-4000-8000-000000000002";
const PARTY_C = "45200000-0000-4000-8000-000000000003";
const PARTY_D = "45200000-0000-4000-8000-000000000004";
const COMMAND_LINK_A = "46100000-0000-4000-8000-000000000001";
const COMMAND_LINK_B = "46100000-0000-4000-8000-000000000002";
const COMMAND_LINK_C = "46100000-0000-4000-8000-000000000003";
const COMMAND_LINK_D = "46100000-0000-4000-8000-000000000004";
const COMMAND_LINK_B_A = "46100000-0000-4000-8000-000000000005";
const COMMAND_LINK_B_B = "46100000-0000-4000-8000-000000000006";
const FIXTURE_SQL_TIME = "2026-08-30 00:00:00.000";
const COMMAND_SQL_TIME = "2026-08-30 01:00:00.000";
const FIXTURE_JSON_TIME = "2026-08-30T00:00:00";
const COMMAND_JSON_TIME = "2026-08-30T01:00:00";
const EXPIRES_JSON_TIME = "2099-08-30T00:00:00+00:00";
const SENTINEL_RAW = "42900000-0000-4000-8000-000000000001";
const SENTINEL_COMPANY_A = "43900000-0000-4000-8000-000000000001";
const SENTINEL_COMPANY_B = "43900000-0000-4000-8000-000000000002";
const SENTINEL_IDENTIFIER = "45900000-0000-4000-8000-000000000001";
const SENTINEL_CONFLICT = "44900000-0000-4000-8000-000000000001";
const SENTINEL_PARTY = "45800000-0000-4000-8000-000000000001";
const SENTINEL_LINK = "46900000-0000-4000-8000-000000000001";
const SENTINEL_MAPPING = "47900000-0000-4000-8000-000000000001";
const SENTINEL_DECISION = "48900000-0000-4000-8000-000000000001";
const SENTINEL_SUPPRESSION = "49900000-0000-4000-8000-000000000001";
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
let prerequisiteReceipt;

function checkedSpawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 10_000,
    input: options.input,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function inspectResource(kind, name) {
  const prefix = kind === "container" ? ["inspect"] : [kind, "inspect"];
  return JSON.parse(
    checkedSpawn("docker", [...prefix, "--format", "{{json .}}", name]),
  );
}

function prerequisiteSql(sql) {
  return checkedSpawn(
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
    { input: sql },
  );
}

function ensurePrerequisite() {
  if (prerequisiteReceipt) return prerequisiteReceipt;
  for (const [name, expected] of migrationChecksums) {
    assert.equal(
      createHash("sha256")
        .update(
          readFileSync(
            resolve(
              repositoryRoot,
              "packages/db/prisma/migrations",
              name,
              "migration.sql",
            ),
          ),
        )
        .digest("hex"),
      expected,
    );
  }
  const image = inspectResource("image", "pgvector/pgvector:pg16");
  assert.deepEqual(image.RepoDigests, [
    "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
  ]);
  const containerState = inspectResource("container", container);
  assert.deepEqual(
    {
      id: containerState.Id,
      image: containerState.Config.Image,
      running: containerState.State.Running,
      ports: containerState.NetworkSettings.Ports,
      labels: containerState.Config.Labels,
      mounts: containerState.Mounts,
      networks: Object.keys(containerState.NetworkSettings.Networks),
    },
    {
      id: containerId,
      image: "pgvector/pgvector:pg16",
      running: true,
      ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] },
      labels: {
        "com.openai.codex.artifact": "identity-authority",
        "com.openai.codex.task": "organization-identity-command-expansion",
      },
      mounts: [
        {
          Type: "volume",
          Name: volume,
          Source: `/data/docker/volumes/${volume}/_data`,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          Mode: "z",
          RW: true,
          Propagation: "",
        },
      ],
      networks: [network],
    },
  );
  const networkState = inspectResource("network", network);
  assert.equal(networkState.Id, networkId);
  assert.equal(networkState.Driver, "bridge");
  assert.deepEqual(networkState.Labels, containerState.Config.Labels);
  assert.deepEqual(Object.keys(networkState.Containers), [containerId]);
  const volumeState = inspectResource("volume", volume);
  assert.deepEqual(
    {
      name: volumeState.Name,
      driver: volumeState.Driver,
      labels: volumeState.Labels,
    },
    {
      name: volume,
      driver: "local",
      labels: { "com.docker.volume.anonymous": "" },
    },
  );
  const ledger = prerequisiteSql(`SELECT migration_name||'|'||checksum||'|'||
    (finished_at IS NOT NULL)::text||'|'||(rolled_back_at IS NULL)::text
    FROM "_prisma_migrations"
    WHERE migration_name IN (${migrationChecksums
      .map(([name]) => `'${name}'`)
      .join(",")}) ORDER BY migration_name;`);
  assert.equal(
    ledger,
    migrationChecksums
      .map(([name, checksum]) => `${name}|${checksum}|true|true`)
      .join("\n"),
  );
  const catalog = prerequisiteSql(`SELECT p.proname||'|'||
    pg_get_function_identity_arguments(p.oid)||'|'||
    pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||
    array_to_string(p.proconfig, ',')||'|'||
    has_function_privilege('app_user',p.oid,'EXECUTE')||'|'||
    has_function_privilege('public',p.oid,'EXECUTE')
    FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'organization_identity_acquire_advisory_until_v1',
      'organization_identity_authority_from_raw_v1',
      'organization_identity_blocker_from_raw_v1',
      'organization_identity_canonical_suppression_value_v1',
      'organization_identity_plan_from_snapshot_v1',
      'resolve_organization_identity_for_raw_v1'
    ) ORDER BY p.proname;`);
  assert.equal(
    catalog,
    [
      "organization_identity_acquire_advisory_until_v1|p_lock_key bigint, p_deadline timestamp with time zone|global|false|search_path=pg_catalog, public|false|false",
      "organization_identity_authority_from_raw_v1|p_provider_key text, p_raw jsonb|global|false|search_path=pg_catalog, public|false|false",
      "organization_identity_blocker_from_raw_v1|p_raw jsonb|global|false|search_path=pg_catalog, public|false|false",
      "organization_identity_canonical_suppression_value_v1|p_type text, p_value text|global|false|search_path=pg_catalog, public|false|false",
      "organization_identity_plan_from_snapshot_v1|p_snapshot jsonb|global|false|search_path=pg_catalog, public|false|false",
      "resolve_organization_identity_for_raw_v1|p_workspace_id text, p_raw_record_id text|global|true|search_path=pg_catalog, public,row_security=off|true|false",
    ].join("\n"),
  );
  const boundary = prerequisiteSql(`SELECT
      to_regprocedure('public.apply_organization_identity_resolution_v1(jsonb)') IS NULL,
      (SELECT rolname||':'||rolsuper||':'||rolbypassrls
       FROM pg_roles WHERE rolname='app_user'),
      has_table_privilege(
        'app_user','organization_identifier','INSERT,UPDATE,DELETE'
      );`);
  assert.equal(boundary, "t|app_user:false:false|f");
  prerequisiteReceipt = Object.freeze({ ledger, catalog, boundary });
  return prerequisiteReceipt;
}

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
const RAW_LEGACY_IDENTIFIER = Object.freeze({ ...RAW_CREATE });
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
const COMPANY_LEGACY_IDENTIFIER = Object.freeze({
  ...COMPANY_A_BASE,
  name: "A4 Create GmbH",
  dedupeKey: "id:registry-id:de1234",
});
const COMPANY_C_SUPPRESSED = Object.freeze({
  ...COMPANY_C_ROOT,
  status: "SUPPRESSED",
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

function fullState({
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

function rawFull(raw) {
  return {
    id: raw.id,
    workspace_id: WORKSPACE_A,
    run_id: null,
    provider_key: raw.providerKey,
    source_class: "company_registry",
    external_id: null,
    payload: raw.payload,
    cost_cents: 0,
    created_at: FIXTURE_JSON_TIME,
    content_hash: HASH_B,
    fetched_at: FIXTURE_JSON_TIME,
    parser_version: "a4/v1",
    source_url: `https://fixture.invalid/${raw.id}`,
    source_entity_id: ENTITY,
    ingest_key: `a4:${raw.id}`,
    payload_hash: raw.payloadHash,
    payload_bytes: 1,
    ingest_version: raw.ingestVersion,
    ingest_status: raw.ingestStatus,
    disposition_code: null,
    retention_days: 30,
    expires_at: EXPIRES_JSON_TIME,
    expired_at: null,
    source_policy_snapshot: {},
  };
}

function companyFull(company, timestamp = FIXTURE_JSON_TIME) {
  return {
    id: company.id,
    workspace_id: WORKSPACE_A,
    name: company.name,
    domain: company.domain,
    country: company.country,
    region: null,
    industry: null,
    employee_count: null,
    revenue_usd: null,
    attributes: null,
    status: company.status,
    dedupe_key: company.dedupeKey,
    version: company.version,
    created_at: timestamp,
    updated_at: timestamp,
    contact_discovery_attempted_at: null,
    last_enriched_at: null,
    last_signal_at: null,
    last_watch_at: null,
    email_guess_attempted_at: null,
  };
}

function identifierFull(identifier, options) {
  return {
    id: options.id,
    workspace_id: WORKSPACE_A,
    company_id: identifier.companyId,
    scheme: identifier.scheme,
    jurisdiction: identifier.jurisdiction,
    normalized_value: identifier.normalizedValue,
    authority_provider_key: identifier.authorityProviderKey,
    raw_record_id: identifier.rawRecordId,
    conflict_id: identifier.conflictId,
    confidence: identifier.confidence,
    normalizer_version: identifier.normalizerVersion,
    validator_version: identifier.validatorVersion,
    provenance: identifier.provenance,
    status: identifier.status,
    first_seen_at: options.firstSeen,
    last_seen_at: options.lastSeen,
    created_at: options.createdAt,
    revoked_at: null,
  };
}

function conflictFull(conflict, timestamp = FIXTURE_JSON_TIME) {
  return {
    id: conflict.id,
    workspace_id: WORKSPACE_A,
    raw_record_id: conflict.rawRecordId,
    conflict_type: conflict.conflictType,
    fingerprint: conflict.fingerprint,
    status: conflict.status,
    revision: conflict.revision,
    facts: conflict.facts,
    created_at: timestamp,
    resolved_at: conflict.status === "RESOLVED" ? timestamp : null,
  };
}

function partyFullValue(value, id, timestamp = FIXTURE_JSON_TIME) {
  return {
    id,
    workspace_id: WORKSPACE_A,
    conflict_id: value.conflictId,
    company_id: value.companyId,
    role: value.role,
    created_at: timestamp,
  };
}

function linkFullValue(value, id, timestamp = FIXTURE_JSON_TIME) {
  return {
    id,
    workspace_id: WORKSPACE_A,
    canonical_type: "company",
    canonical_id: value.canonicalId,
    raw_record_id: value.rawRecordId,
    match_rule: value.matchRule,
    confidence: value.confidence,
    created_at: timestamp,
    status: value.status,
    resolver_version: value.resolverVersion,
    input_hash: value.inputHash,
    conflict_id: value.conflictId,
  };
}

function mappingFullValue(value, index) {
  return {
    id: `47000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspace_id: WORKSPACE_A,
    source_company_id: value.sourceCompanyId,
    canonical_company_id: value.canonicalCompanyId,
    status: value.status,
    revision: value.revision,
    merge_decision_id: `48000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    split_decision_id: null,
    created_at: FIXTURE_JSON_TIME,
    revoked_at: null,
  };
}

function suppressionFullValue(value, index) {
  return {
    id: `49000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspace_id: WORKSPACE_A,
    type: value.type,
    value: value.value,
    reason: "a4-test",
    created_at: FIXTURE_JSON_TIME,
    protection_class: value.protectionClass,
  };
}

function semanticFromFull(full) {
  const ordered = (values, key) =>
    [...values].sort((left, right) => key(left).localeCompare(key(right)));
  return state({
    raws: ordered(full.raws, (row) => row.id).map((row) => ({
      id: row.id,
      providerKey: row.provider_key,
      payloadHash: row.payload_hash,
      ingestVersion: row.ingest_version,
      ingestStatus: row.ingest_status,
    })),
    companies: ordered(full.companies, (row) => row.id).map((row) => ({
      id: row.id,
      name: row.name,
      domain: row.domain,
      country: row.country,
      status: row.status,
      dedupeKey: row.dedupe_key,
      version: row.version,
    })),
    identifiers: ordered(
      full.identifiers,
      (row) =>
        `${row.scheme}|${row.jurisdiction}|${row.normalized_value}|${row.company_id}`,
    ).map((row) => ({
      companyId: row.company_id,
      scheme: row.scheme,
      jurisdiction: row.jurisdiction,
      normalizedValue: row.normalized_value,
      authorityProviderKey: row.authority_provider_key,
      rawRecordId: row.raw_record_id,
      conflictId: row.conflict_id,
      confidence: row.confidence,
      normalizerVersion: row.normalizer_version,
      validatorVersion: row.validator_version,
      provenance: row.provenance,
      status: row.status,
    })),
    conflicts: ordered(full.conflicts, (row) => row.id).map((row) => ({
      id: row.id,
      rawRecordId: row.raw_record_id,
      conflictType: row.conflict_type,
      fingerprint: row.fingerprint,
      status: row.status,
      revision: row.revision,
      facts: row.facts,
    })),
    parties: ordered(
      full.parties,
      (row) => `${row.conflict_id}|${row.company_id}|${row.role}`,
    ).map((row) => ({
      conflictId: row.conflict_id,
      companyId: row.company_id,
      role: row.role,
    })),
    links: ordered(
      full.links,
      (row) => `${row.raw_record_id}|${row.canonical_id}|${row.status}`,
    ).map((row) => ({
      canonicalId: row.canonical_id,
      rawRecordId: row.raw_record_id,
      matchRule: row.match_rule,
      confidence: row.confidence,
      status: row.status,
      resolverVersion: row.resolver_version,
      inputHash: row.input_hash,
      conflictId: row.conflict_id,
    })),
    mappings: ordered(full.mappings, (row) => row.source_company_id).map(
      (row) => ({
        sourceCompanyId: row.source_company_id,
        canonicalCompanyId: row.canonical_company_id,
        status: row.status,
        revision: row.revision,
      }),
    ),
    suppressions: ordered(
      full.suppressions,
      (row) => `${row.type}|${row.value}`,
    ).map((row) => ({
      type: row.type,
      value: row.value,
      protectionClass: row.protection_class,
    })),
  });
}

function fixtureIdentifierFullValue(identifier) {
  return identifierFull(identifier, {
    id: fixtureIdentifierId(identifier),
    firstSeen: FIXTURE_JSON_TIME,
    lastSeen: FIXTURE_JSON_TIME,
    createdAt: FIXTURE_JSON_TIME,
  });
}

function refreshedIdentifierFullValue(identifier) {
  return identifierFull(identifier, {
    id: fixtureIdentifierId(identifier),
    firstSeen: FIXTURE_JSON_TIME,
    lastSeen: COMMAND_JSON_TIME,
    createdAt: FIXTURE_JSON_TIME,
  });
}

function commandIdentifierFullValue(identifier, id) {
  return identifierFull(identifier, {
    id,
    firstSeen: COMMAND_JSON_TIME,
    lastSeen: COMMAND_JSON_TIME,
    createdAt: COMMAND_JSON_TIME,
  });
}

function fixturePartyFullValue(value) {
  return partyFullValue(value, fixturePartyId(value), FIXTURE_JSON_TIME);
}

function commandPartyFullValue(value) {
  return partyFullValue(value, fixturePartyId(value), COMMAND_JSON_TIME);
}

function fixtureLinkFullValue(value, index) {
  return linkFullValue(
    value,
    `46000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    FIXTURE_JSON_TIME,
  );
}

function commandLinkFullValue(value, id) {
  return linkFullValue(value, id, COMMAND_JSON_TIME);
}

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

function fixtureIdentifierId(row) {
  if (row.companyId === COMPANY_A && row.scheme === "registry-id") {
    return IDENTIFIER_A;
  }
  if (row.companyId === COMPANY_A && row.scheme === "domain") {
    return IDENTIFIER_DOMAIN_A;
  }
  if (row.companyId === COMPANY_B && row.scheme === "registry-id") {
    return IDENTIFIER_REGISTRY_B;
  }
  assert.fail(`missing literal fixture identifier ID for ${row.scheme}`);
}

function fixturePartyId(row) {
  const id = new Map([
    [COMPANY_A, PARTY_A],
    [COMPANY_B, PARTY_B],
    [COMPANY_C, PARTY_C],
    [COMPANY_D, PARTY_D],
  ]).get(row.companyId);
  assert.ok(id, `missing literal party ID for ${row.companyId}`);
  return id;
}

function sentinelSql() {
  const facts = sqlJson({
    schemaVersion: "organization-identity-conflict/v1",
    resolverVersion: RESOLVER,
    blockerKey: "d:a4-sentinel.example",
    blockerRule: "domain_exact",
    conflictType: "blocking_key_disagreement",
    companyIds: [SENTINEL_COMPANY_A, SENTINEL_COMPANY_B],
    identifierKeys: ["domain:GLOBAL:a4-sentinel.example"],
  });
  return `INSERT INTO raw_source_record(
      id,workspace_id,source_entity_id,provider_key,source_class,payload,
      source_url,fetched_at,content_hash,parser_version,ingest_key,
      payload_hash,payload_bytes,ingest_version,ingest_status,
      retention_days,expires_at,source_policy_snapshot,created_at
    ) VALUES (
      '${SENTINEL_RAW}','${WORKSPACE_B}','${ENTITY}','directory',
      'company_registry','{"name":"A4 Sentinel","domain":"a4-sentinel.example","country":"DE"}'::jsonb,
      'https://fixture.invalid/sentinel','${FIXTURE_SQL_TIME}','${HASH_B}',
      'a4/v1','a4:sentinel','${HASH_A}',1,'raw-source/v2','ACCEPTED',
      30,'2099-08-30 00:00:00+00','{}'::jsonb,'${FIXTURE_SQL_TIME}'
    );
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,country,status,dedupe_key,version,
      created_at,updated_at
    ) VALUES
      ('${SENTINEL_COMPANY_A}','${WORKSPACE_B}','A4 Sentinel A',
       'a4-sentinel-a.example','DE','NEW','d:a4-sentinel-a.example',1,
       '${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}'),
      ('${SENTINEL_COMPANY_B}','${WORKSPACE_B}','A4 Sentinel B',
       'a4-sentinel-b.example','DE','NEW','d:a4-sentinel-b.example',1,
       '${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}');
    INSERT INTO organization_identity_conflict(
      id,workspace_id,raw_record_id,conflict_type,fingerprint,status,
      revision,facts,resolved_at,created_at
    ) VALUES (
      '${SENTINEL_CONFLICT}','${WORKSPACE_B}','${SENTINEL_RAW}',
      'blocking_key_disagreement','${HASH_B}','OPEN',1,'${facts}'::jsonb,
      NULL,'${FIXTURE_SQL_TIME}'
    );
    INSERT INTO organization_identifier(
      id,workspace_id,company_id,scheme,jurisdiction,normalized_value,
      authority_provider_key,raw_record_id,conflict_id,confidence,
      normalizer_version,validator_version,provenance,status,
      first_seen_at,last_seen_at,created_at,revoked_at
    ) VALUES (
      '${SENTINEL_IDENTIFIER}','${WORKSPACE_B}','${SENTINEL_COMPANY_A}',
      'domain','GLOBAL','a4-sentinel.example','directory','${SENTINEL_RAW}',
      NULL,1,'organization-identity-authority/v1','domain-v1',
      '{"schemaVersion":"organization-identifier-provenance/v1"}'::jsonb,
      'ACTIVE','${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}',
      '${FIXTURE_SQL_TIME}',NULL
    );
    INSERT INTO organization_identity_conflict_party(
      id,workspace_id,conflict_id,company_id,role,created_at
    ) VALUES (
      '${SENTINEL_PARTY}','${WORKSPACE_B}','${SENTINEL_CONFLICT}',
      '${SENTINEL_COMPANY_A}','CANDIDATE','${FIXTURE_SQL_TIME}'
    );
    INSERT INTO identity_link(
      id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
      confidence,status,resolver_version,input_hash,conflict_id,created_at
    ) VALUES (
      '${SENTINEL_LINK}','${WORKSPACE_B}','company','${SENTINEL_COMPANY_A}',
      '${SENTINEL_RAW}','identity_conflict',0,'PENDING_CONFLICT','${RESOLVER}',
      '${HASH_A}','${SENTINEL_CONFLICT}','${FIXTURE_SQL_TIME}'
    );
    INSERT INTO organization_canonical_mapping(
      id,workspace_id,source_company_id,canonical_company_id,status,revision,
      merge_decision_id,split_decision_id,created_at,revoked_at
    ) VALUES (
      '${SENTINEL_MAPPING}','${WORKSPACE_B}','${SENTINEL_COMPANY_A}',
      '${SENTINEL_COMPANY_B}','ACTIVE',1,'${SENTINEL_DECISION}',NULL,
      '${FIXTURE_SQL_TIME}',NULL
    );
    INSERT INTO suppression_record(
      id,workspace_id,type,value,reason,protection_class,created_at
    ) VALUES (
      '${SENTINEL_SUPPRESSION}','${WORKSPACE_B}','domain',
      'a4-sentinel.example','a4-sentinel','LEGAL','${FIXTURE_SQL_TIME}'
    );`;
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
        'https://fixture.invalid/${raw.id}','${FIXTURE_SQL_TIME}','${HASH_B}','a4/v1',
        'a4:${raw.id}','${raw.payloadHash}',1,'${raw.ingestVersion}',
        '${raw.ingestStatus}',30,'2099-08-30 00:00:00+00','{}'::jsonb,
        '${FIXTURE_SQL_TIME}')`,
    )
    .join(",\n");
  const companyRows = companies
    .map(
      (row) => `('${row.id}','${WORKSPACE_A}','${row.name}',${
        row.domain === null ? "NULL" : `'${row.domain}'`
      },${row.country === null ? "NULL" : `'${row.country}'`},
        '${row.status}','${row.dedupeKey}',${row.version},
        '${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}')`,
    )
    .join(",\n");
  const identifierRows = identifiers
    .map(
      (row) => `('${fixtureIdentifierId(row)}','${WORKSPACE_A}',
        '${row.companyId}','${row.scheme}',
        '${row.jurisdiction}','${row.normalizedValue}',
        '${row.authorityProviderKey}','${row.rawRecordId}',
        ${row.conflictId === null ? "NULL" : `'${row.conflictId}'`},
        ${row.confidence},'${row.normalizerVersion}','${row.validatorVersion}',
        '${sqlJson(row.provenance)}'::jsonb,'${row.status}',
        '${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}',NULL)`,
    )
    .join(",\n");
  const conflictRows = conflicts
    .map(
      (row) => `('${row.id}','${WORKSPACE_A}',${
        row.rawRecordId === null ? "NULL" : `'${row.rawRecordId}'`
      },'${row.conflictType}','${row.fingerprint}','${row.status}',
        ${row.revision},'${sqlJson(row.facts)}'::jsonb,
        ${row.status === "RESOLVED" ? `'${FIXTURE_SQL_TIME}'` : "NULL"},
        '${FIXTURE_SQL_TIME}')`,
    )
    .join(",\n");
  const partyRows = parties
    .map(
      (row) => `('${fixturePartyId(row)}','${WORKSPACE_A}',
        '${row.conflictId}',
        '${row.companyId}','${row.role}','${FIXTURE_SQL_TIME}')`,
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
        ${row.conflictId === null ? "NULL" : `'${row.conflictId}'`},
        '${FIXTURE_SQL_TIME}')`,
    )
    .join(",\n");
  const mappingRows = mappings
    .map(
      (row, index) => `('47000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        "0",
      )}','${WORKSPACE_A}','${row.sourceCompanyId}',
        '${row.canonicalCompanyId}','${row.status}',${row.revision},
        '48000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}',
        NULL,'${FIXTURE_SQL_TIME}',NULL)`,
    )
    .join(",\n");
  const suppressionRows = suppressions
    .map(
      (row, index) => `('49000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        "0",
      )}','${WORKSPACE_A}','${row.type}','${row.value}',
        'a4-test','${row.protectionClass}','${FIXTURE_SQL_TIME}')`,
    )
    .join(",\n");
  return `INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}','A4 Workspace A','${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}'),
      ('${WORKSPACE_B}','A4 Workspace B','${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}');
    INSERT INTO monitored_source(
      id,provider_key,source_key,label,config,status,created_at,updated_at
    ) VALUES ('${SOURCE}','registry','a4:source','A4 Source','{}','ACTIVE',
      '${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}');
    INSERT INTO source_entity(
      id,source_id,external_id,entity_kind,name,cleaned,content_hash,
      created_at,updated_at
    ) VALUES ('${ENTITY}','${SOURCE}','a4-entity','company','A4 Entity',
      '{}','${HASH_A}','${FIXTURE_SQL_TIME}','${FIXTURE_SQL_TIME}');
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
      id,workspace_id,company_id,scheme,jurisdiction,normalized_value,
      authority_provider_key,raw_record_id,conflict_id,confidence,
      normalizer_version,validator_version,provenance,status,
      first_seen_at,last_seen_at,created_at,revoked_at
    ) VALUES ${identifierRows};`
    }
    ${
      partyRows === ""
        ? ""
        : `INSERT INTO organization_identity_conflict_party(
      id,workspace_id,conflict_id,company_id,role,created_at
    ) VALUES ${partyRows};`
    }
    ${
      linkRows === ""
        ? ""
        : `INSERT INTO identity_link(
      id,workspace_id,canonical_type,canonical_id,raw_record_id,
      match_rule,confidence,status,resolver_version,input_hash,conflict_id,
      created_at
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
      id,workspace_id,type,value,reason,protection_class,created_at
    ) VALUES ${suppressionRows};`
    }
    ${bypassTriggers ? "" : "SET LOCAL session_replication_role='replica';"}
    ${sentinelSql()}
    SET LOCAL session_replication_role='origin';
    ${extraSql}`;
}

function semanticStateSql(workspaceId) {
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

function fullStateSql(workspaceId) {
  const rows = (table, orderBy = "id") =>
    `coalesce((SELECT jsonb_agg(to_jsonb(row) ORDER BY ${orderBy})
      FROM ${table} AS row WHERE workspace_id='${workspaceId}'),'[]'::jsonb)`;
  return `jsonb_build_object(
    'raws',${rows("raw_source_record")},
    'companies',${rows("canonical_company")},
    'identifiers',${rows("organization_identifier")},
    'conflicts',${rows("organization_identity_conflict")},
    'parties',${rows("organization_identity_conflict_party")},
    'links',${rows("identity_link")},
    'mappings',${rows("organization_canonical_mapping")},
    'suppressions',${rows("suppression_record")}
  )`;
}

const FULL_COLUMNS = Object.freeze({
  raws: "content_hash,cost_cents,created_at,disposition_code,expired_at,expires_at,external_id,fetched_at,id,ingest_key,ingest_status,ingest_version,parser_version,payload,payload_bytes,payload_hash,provider_key,retention_days,run_id,source_class,source_entity_id,source_policy_snapshot,source_url,workspace_id".split(
    ",",
  ),
  companies:
    "attributes,contact_discovery_attempted_at,country,created_at,dedupe_key,domain,email_guess_attempted_at,employee_count,id,industry,last_enriched_at,last_signal_at,last_watch_at,name,region,revenue_usd,status,updated_at,version,workspace_id".split(
      ",",
    ),
  identifiers:
    "authority_provider_key,company_id,confidence,conflict_id,created_at,first_seen_at,id,jurisdiction,last_seen_at,normalized_value,normalizer_version,provenance,raw_record_id,revoked_at,scheme,status,validator_version,workspace_id".split(
      ",",
    ),
  conflicts:
    "conflict_type,created_at,facts,fingerprint,id,raw_record_id,resolved_at,revision,status,workspace_id".split(
      ",",
    ),
  parties: "company_id,conflict_id,created_at,id,role,workspace_id".split(","),
  links:
    "canonical_id,canonical_type,confidence,conflict_id,created_at,id,input_hash,match_rule,raw_record_id,resolver_version,status,workspace_id".split(
      ",",
    ),
  mappings:
    "canonical_company_id,created_at,id,merge_decision_id,revision,revoked_at,source_company_id,split_decision_id,status,workspace_id".split(
      ",",
    ),
  suppressions:
    "created_at,id,protection_class,reason,type,value,workspace_id".split(","),
});
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertFullColumns(fullState, workspaceId = WORKSPACE_A) {
  assert.deepEqual(
    Object.keys(fullState).sort(),
    Object.keys(FULL_COLUMNS).sort(),
  );
  for (const [table, rows] of Object.entries(fullState)) {
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), FULL_COLUMNS[table]);
      assert.equal(row.workspace_id, workspaceId);
      assert.match(row.id, UUID_TEXT);
      for (const [column, value] of Object.entries(row)) {
        if (column.endsWith("_id") && value !== null)
          assert.match(value, UUID_TEXT);
        if (column.endsWith("_at") && value !== null) {
          assert.equal(
            Number.isFinite(Date.parse(value)),
            true,
            `${table}.${column}`,
          );
        }
      }
    }
  }
}

function assertSentinel(fullState) {
  assertFullColumns(fullState, WORKSPACE_B);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(fullState).map(([table, rows]) => [table, rows.length]),
    ),
    {
      raws: 1,
      companies: 2,
      identifiers: 1,
      conflicts: 1,
      parties: 1,
      links: 1,
      mappings: 1,
      suppressions: 1,
    },
  );
  assert.deepEqual(
    [
      fullState.raws[0].id,
      ...fullState.companies.map((row) => row.id),
      fullState.identifiers[0].id,
      fullState.conflicts[0].id,
      fullState.parties[0].id,
      fullState.links[0].id,
      fullState.mappings[0].id,
      fullState.suppressions[0].id,
    ],
    [
      SENTINEL_RAW,
      SENTINEL_COMPANY_A,
      SENTINEL_COMPANY_B,
      SENTINEL_IDENTIFIER,
      SENTINEL_CONFLICT,
      SENTINEL_PARTY,
      SENTINEL_LINK,
      SENTINEL_MAPPING,
      SENTINEL_SUPPRESSION,
    ],
  );
}

function runScenario(scenario) {
  ensurePrerequisite();
  const stageReceipt = scenario.stageLockKey
    ? `SELECT to_jsonb(pg_advisory_unlock(hashtextextended('${scenario.stageLockKey}',0)))`
    : "SELECT 'true'::jsonb";
  const sql = `SELECT 'A4_CALLER_PID|'||pg_backend_pid();
    BEGIN;
    ${fixtureSql(scenario.fixture)}
    CREATE TEMP TABLE a4_observed(
      stage text PRIMARY KEY,value jsonb NOT NULL
    ) ON COMMIT DROP;
    GRANT SELECT,INSERT ON a4_observed TO app_user;
    SET SESSION AUTHORIZATION app_user;
    SET LOCAL lock_timeout='${scenario.lockTimeout ?? "5s"}';
    SET LOCAL statement_timeout='${scenario.statementTimeout ?? "60s"}';
    SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
    INSERT INTO a4_observed VALUES ('preA',${semanticStateSql(WORKSPACE_A)});
    INSERT INTO a4_observed VALUES ('preAFull',${fullStateSql(WORKSPACE_A)});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
    INSERT INTO a4_observed VALUES ('preBFull',${fullStateSql(WORKSPACE_B)});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
    DO $a4_call$
    DECLARE
      resolved jsonb;
      call_workspace text := '${WORKSPACE_A}';
      call_raw text := '${scenario.rawRecordId ?? RAW_A}';
      returned_sqlstate text;
      message_text text;
      exception_detail text;
      exception_hint text;
      exception_context text;
    BEGIN
      SELECT jsonb_agg(to_jsonb(row)) INTO resolved
      FROM public.resolve_organization_identity_for_raw_v1(
        call_workspace,call_raw
      ) AS row;
      INSERT INTO a4_observed VALUES (
        'outcome',jsonb_build_object('kind','result','rows',resolved)
      );
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS
        returned_sqlstate = RETURNED_SQLSTATE,
        message_text = MESSAGE_TEXT,
        exception_detail = PG_EXCEPTION_DETAIL,
        exception_hint = PG_EXCEPTION_HINT,
        exception_context = PG_EXCEPTION_CONTEXT;
      INSERT INTO a4_observed VALUES (
        'outcome',jsonb_build_object(
          'kind','error','sqlstate',returned_sqlstate,'message',message_text,
          'detail',nullif(exception_detail,''),
          'hint',nullif(exception_hint,''),
          'context',nullif(exception_context,'')
        )
      );
    END
    $a4_call$;
    SET LOCAL client_min_messages='error';
    INSERT INTO a4_observed VALUES ('stageFired',(${stageReceipt}));
    INSERT INTO a4_observed VALUES ('postA',${semanticStateSql(WORKSPACE_A)});
    INSERT INTO a4_observed VALUES ('postAFull',${fullStateSql(WORKSPACE_A)});
    SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
    INSERT INTO a4_observed VALUES ('postBFull',${fullStateSql(WORKSPACE_B)});
    SELECT jsonb_object_agg(stage,value ORDER BY stage)::text FROM a4_observed;
    ROLLBACK;`;
  const startedAt = Date.now();
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGAPPNAME=a4-command-caller",
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
  const callerMatch = result.stdout?.match(/^A4_CALLER_PID\|([0-9]+)$/mu);
  const callerPid = callerMatch ? Number(callerMatch[1]) : null;
  try {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout
      .trim()
      .split("\n")
      .findLast((candidate) => candidate.startsWith("{"));
    assert.ok(line, `scenario emitted no JSON readback:\n${result.stdout}`);
    assert.ok(callerPid, `scenario emitted no caller PID:\n${result.stdout}`);
    return {
      observed: JSON.parse(line),
      elapsedMs: Date.now() - startedAt,
      callerPid,
      processOutput: result.stderr,
    };
  } finally {
    if (callerPid !== null) assertBackendCleanup(callerPid);
    else assertApplicationCleanup("a4-command-caller");
  }
}

function error(sqlstate, message) {
  return { kind: "error", sqlstate, message };
}

function resultRow(row) {
  return { kind: "result", rows: [row] };
}

function primaryOutcome(outcome) {
  return outcome.kind === "error"
    ? {
        kind: "error",
        sqlstate: outcome.sqlstate,
        message: outcome.message,
      }
    : outcome;
}

function assertOrdinaryDiagnosticShape(outcome) {
  if (outcome.kind !== "error") return;
  assert.deepEqual(Object.keys(outcome).sort(), [
    "context",
    "detail",
    "hint",
    "kind",
    "message",
    "sqlstate",
  ]);
  assert.equal(outcome.detail, null);
  assert.equal(outcome.hint, null);
  assert.equal(typeof outcome.context, "string");
  const normalized = outcome.context.replaceAll(/line [0-9]+/gu, "line <n>");
  assert.match(
    normalized,
    /^PL\/pgSQL function resolve_organization_identity_for_raw_v1\(text,text\) line <n> at RAISE\nSQL statement "SELECT jsonb_agg\(to_jsonb\(row\)\)[\s\S]+call_workspace,call_raw[\s\S]+AS row"\nPL\/pgSQL function inline_code_block line <n> at SQL statement$/u,
  );
}

function assertScenario(scenario) {
  const { observed, elapsedMs, processOutput } = runScenario(scenario);
  const observedPrimary = primaryOutcome(observed.outcome);
  assert.deepEqual(observed.preA, scenario.expectedPre);
  assertFullColumns(observed.preAFull);
  assertSentinel(observed.preBFull);
  assert.deepEqual(observed.postBFull, observed.preBFull);
  if (scenario.expectedOutcome.kind === "result") {
    assert.ok(
      scenario.expectedFullPost,
      "successful scenario lacks full postimage",
    );
    assertFullColumns(scenario.expectedFullPost);
    assert.deepEqual(
      semanticFromFull(scenario.expectedFullPost),
      scenario.expectedPost,
    );
    if (isDeepStrictEqual(observedPrimary, scenario.expectedOutcome)) {
      assert.deepEqual(observed.postAFull, scenario.expectedFullPost);
    }
  }
  const noWrite =
    scenario.expectedOutcome.kind === "error" ||
    scenario.expectNoWrite === true;
  if (noWrite) assert.deepEqual(observed.postAFull, observed.preAFull);
  if (scenario.diagnosticShape === "public_fixed") {
    assertOrdinaryDiagnosticShape(observed.outcome);
  }
  const publicSurface = `${JSON.stringify(observed.outcome)}\n${processOutput}`;
  for (const forbidden of scenario.forbiddenPublicFragments ?? []) {
    assert.equal(
      publicSurface.includes(forbidden),
      false,
      `public error leaked ${forbidden}`,
    );
  }
  const actual = {
    outcome: observedPrimary,
    state: observed.postA,
    stageFired: observed.stageFired,
  };
  const expected = {
    outcome: scenario.expectedOutcome,
    state: scenario.expectedPost,
    stageFired: true,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    assert.fail(
      [
        "A4_EXPECTED_BEHAVIOR_MISMATCH",
        `actual=${JSON.stringify(actual.outcome)}`,
        `desired=${JSON.stringify(expected.outcome)}`,
        `stateExact=${isDeepStrictEqual(actual.state, expected.state)}`,
        `stageFired=${observed.stageFired}`,
        `fullPreimageExact=${isDeepStrictEqual(
          observed.postAFull,
          observed.preAFull,
        )}`,
        `workspaceBSentinelExact=${isDeepStrictEqual(
          observed.postBFull,
          observed.preBFull,
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
    company_created: false,
    identifier_count: identifierCount,
    party_count: 0,
  });
}

function createdResult({ companyId, matchRule, inputHash, identifierCount }) {
  return resultRow({
    outcome_kind: "created",
    raw_record_id: RAW_A,
    company_id: companyId,
    conflict_id: null,
    match_rule: matchRule,
    input_hash: inputHash,
    conflict_fingerprint: null,
    replayed: false,
    company_created: true,
    identifier_count: identifierCount,
    party_count: 0,
  });
}

function legacyBoundResult({ companyId, matchRule }) {
  return resultRow({
    outcome_kind: "legacy_bound",
    raw_record_id: RAW_A,
    company_id: companyId,
    conflict_id: null,
    match_rule: matchRule,
    input_hash: "legacy",
    conflict_fingerprint: null,
    replayed: true,
    company_created: false,
    identifier_count: 0,
    party_count: 0,
  });
}

function suppressedResult() {
  return resultRow({
    outcome_kind: "suppressed",
    raw_record_id: RAW_A,
    company_id: null,
    conflict_id: null,
    match_rule: null,
    input_hash: null,
    conflict_fingerprint: null,
    replayed: false,
    company_created: false,
    identifier_count: 0,
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

function deterministicWritesSql() {
  return `CREATE FUNCTION pg_temp.a4_deterministic_company() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${WORKSPACE_A}'::uuid THEN
        IF NEW.dedupe_key='n:a4 create:de' THEN NEW.id='${COMPANY_C}'::uuid; END IF;
        NEW.created_at='${COMMAND_SQL_TIME}';
        NEW.updated_at='${COMMAND_SQL_TIME}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_deterministic_company
    BEFORE INSERT OR UPDATE ON canonical_company
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_deterministic_company();

    CREATE FUNCTION pg_temp.a4_deterministic_identifier() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${WORKSPACE_A}'::uuid THEN
        IF TG_OP='INSERT' THEN
          NEW.id=CASE
            WHEN NEW.scheme='domain' THEN '${IDENTIFIER_CREATED_DOMAIN}'::uuid
            WHEN NEW.normalized_value='DE9999' THEN '${IDENTIFIER_CREATED_SECOND}'::uuid
            ELSE '${IDENTIFIER_CREATED}'::uuid
          END;
          NEW.first_seen_at='${COMMAND_SQL_TIME}';
          NEW.created_at='${COMMAND_SQL_TIME}';
        END IF;
        NEW.last_seen_at='${COMMAND_SQL_TIME}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_deterministic_identifier
    BEFORE INSERT OR UPDATE ON organization_identifier
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_deterministic_identifier();

    CREATE FUNCTION pg_temp.a4_deterministic_conflict() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${WORKSPACE_A}'::uuid THEN
        NEW.id='${CONFLICT}'::uuid;
        NEW.created_at='${COMMAND_SQL_TIME}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_deterministic_conflict
    BEFORE INSERT ON organization_identity_conflict
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_deterministic_conflict();

    CREATE FUNCTION pg_temp.a4_deterministic_party() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${WORKSPACE_A}'::uuid THEN
        NEW.id=CASE NEW.company_id
          WHEN '${COMPANY_A}'::uuid THEN '${PARTY_A}'::uuid
          WHEN '${COMPANY_B}'::uuid THEN '${PARTY_B}'::uuid
          WHEN '${COMPANY_C}'::uuid THEN '${PARTY_C}'::uuid
          ELSE '${PARTY_D}'::uuid
        END;
        NEW.created_at='${COMMAND_SQL_TIME}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_deterministic_party
    BEFORE INSERT ON organization_identity_conflict_party
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_deterministic_party();

    CREATE FUNCTION pg_temp.a4_deterministic_link() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${WORKSPACE_A}'::uuid THEN
        NEW.id=CASE
          WHEN NEW.raw_record_id='${RAW_B}'::uuid AND NEW.canonical_id='${COMPANY_A}'::uuid
            THEN '${COMMAND_LINK_B_A}'::uuid
          WHEN NEW.raw_record_id='${RAW_B}'::uuid AND NEW.canonical_id='${COMPANY_B}'::uuid
            THEN '${COMMAND_LINK_B_B}'::uuid
          WHEN NEW.canonical_id='${COMPANY_A}'::uuid THEN '${COMMAND_LINK_A}'::uuid
          WHEN NEW.canonical_id='${COMPANY_B}'::uuid THEN '${COMMAND_LINK_B}'::uuid
          WHEN NEW.canonical_id='${COMPANY_C}'::uuid THEN '${COMMAND_LINK_C}'::uuid
          ELSE '${COMMAND_LINK_D}'::uuid
        END;
        NEW.created_at='${COMMAND_SQL_TIME}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_deterministic_link
    BEFORE INSERT ON identity_link
    FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_deterministic_link();`;
}

function afterStageFault(table, stageName, targetCount, sqlstate, message) {
  const stageLockKey = `a4-hidden-stage:${stageName}`;
  return Object.freeze({
    stageLockKey,
    sql: `CREATE TEMP TABLE a4_stage_counter(
        stage text PRIMARY KEY, seen integer NOT NULL
      ) ON COMMIT DROP;
      CREATE FUNCTION pg_temp.a4_after_stage_fault() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE current_count integer;
      BEGIN
        INSERT INTO pg_temp.a4_stage_counter(stage,seen)
        VALUES ('${stageName}',1)
        ON CONFLICT (stage) DO UPDATE
        SET seen=a4_stage_counter.seen+1
        RETURNING seen INTO current_count;
        IF current_count=${targetCount} THEN
          PERFORM pg_advisory_lock(hashtextextended('${stageLockKey}',0));
          RAISE EXCEPTION '${message}' USING ERRCODE='${sqlstate}';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER a4_after_${stageName}
      AFTER INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_after_stage_fault();`,
    forbidden: [
      sqlstate,
      message,
      "CONTEXT:",
      "DETAIL:",
      "HINT:",
      "fixture.invalid",
      "not-a-uuid-a4",
      "a4_after_stage_fault",
      "pg_temp",
      WORKSPACE_A,
      RAW_A,
      COMPANY_A,
    ],
  });
}

function afterStageAssertFailure(table, stageName, message) {
  const stageLockKey = `a4-hidden-stage:${stageName}`;
  return Object.freeze({
    stageLockKey,
    sql: `CREATE FUNCTION pg_temp.a4_after_assert_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${stageLockKey}',0));
        ASSERT false, '${message}';
        RETURN NEW;
      END $$;
      CREATE TRIGGER a4_after_${stageName}
      AFTER INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_after_assert_failure();`,
    forbidden: [
      "P0004",
      message,
      "CONTEXT:",
      "DETAIL:",
      "HINT:",
      "a4_after_assert_failure",
      "pg_temp",
      WORKSPACE_A,
      RAW_A,
      COMPANY_A,
    ],
  });
}

function backendArtifactState(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, `invalid backend PID ${pid}`);
  return JSON.parse(
    prerequisiteSql(`SELECT jsonb_build_object(
      'backend',(SELECT count(*) FROM pg_stat_activity
        WHERE pid=${pid} AND datname='${database}' AND usename='global'),
      'transaction',(SELECT count(*) FROM pg_stat_activity
        WHERE pid=${pid} AND xact_start IS NOT NULL),
      'locks',(SELECT count(*) FROM pg_locks WHERE pid=${pid}),
      'triggers',(SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'a4_%')
    )::text;`),
  );
}

function terminateExactBackend(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, `invalid backend PID ${pid}`);
  prerequisiteSql(`SELECT coalesce(bool_or(pg_terminate_backend(pid)),false)
    FROM pg_stat_activity
    WHERE pid=${pid} AND datname='${database}' AND usename='global';`);
}

function assertBackendCleanup(pid) {
  if (backendArtifactState(pid).backend !== 0) terminateExactBackend(pid);
  assert.deepEqual(backendArtifactState(pid), {
    backend: 0,
    transaction: 0,
    locks: 0,
    triggers: 0,
  });
}

function assertApplicationCleanup(applicationName) {
  const pids = prerequisiteSql(`SELECT coalesce(
    string_agg(pid::text,',' ORDER BY pid),'')
    FROM pg_stat_activity
    WHERE application_name='${applicationName}'
      AND datname='${database}' AND usename='global';`);
  for (const pid of pids === "" ? [] : pids.split(",").map(Number)) {
    terminateExactBackend(pid);
    assertBackendCleanup(pid);
  }
  assert.equal(
    prerequisiteSql(`SELECT count(*) FROM pg_stat_activity
      WHERE application_name='${applicationName}'
        AND datname='${database}' AND usename='global';`),
    "0",
  );
}

function cleanupCommittedFixture() {
  prerequisiteSql(`BEGIN;
    SET LOCAL session_replication_role='replica';
    DELETE FROM identity_link
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM organization_identifier
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM organization_identity_conflict_party
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM organization_identity_conflict
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM organization_canonical_mapping
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM suppression_record
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM raw_source_governance_disposition
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM raw_source_record
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM canonical_company
      WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    DELETE FROM source_entity WHERE id='${ENTITY}';
    DELETE FROM monitored_source WHERE id='${SOURCE}';
    DELETE FROM workspace WHERE id IN ('${WORKSPACE_A}','${WORKSPACE_B}');
    SET LOCAL session_replication_role='origin';
    COMMIT;`);
  assert.equal(
    prerequisiteSql(`SELECT
      (SELECT count(*) FROM workspace
        WHERE id IN ('${WORKSPACE_A}','${WORKSPACE_B}'))||'|'||
      (SELECT count(*) FROM raw_source_record
        WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}'))||'|'||
      (SELECT count(*) FROM canonical_company
        WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}'))||'|'||
      (SELECT count(*) FROM identity_link
        WHERE workspace_id IN ('${WORKSPACE_A}','${WORKSPACE_B}'));`),
    "0|0|0|0",
  );
}

function seedCommittedFixture(fixture) {
  cleanupCommittedFixture();
  prerequisiteSql(`BEGIN;${fixtureSql(fixture)}COMMIT;`);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function bounded(promise, milliseconds, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`${label} exceeded ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (cause) => {
        clearTimeout(timer);
        rejectPromise(cause);
      },
    );
  });
}

function startHolder(statement) {
  ensurePrerequisite();
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGAPPNAME=a4-holder",
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
  let backendPid = null;
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
      const pidMatch = stdout.match(/A4_HOLDER_PID\|([0-9]+)/u);
      if (pidMatch) backendPid = Number(pidMatch[1]);
      if (
        !readySettled &&
        backendPid !== null &&
        stdout.includes("A4_HOLDER_READY")
      ) {
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
      readyReject(
        new Error("holder did not acquire the lock within 5 seconds"),
      );
    }
  }, 5_000);
  child.stdin.write(
    `SELECT 'A4_HOLDER_PID|'||pg_backend_pid(); BEGIN; ${statement}; SELECT 'A4_HOLDER_READY';\n`,
  );
  return {
    ready: ready.finally(() => clearTimeout(acquisitionTimer)),
    async release() {
      if (!releaseStarted) {
        releaseStarted = true;
        if (child.stdin.writable) child.stdin.end("ROLLBACK;\\q\n");
      }
      let result;
      let forced = false;
      try {
        result = await bounded(completion, 3_000, "holder graceful release");
      } catch {
        forced = true;
        if (backendPid !== null) terminateExactBackend(backendPid);
        child.kill("SIGTERM");
        result = await bounded(completion, 3_000, "holder forced completion");
      } finally {
        if (backendPid !== null) assertBackendCleanup(backendPid);
        else assertApplicationCleanup("a4-holder");
      }
      if (!forced) {
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      }
      return Object.freeze({ backendPid, forced });
    },
  };
}

function parseVerboseDiagnostics(stderr, expectedSqlstate) {
  const lines = stderr.trim().split("\n");
  const primary = lines[0]?.match(/^ERROR:\s+([0-9A-Z]{5}): (.+)$/u);
  assert.ok(primary, `verbose error had no primary diagnostic:\n${stderr}`);
  assert.equal(primary[1], expectedSqlstate);
  const diagnostics = {
    message: primary[2],
    detail: null,
    hint: null,
    context: null,
    location: null,
  };
  let active = null;
  for (const line of lines.slice(1)) {
    if (/^(ERROR|WARNING|NOTICE):/u.test(line)) break;
    const field = line.match(/^(DETAIL|HINT|CONTEXT|LOCATION):\s*(.*)$/u);
    if (field) {
      active = field[1].toLowerCase();
      diagnostics[active] = field[2];
    } else if (active && line !== "") {
      diagnostics[active] += `\n${line}`;
    }
  }
  return diagnostics;
}

function assertVerboseDiagnosticShape(diagnostics) {
  assert.equal(diagnostics.detail, null);
  assert.equal(diagnostics.hint, null);
  assert.equal(typeof diagnostics.context, "string");
  assert.match(
    diagnostics.context.replaceAll(/line [0-9]+/gu, "line <n>"),
    /^PL\/pgSQL function resolve_organization_identity_for_raw_v1\(text,text\) line <n> at RAISE$/u,
  );
  assert.equal(typeof diagnostics.location, "string");
  assert.match(diagnostics.location, /^exec_stmt_raise, pl_exec\.c:[0-9]+$/u);
}

async function runStatementScenario(scenario) {
  ensurePrerequisite();
  const stageReceipt = scenario.stageLockKey
    ? `to_jsonb(pg_advisory_unlock(hashtextextended('${scenario.stageLockKey}',0)))`
    : "'true'::jsonb";
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGAPPNAME=a4-statement-caller",
      container,
      "psql",
      "-U",
      "global",
      "-d",
      database,
      "--no-psqlrc",
      "-X",
      "-qAt",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let callerPid = null;
  let pidResolve;
  let pidReject;
  const pidReady = new Promise((resolvePromise, rejectPromise) => {
    pidResolve = resolvePromise;
    pidReject = rejectPromise;
  });
  const completion = new Promise((resolvePromise, rejectPromise) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/A4_STATEMENT_PID\|([0-9]+)/u);
      if (match && callerPid === null) {
        callerPid = Number(match[1]);
        pidResolve(callerPid);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      if (callerPid === null) pidReject(cause);
      rejectPromise(cause);
    });
    child.on("close", (code) => {
      if (callerPid === null) {
        pidReject(new Error(`statement caller closed before PID: ${stderr}`));
      }
      resolvePromise({ code });
    });
  });
  child.stdin.write(
    `\\set ON_ERROR_STOP on\n\\set VERBOSITY verbose\nSELECT 'A4_STATEMENT_PID|'||pg_backend_pid();\n`,
  );
  let startedAt;
  try {
    await bounded(pidReady, 5_000, "statement caller PID readiness");
    startedAt = Date.now();
    child.stdin.end(`BEGIN;
      ${scenario.skipFixture ? "" : fixtureSql(scenario.fixture)}
      CREATE TEMP TABLE a4_statement_observed(
        stage text PRIMARY KEY,value jsonb NOT NULL
      ) ON COMMIT DROP;
      GRANT SELECT,INSERT ON a4_statement_observed TO app_user;
      SET SESSION AUTHORIZATION app_user;
      SET LOCAL lock_timeout='${scenario.lockTimeout ?? "5s"}';
      SET LOCAL statement_timeout='${scenario.statementTimeout ?? "60s"}';
      SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
      INSERT INTO a4_statement_observed VALUES (
        'preA',${semanticStateSql(WORKSPACE_A)}
      );
      INSERT INTO a4_statement_observed VALUES (
        'preAFull',${fullStateSql(WORKSPACE_A)}
      );
      SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
      INSERT INTO a4_statement_observed VALUES (
        'preBFull',${fullStateSql(WORKSPACE_B)}
      );
      SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
      SAVEPOINT a4_statement_call;
      \\set ON_ERROR_STOP off
      SELECT * FROM public.resolve_organization_identity_for_raw_v1(
        '${WORKSPACE_A}','${scenario.rawRecordId ?? RAW_A}'
      );
      \\echo A4_ERROR_SQLSTATE|:LAST_ERROR_SQLSTATE
      ROLLBACK TO SAVEPOINT a4_statement_call;
      \\set ON_ERROR_STOP on
      SET LOCAL client_min_messages='error';
      INSERT INTO a4_statement_observed VALUES (
        'stageFired',${stageReceipt}
      );
      INSERT INTO a4_statement_observed VALUES (
        'postA',${semanticStateSql(WORKSPACE_A)}
      );
      INSERT INTO a4_statement_observed VALUES (
        'postAFull',${fullStateSql(WORKSPACE_A)}
      );
      SELECT set_config('app.current_workspace_id','${WORKSPACE_B}',true);
      INSERT INTO a4_statement_observed VALUES (
        'postBFull',${fullStateSql(WORKSPACE_B)}
      );
      SELECT jsonb_object_agg(stage,value ORDER BY stage)::text
      FROM a4_statement_observed;
      ROLLBACK;`);
    const result = await bounded(
      completion,
      scenario.processTimeout,
      "statement caller process guard",
    );
    assert.equal(result.code, 0, `${stdout}\n${stderr}`);
    const stateMatch = stdout.match(/A4_ERROR_SQLSTATE\|([0-9A-Z]{5})/u);
    const jsonLine = stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith("{"));
    assert.ok(stateMatch, `statement caller emitted no SQLSTATE:\n${stdout}`);
    assert.ok(
      jsonLine,
      `statement caller emitted no full readback:\n${stdout}`,
    );
    const diagnostics = parseVerboseDiagnostics(stderr, stateMatch[1]);
    return {
      elapsedMs: Date.now() - startedAt,
      outcome: error(stateMatch[1], diagnostics.message),
      diagnostics,
      observed: JSON.parse(jsonLine),
      output: stderr,
      callerPid,
    };
  } catch (cause) {
    if (callerPid !== null) terminateExactBackend(callerPid);
    child.kill("SIGTERM");
    try {
      await bounded(completion, 3_000, "statement forced completion");
    } catch {
      // The exact PID cleanup below is the authoritative terminal check.
    }
    throw cause;
  } finally {
    if (callerPid !== null) assertBackendCleanup(callerPid);
    else assertApplicationCleanup("a4-statement-caller");
  }
}

function assertHardTimeoutResult(result, expectedPre, options = {}) {
  assert.deepEqual(result.observed.preA, expectedPre);
  assertFullColumns(result.observed.preAFull);
  assertSentinel(result.observed.preBFull);
  assert.deepEqual(result.observed.postAFull, result.observed.preAFull);
  assert.deepEqual(result.observed.postBFull, result.observed.preBFull);
  assert.equal(result.observed.stageFired, true);
  assertVerboseDiagnosticShape(result.diagnostics);
  assert.deepEqual(result.outcome, {
    kind: "error",
    sqlstate: "57014",
    message: "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
  });
  for (const forbidden of [
    "canceling statement due to statement timeout",
    "DETAIL:",
    "HINT:",
    "fixture.invalid",
    "pg_sleep",
    WORKSPACE_A,
    RAW_A,
    COMPANY_A,
    ...(options.forbidden ?? []),
  ]) {
    assert.equal(result.output.includes(forbidden), false);
  }
  assert.ok(
    result.elapsedMs >= (options.minimumMs ?? 400) &&
      result.elapsedMs < (options.maximumMs ?? 4_000),
    `caller-prearmed hard timeout was outside bounds: ${result.elapsedMs}`,
  );
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
const CREATE_FULL_POST = fullState({
  raws: [rawFull(RAW_CREATE)],
  companies: [
    companyFull(COMPANY_CREATE_RESULT, COMMAND_JSON_TIME),
    companyFull(COMPANY_FORGED_STATE),
  ],
  identifiers: [
    commandIdentifierFullValue(
      CREATED_REGISTRY_IDENTIFIER_C,
      IDENTIFIER_CREATED,
    ),
  ],
  links: [
    commandLinkFullValue(
      link({ canonicalId: COMPANY_C, inputHash: INPUT_CREATE }),
      COMMAND_LINK_C,
    ),
  ],
});
const LAZY_FULL_POST = fullState({
  raws: [rawFull(RAW_LAZY)],
  companies: [companyFull(COMPANY_LAZY), companyFull(COMPANY_FORGED_STATE)],
  links: [
    commandLinkFullValue(
      link({
        matchRule: "name_country",
        confidence: 0.8,
        inputHash: INPUT_LAZY,
      }),
      COMMAND_LINK_A,
    ),
  ],
});
const BIND_FULL_POST = fullState({
  raws: [rawFull(RAW_CREATE)],
  companies: [companyFull(COMPANY_A_BASE), companyFull(COMPANY_FORGED_STATE)],
  identifiers: [refreshedIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
  links: [commandLinkFullValue(link(), COMMAND_LINK_A)],
});
const DIRECT_CONFLICT_FULL_POST = fullState({
  raws: [rawFull(RAW_CREATE)],
  companies: [
    companyFull(COMPANY_A_BASE),
    companyFull(COMPANY_B_BLOCKER),
    companyFull(COMPANY_FORGED_STATE),
  ],
  identifiers: [fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
  conflicts: [conflictFull(conflictState(), COMMAND_JSON_TIME)],
  parties: [
    commandPartyFullValue(party(COMPANY_A)),
    commandPartyFullValue(party(COMPANY_B)),
  ],
  links: [
    commandLinkFullValue(
      link({
        canonicalId: COMPANY_A,
        matchRule: "identity_conflict",
        confidence: 0,
        status: "PENDING_CONFLICT",
        inputHash: INPUT_DISAGREEMENT_A,
        conflictId: CONFLICT,
      }),
      COMMAND_LINK_A,
    ),
    commandLinkFullValue(
      link({
        canonicalId: COMPANY_B,
        matchRule: "identity_conflict",
        confidence: 0,
        status: "PENDING_CONFLICT",
        inputHash: INPUT_DISAGREEMENT_A,
        conflictId: CONFLICT,
      }),
      COMMAND_LINK_B,
    ),
  ],
});

describe("Organization Identity direct-command malicious app_user matrix", () => {
  const directCases = [
    {
      name: "forged-plan create state cannot select an arbitrary existing target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_FORGED_STATE],
        extraSql: deterministicWritesSql(),
      },
      expectedPre: CREATE_PRE,
      expectedOutcome: createdResult({
        companyId: COMPANY_C,
        matchRule: "identity_v2",
        inputHash: INPUT_CREATE,
        identifierCount: 1,
      }),
      expectedPost: CREATE_POST,
      expectedFullPost: CREATE_FULL_POST,
    },
    {
      name: "forged-plan lazy state derives the exact blocker target",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY, COMPANY_FORGED_STATE],
        extraSql: deterministicWritesSql(),
      },
      expectedPre: LAZY_PRE,
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "name_country",
        inputHash: INPUT_LAZY,
      }),
      expectedPost: LAZY_POST,
      expectedFullPost: LAZY_FULL_POST,
    },
    {
      name: "forged-plan bind state derives the live authority target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        extraSql: deterministicWritesSql(),
      },
      expectedPre: BIND_PRE,
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "identity_v2",
        inputHash: INPUT_BIND,
        identifierCount: 1,
      }),
      expectedPost: BIND_POST,
      expectedFullPost: BIND_FULL_POST,
    },
    {
      name: "forged-plan disagreement derives conflict rather than caller target",
      fixture: {
        raws: [RAW_CREATE],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER, COMPANY_FORGED_STATE],
        identifiers: [REGISTRY_IDENTIFIER_A],
        extraSql: deterministicWritesSql(),
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
      expectedFullPost: DIRECT_CONFLICT_FULL_POST,
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
  const legacyIdentifierLink = link({
    matchRule: "identifier_exact",
    confidence: 1,
    resolverVersion: "identity-v1",
    inputHash: "legacy",
  });
  const v2Link = link();
  const activeCompanyC = link({ canonicalId: COMPANY_C });
  const legacyFullPost = fullState({
    raws: [rawFull(RAW_LAZY)],
    companies: [companyFull(COMPANY_LAZY)],
    links: [fixtureLinkFullValue(legacyLink, 0)],
  });
  const mappedLegacySuppressedFullPost = fullState({
    raws: [rawFull(RAW_LEGACY_IDENTIFIER)],
    companies: [
      companyFull(COMPANY_LEGACY_IDENTIFIER),
      companyFull(COMPANY_C_SUPPRESSED),
    ],
    links: [fixtureLinkFullValue(legacyIdentifierLink, 0)],
    mappings: [
      mappingFullValue(mapping(COMPANY_A, COMPANY_C), 0),
    ],
  });
  const v2ReplayFullPost = fullState({
    raws: [rawFull(RAW_CREATE)],
    companies: [companyFull(COMPANY_A_BASE)],
    identifiers: [fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
    links: [fixtureLinkFullValue(v2Link, 0)],
  });
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
      expectedFullPost: legacyFullPost,
      expectedOutcome: legacyBoundResult({
        companyId: COMPANY_A,
        matchRule: "name_country",
      }),
      expectNoWrite: true,
      expectedPost: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
      }),
    },
    {
      name: "legacy identifier fallback applies suppression to its mapped root",
      fixture: {
        raws: [RAW_LEGACY_IDENTIFIER],
        companies: [COMPANY_LEGACY_IDENTIFIER, COMPANY_C_SUPPRESSED],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [COMPANY_LEGACY_IDENTIFIER, COMPANY_C_SUPPRESSED],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
      expectedOutcome: suppressedResult(),
      expectNoWrite: true,
      expectedPost: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [COMPANY_LEGACY_IDENTIFIER, COMPANY_C_SUPPRESSED],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
      expectedFullPost: mappedLegacySuppressedFullPost,
    },
    {
      name: "legacy identifier fallback rejects an A to B to C mapping chain",
      fixture: {
        raws: [RAW_LEGACY_IDENTIFIER],
        companies: [
          COMPANY_LEGACY_IDENTIFIER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        links: [legacyIdentifierLink],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [
          COMPANY_LEGACY_IDENTIFIER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        links: [legacyIdentifierLink],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [
          COMPANY_LEGACY_IDENTIFIER,
          COMPANY_C_ROOT,
          COMPANY_D_ROOT,
        ],
        links: [legacyIdentifierLink],
        mappings: [
          mapping(COMPANY_A, COMPANY_C),
          mapping(COMPANY_C, COMPANY_D),
        ],
      }),
    },
    {
      name: "legacy identifier fallback rejects a missing mapped root",
      fixture: {
        raws: [RAW_LEGACY_IDENTIFIER],
        companies: [COMPANY_LEGACY_IDENTIFIER],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [COMPANY_LEGACY_IDENTIFIER],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_LEGACY_IDENTIFIER)],
        companies: [COMPANY_LEGACY_IDENTIFIER],
        links: [legacyIdentifierLink],
        mappings: [mapping(COMPANY_A, COMPANY_C)],
      }),
    },
    {
      name: "legacy target drift is rejected after deterministic blocker revalidation",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
      },
      expectedPre: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
      }),
    },
    {
      name: "ambiguous multiple legacy links are rejected without arbitrary readback",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          legacyLink,
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
        bypassTriggers: true,
      },
      expectedPre: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          legacyLink,
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY, COMPANY_C_ROOT],
        links: [
          legacyLink,
          link({
            canonicalId: COMPANY_C,
            matchRule: "name_country",
            confidence: 0.8,
            resolverVersion: "identity-v1",
            inputHash: "legacy",
          }),
        ],
      }),
    },
    {
      name: "legacy replay checks current suppression before read-only receipt",
      fixture: {
        raws: [RAW_LAZY],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
        suppressions: [
          {
            type: "company_name",
            value: "a4 lazy gmbh",
            protectionClass: "LEGAL",
          },
        ],
      },
      expectedPre: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
        suppressions: [
          {
            type: "company_name",
            value: "a4 lazy gmbh",
            protectionClass: "LEGAL",
          },
        ],
      }),
      expectedOutcome: suppressedResult(),
      expectNoWrite: true,
      expectedPost: state({
        raws: [rawView(RAW_LAZY)],
        companies: [COMPANY_LAZY],
        links: [legacyLink],
        suppressions: [
          {
            type: "company_name",
            value: "a4 lazy gmbh",
            protectionClass: "LEGAL",
          },
        ],
      }),
      expectedFullPost: fullState({
        raws: [rawFull(RAW_LAZY)],
        companies: [companyFull(COMPANY_LAZY)],
        links: [fixtureLinkFullValue(legacyLink, 0)],
        suppressions: [
          suppressionFullValue(
            {
              type: "company_name",
              value: "a4 lazy gmbh",
              protectionClass: "LEGAL",
            },
            0,
          ),
        ],
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
      expectedFullPost: v2ReplayFullPost,
      expectedOutcome: boundResult({
        companyId: COMPANY_A,
        matchRule: "identity_v2",
        inputHash: INPUT_BIND,
        replayed: true,
        identifierCount: 1,
      }),
      expectNoWrite: true,
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
      expectedOutcome: suppressedResult(),
      expectNoWrite: true,
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
      expectedFullPost: fullState({
        raws: [rawFull(RAW_CREATE)],
        companies: [companyFull(COMPANY_A_BASE)],
        identifiers: [fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
        links: [fixtureLinkFullValue(v2Link, 0)],
        suppressions: [
          suppressionFullValue(
            {
              type: "company_name",
              value: "a4 create gmbh",
              protectionClass: "LEGAL",
            },
            0,
          ),
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
  const rootSplitLinks = [
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
  ];
  const splitFullPost = fullState({
    raws: [rawFull(RAW_SPLIT)],
    companies: [companyFull(COMPANY_A_BASE), companyFull(COMPANY_B_BLOCKER)],
    identifiers: [
      fixtureIdentifierFullValue(DOMAIN_IDENTIFIER_A),
      fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_B),
    ],
    conflicts: [conflictFull(SPLIT_CONFLICT, COMMAND_JSON_TIME)],
    parties: [
      commandPartyFullValue(party(COMPANY_A)),
      commandPartyFullValue(party(COMPANY_B)),
    ],
    links: [
      commandLinkFullValue(splitLinks[0], COMMAND_LINK_A),
      commandLinkFullValue(splitLinks[1], COMMAND_LINK_B),
    ],
  });
  const rootSplitFullPost = fullState({
    raws: [rawFull(RAW_SPLIT)],
    companies: [
      companyFull(COMPANY_A_BASE),
      companyFull(COMPANY_B_BLOCKER),
      companyFull(COMPANY_C_ROOT),
      companyFull(COMPANY_D_ROOT),
    ],
    identifiers: [
      fixtureIdentifierFullValue(DOMAIN_IDENTIFIER_A),
      fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_B),
    ],
    conflicts: [conflictFull(SPLIT_ROOT_CONFLICT, COMMAND_JSON_TIME)],
    parties: [
      commandPartyFullValue(party(COMPANY_C)),
      commandPartyFullValue(party(COMPANY_D)),
    ],
    links: [
      commandLinkFullValue(rootSplitLinks[0], COMMAND_LINK_C),
      commandLinkFullValue(rootSplitLinks[1], COMMAND_LINK_D),
    ],
    mappings: [
      mappingFullValue(mapping(COMPANY_A, COMPANY_C), 0),
      mappingFullValue(mapping(COMPANY_B, COMPANY_D), 1),
    ],
  });
  const exactConflictFullPost = fullState({
    raws: [rawFull(RAW_CREATE)],
    companies: [companyFull(COMPANY_A_BASE), companyFull(COMPANY_B_BLOCKER)],
    identifiers: [fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
    conflicts: [conflictFull(DISAGREEMENT_CONFLICT)],
    parties: DISAGREEMENT_PARTIES.map(fixturePartyFullValue),
    links: DISAGREEMENT_LINKS_A.map(fixtureLinkFullValue),
  });
  const secondRawFullPost = fullState({
    raws: [rawFull(RAW_CREATE), rawFull(RAW_CREATE_B)],
    companies: [companyFull(COMPANY_A_BASE), companyFull(COMPANY_B_BLOCKER)],
    identifiers: [fixtureIdentifierFullValue(REGISTRY_IDENTIFIER_A)],
    conflicts: [conflictFull(DISAGREEMENT_CONFLICT)],
    parties: DISAGREEMENT_PARTIES.map(fixturePartyFullValue),
    links: [
      ...DISAGREEMENT_LINKS_A.map(fixtureLinkFullValue),
      commandLinkFullValue(
        link({
          canonicalId: COMPANY_A,
          rawRecordId: RAW_B,
          matchRule: "identity_conflict",
          confidence: 0,
          status: "PENDING_CONFLICT",
          inputHash: INPUT_DISAGREEMENT_B,
          conflictId: CONFLICT,
        }),
        COMMAND_LINK_B_A,
      ),
      commandLinkFullValue(
        link({
          canonicalId: COMPANY_B,
          rawRecordId: RAW_B,
          matchRule: "identity_conflict",
          confidence: 0,
          status: "PENDING_CONFLICT",
          inputHash: INPUT_DISAGREEMENT_B,
          conflictId: CONFLICT,
        }),
        COMMAND_LINK_B_B,
      ),
    ],
  });
  const conflictCases = [
    {
      name: "identifier split derives the exact facts, parties and links",
      fixture: {
        ...splitBase,
        extraSql: deterministicWritesSql(),
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
      expectedFullPost: splitFullPost,
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
        extraSql: deterministicWritesSql(),
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
      expectedFullPost: rootSplitFullPost,
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
      expectNoWrite: true,
      expectedPost: DISAGREEMENT_REPLAY_PRE,
      expectedFullPost: exactConflictFullPost,
    },
    {
      name: "stored conflict owner with zero occurrence links is never repaired",
      fixture: {
        ...DISAGREEMENT_BASE,
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
      }),
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
        extraSql: deterministicWritesSql(),
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
      expectedFullPost: secondRawFullPost,
    },
    {
      name: "equivalent second Raw rejects a damaged owner occurrence receipt",
      rawRecordId: RAW_B,
      fixture: {
        raws: [RAW_CREATE, RAW_CREATE_B],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [DISAGREEMENT_LINKS_A[0]],
      },
      expectedPre: state({
        raws: [rawView(RAW_CREATE), rawView(RAW_CREATE_B)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [DISAGREEMENT_LINKS_A[0]],
      }),
      expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
      expectedPost: state({
        raws: [rawView(RAW_CREATE), rawView(RAW_CREATE_B)],
        companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
        identifiers: [REGISTRY_IDENTIFIER_A],
        conflicts: [DISAGREEMENT_CONFLICT],
        parties: DISAGREEMENT_PARTIES,
        links: [DISAGREEMENT_LINKS_A[0]],
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
        links: DISAGREEMENT_LINKS_A,
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
        links: DISAGREEMENT_LINKS_A,
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
        links: DISAGREEMENT_LINKS_A,
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

describe("Organization Identity prearmed timeout and fault rollback matrix", () => {
  const createOnlyPreimage = state({ raws: [rawView(RAW_CREATE)] });
  const disagreementPreimage = state({
    raws: [rawView(RAW_CREATE)],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [REGISTRY_IDENTIFIER_A],
  });
  const multiIdentifierPreimage = state({ raws: [rawView(RAW_SPLIT)] });
  const v2ReplayFixture = {
    raws: [RAW_CREATE],
    companies: [COMPANY_A_BASE],
    identifiers: [REGISTRY_IDENTIFIER_A],
    links: [link()],
  };
  const v2ReplayPreimage = state({
    raws: [rawView(RAW_CREATE)],
    companies: [COMPANY_A_BASE],
    identifiers: [REGISTRY_IDENTIFIER_A],
    links: [link()],
  });
  const cumulativeCompanyFixture = {
    raws: [RAW_SPLIT],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
  };
  const cumulativeCompanyPreimage = state({
    raws: [rawView(RAW_SPLIT)],
    companies: [COMPANY_A_BASE, COMPANY_B_BLOCKER],
    identifiers: [DOMAIN_IDENTIFIER_A, REGISTRY_IDENTIFIER_B],
  });
  const companyAfter = afterStageFault(
    "canonical_company",
    "company_after",
    1,
    "ZX101",
    "A4_COMPANY_AFTER_FAULT",
  );
  const hiddenQueryCanceled = afterStageFault(
    "canonical_company",
    "hidden_query_canceled",
    1,
    "57014",
    "A4_HIDDEN_QUERY_CANCELED",
  );
  const hiddenAssertFailure = afterStageAssertFailure(
    "canonical_company",
    "hidden_assert_failure",
    "A4_HIDDEN_ASSERT_FAILURE",
  );
  const identifierFirst = afterStageFault(
    "organization_identifier",
    "identifier_first",
    1,
    "ZX102",
    "A4_IDENTIFIER_FIRST_FAULT",
  );
  const identifierLast = afterStageFault(
    "organization_identifier",
    "identifier_last",
    2,
    "ZX103",
    "A4_IDENTIFIER_LAST_FAULT",
  );
  const conflictAfter = afterStageFault(
    "organization_identity_conflict",
    "conflict_after",
    1,
    "ZX104",
    "A4_CONFLICT_AFTER_FAULT",
  );
  const partyFirst = afterStageFault(
    "organization_identity_conflict_party",
    "party_first",
    1,
    "ZX105",
    "A4_PARTY_FIRST_FAULT",
  );
  const partyFinal = afterStageFault(
    "organization_identity_conflict_party",
    "party_final",
    2,
    "ZX106",
    "A4_PARTY_FINAL_FAULT",
  );
  const linkFirst = afterStageFault(
    "identity_link",
    "link_first",
    1,
    "ZX107",
    "A4_LINK_FIRST_FAULT",
  );
  const linkFinal = afterStageFault(
    "identity_link",
    "link_final",
    2,
    "ZX108",
    "A4_LINK_FINAL_FAULT",
  );
  const fixedFault = (name, fixture, preimage, stage) => ({
    name,
    fixture: { ...fixture, extraSql: stage.sql },
    expectedPre: preimage,
    expectedOutcome: error("P0001", "IDENTITY_RESOLUTION_STATE_INVALID"),
    expectedPost: preimage,
    stageLockKey: stage.stageLockKey,
    diagnosticShape: "public_fixed",
    forbiddenPublicFragments: stage.forbidden,
  });
  const faultCases = [
    fixedFault(
      "company AFTER INSERT fault restores the complete preimage",
      { raws: [RAW_CREATE] },
      createOnlyPreimage,
      companyAfter,
    ),
    fixedFault(
      "hidden query_canceled before the deadline maps to fixed state invalid",
      { raws: [RAW_CREATE] },
      createOnlyPreimage,
      hiddenQueryCanceled,
    ),
    fixedFault(
      "hidden assert_failure maps to fixed state invalid",
      { raws: [RAW_CREATE] },
      createOnlyPreimage,
      hiddenAssertFailure,
    ),
    fixedFault(
      "identifier first AFTER INSERT fault restores company and identifier preimage",
      { raws: [RAW_SPLIT] },
      multiIdentifierPreimage,
      identifierFirst,
    ),
    fixedFault(
      "identifier last AFTER INSERT fault restores both identifiers and company",
      { raws: [RAW_SPLIT] },
      multiIdentifierPreimage,
      identifierLast,
    ),
    fixedFault(
      "conflict AFTER INSERT fault restores the disagreement preimage",
      DISAGREEMENT_BASE,
      disagreementPreimage,
      conflictAfter,
    ),
    fixedFault(
      "party first AFTER INSERT fault restores conflict and party preimage",
      DISAGREEMENT_BASE,
      disagreementPreimage,
      partyFirst,
    ),
    fixedFault(
      "party final AFTER INSERT fault restores the complete party set",
      DISAGREEMENT_BASE,
      disagreementPreimage,
      partyFinal,
    ),
    fixedFault(
      "link first AFTER INSERT fault restores conflict parties and link preimage",
      DISAGREEMENT_BASE,
      disagreementPreimage,
      linkFirst,
    ),
    fixedFault(
      "final link AFTER INSERT fault restores the full conflict occurrence",
      DISAGREEMENT_BASE,
      disagreementPreimage,
      linkFinal,
    ),
  ];
  for (const scenario of faultCases) {
    it(scenario.name, () => assertScenario(scenario));
  }

  it("prearmed lock bound times out behind a real second connection", async () => {
    const holder = startHolder(
      `SELECT pg_advisory_xact_lock(hashtextextended(
        'acquisition-suppression-policy:${WORKSPACE_A}',0
      ))`,
    );
    try {
      await holder.ready;
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

  it("hard statement timer cancels a blocked pre-write table read", async () => {
    const holder = startHolder(
      "LOCK TABLE raw_source_governance_disposition IN ACCESS EXCLUSIVE MODE",
    );
    try {
      await holder.ready;
      const result = await runStatementScenario({
        fixture: { raws: [RAW_CREATE] },
        lockTimeout: "5s",
        statementTimeout: "750ms",
        processTimeout: 4_000,
      });
      assertHardTimeoutResult(result, createOnlyPreimage, {
        minimumMs: 500,
        maximumMs: 2_500,
      });
    } finally {
      await holder.release();
    }
  });

  it("hard statement timer cancels a blocked Raw row read", async () => {
    seedCommittedFixture({ raws: [RAW_CREATE] });
    const holder = startHolder(`SELECT 1 FROM raw_source_record
      WHERE workspace_id='${WORKSPACE_A}' AND id='${RAW_A}' FOR UPDATE`);
    try {
      await holder.ready;
      const result = await runStatementScenario({
        skipFixture: true,
        lockTimeout: "5s",
        statementTimeout: "750ms",
        processTimeout: 4_000,
      });
      assertHardTimeoutResult(result, createOnlyPreimage, {
        minimumMs: 500,
        maximumMs: 2_500,
      });
    } finally {
      await holder.release();
      cleanupCommittedFixture();
    }
  });

  it("hard statement timer bounds cumulative UUID-ordered company locks", async () => {
    seedCommittedFixture(cumulativeCompanyFixture);
    const firstHolder = startHolder(`SELECT 1 FROM canonical_company
      WHERE workspace_id='${WORKSPACE_A}' AND id='${COMPANY_A}' FOR UPDATE`);
    const finalHolder = startHolder(`SELECT 1 FROM canonical_company
      WHERE workspace_id='${WORKSPACE_A}' AND id='${COMPANY_B}' FOR UPDATE`);
    let firstReleased = false;
    try {
      await Promise.all([firstHolder.ready, finalHolder.ready]);
      const scenario = runStatementScenario({
        skipFixture: true,
        lockTimeout: "900ms",
        statementTimeout: "1200ms",
        processTimeout: 4_000,
      });
      await delay(650);
      await firstHolder.release();
      firstReleased = true;
      const result = await scenario;
      assertHardTimeoutResult(result, cumulativeCompanyPreimage, {
        minimumMs: 950,
        maximumMs: 3_000,
      });
    } finally {
      if (!firstReleased) await firstHolder.release();
      await finalHolder.release();
      cleanupCommittedFixture();
    }
  });

  it("hard statement timer cancels a blocked replay-return read", async () => {
    seedCommittedFixture(v2ReplayFixture);
    const holder = startHolder(`SELECT 1 FROM identity_link
      WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_A}'
      FOR UPDATE`);
    try {
      await holder.ready;
      const result = await runStatementScenario({
        skipFixture: true,
        lockTimeout: "5s",
        statementTimeout: "750ms",
        processTimeout: 4_000,
      });
      assertHardTimeoutResult(result, v2ReplayPreimage, {
        minimumMs: 500,
        maximumMs: 2_500,
      });
    } finally {
      await holder.release();
      cleanupCommittedFixture();
    }
  });

  it("prearmed sixty-second hard timer returns a fixed no-leak token", async () => {
    const stageLockKey = "a4-hidden-stage:statement_timeout";
    const slowTrigger = `CREATE FUNCTION pg_temp.a4_slow_company()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${stageLockKey}',0));
        PERFORM pg_sleep(61);
        RETURN NEW;
      END $$;
      CREATE TRIGGER a4_slow_company AFTER INSERT ON canonical_company
      FOR EACH ROW EXECUTE FUNCTION pg_temp.a4_slow_company();`;
    const result = await runStatementScenario({
      fixture: { raws: [RAW_CREATE], extraSql: slowTrigger },
      processTimeout: 66_000,
      stageLockKey,
    });
    assert.deepEqual(result.observed.preA, createOnlyPreimage);
    assertFullColumns(result.observed.preAFull);
    assertSentinel(result.observed.preBFull);
    assert.deepEqual(result.observed.postAFull, result.observed.preAFull);
    assert.deepEqual(result.observed.postBFull, result.observed.preBFull);
    assertVerboseDiagnosticShape(result.diagnostics);
    for (const forbidden of [
      "canceling statement due to statement timeout",
      "DETAIL:",
      "HINT:",
      "fixture.invalid",
      "A4_STATEMENT_HIDDEN_FAULT",
      "ZX109",
      "not-a-uuid-a4",
      "a4_slow_company",
      "pg_sleep",
      WORKSPACE_A,
      RAW_A,
      COMPANY_A,
    ]) {
      assert.equal(result.output.includes(forbidden), false);
    }
    const desired = {
      kind: "error",
      sqlstate: "57014",
      message: "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    };
    if (
      !isDeepStrictEqual(result.outcome, desired) ||
      result.observed.stageFired !== true
    ) {
      assert.fail(
        [
          "A4_EXPECTED_BEHAVIOR_MISMATCH",
          `actual=${JSON.stringify(result.outcome)}`,
          `desired=${JSON.stringify(desired)}`,
          `stageFired=${result.observed.stageFired}`,
          `fullPreimageExact=${isDeepStrictEqual(
            result.observed.postAFull,
            result.observed.preAFull,
          )}`,
          `workspaceBSentinelExact=${isDeepStrictEqual(
            result.observed.postBFull,
            result.observed.preBFull,
          )}`,
        ].join("|"),
      );
    }
    assert.ok(
      result.elapsedMs >= 55_000 && result.elapsedMs < 66_000,
      `function-owned statement timeout was not bounded: ${result.elapsedMs}`,
    );
  });
});
