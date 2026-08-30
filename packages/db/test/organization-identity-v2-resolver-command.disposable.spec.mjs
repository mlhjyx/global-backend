import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

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
const migrationName =
  "20260830090000_organization_identity_v2_resolver_command";
const migrationChecksum =
  "3bf6e58db819352ca0777380e9adb2fbf32ca9eeb311b91df696b569302da7af";
const migrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations",
  migrationName,
  "migration.sql",
);
const frozenMigrations = Object.freeze([
  [
    "20260829090000_organization_identity_v2_expand_ddl/migration.sql",
    "2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119",
  ],
  [
    "20260829091000_organization_identity_v2_legacy_link_backfill_dml/migration.sql",
    "d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426",
  ],
  [
    "20260829092000_organization_identity_v2_contract_ddl/migration.sql",
    "1d8368c81f7af17dcb96999d23a4cd35d387436282935c20eb11befcb8c08396",
  ],
]);
const WORKSPACE_A = "31000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "31000000-0000-4000-8000-000000000002";
const RAW_A = "32000000-0000-4000-8000-000000000001";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 10_000,
    input: options.input,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function dockerPsql(sql, { appUser = false } = {}) {
  const args = [
    "exec",
    "-i",
    container,
    "psql",
    ...(appUser ? ["-U", "app_user"] : ["-U", "global"]),
    "-d",
    database,
    "--no-psqlrc",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  return run("docker", args, { input: sql });
}

function successfulSql(sql) {
  const result = dockerPsql(sql);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function typedError(sql, { appUser = false } = {}) {
  const result = dockerPsql(`\\set VERBOSITY verbose\n${sql}`, { appUser });
  assert.notEqual(result.status, 0, "SQL unexpectedly succeeded");
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/^ERROR:\s+([0-9A-Z]{5}): (.+)$/mu);
  assert.ok(match, `SQL did not emit a typed PostgreSQL error:\n${output}`);
  return Object.freeze({
    sqlstate: match[1],
    message: match[2],
    output,
  });
}

function inspectJson(kind, name, format) {
  const args = kind === "container" ? ["inspect"] : [kind, "inspect"];
  const result = run("docker", [...args, "--format", format, name]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function appCallSql({ workspaceId, rawRecordId, workspaceSetting }) {
  const setting =
    workspaceSetting === null
      ? ""
      : `SELECT set_config('app.current_workspace_id','${workspaceSetting}',true);`;
  return `BEGIN;
${setting}
SELECT * FROM public.resolve_organization_identity_for_raw_v1(
  '${workspaceId}', '${rawRecordId}'
);
ROLLBACK;`;
}

describe("Organization Identity v2 direct command A3 boundary", () => {
  it("reads back the exact A1 receipt and the frozen A3 ledger checksum", () => {
    assert.equal(sha256(readFileSync(migrationPath)), migrationChecksum);
    for (const [relativePath, checksum] of frozenMigrations) {
      assert.equal(
        sha256(
          readFileSync(
            resolve(
              repositoryRoot,
              "packages/db/prisma/migrations",
              relativePath,
            ),
          ),
        ),
        checksum,
      );
    }
    assert.deepEqual(
      inspectJson("image", "pgvector/pgvector:pg16", "{{json .}}").RepoDigests,
      [
        "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
      ],
    );
    const containerState = inspectJson("container", container, "{{json .}}");
    assert.deepEqual(
      {
        id: containerState.Id,
        image: containerState.Config.Image,
        running: containerState.State.Running,
        ports: containerState.NetworkSettings.Ports,
        labels: containerState.Config.Labels,
        mounts: containerState.Mounts,
      },
      {
        id: containerId,
        image: "pgvector/pgvector:pg16",
        running: true,
        ports: {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: port }],
        },
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
      },
    );
    const networkState = inspectJson("network", network, "{{json .}} ");
    assert.deepEqual(
      {
        id: networkState.Id,
        driver: networkState.Driver,
        labels: networkState.Labels,
        containers: networkState.Containers,
      },
      {
        id: networkId,
        driver: "bridge",
        labels: {
          "com.openai.codex.artifact": "identity-authority",
          "com.openai.codex.task": "organization-identity-command-expansion",
        },
        containers: {
          [containerId]: {
            Name: container,
            EndpointID:
              "c25c601b47456dc4a7cd2ec833abe97ac55169daf623e4089faf892163e8b92f",
            MacAddress: "72:d4:ca:6f:8e:f0",
            IPv4Address: "172.21.0.2/16",
            IPv6Address: "",
          },
        },
      },
    );
    const volumeState = inspectJson("volume", volume, "{{json .}} ");
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
    assert.equal(
      successfulSql(`SELECT migration_name||'|'||checksum||'|'||
        (finished_at IS NOT NULL)::text||'|'||
        (rolled_back_at IS NULL)::text
      FROM "_prisma_migrations"
      WHERE migration_name IN (
        '20260829090000_organization_identity_v2_expand_ddl',
        '20260829091000_organization_identity_v2_legacy_link_backfill_dml',
        '20260829092000_organization_identity_v2_contract_ddl',
        '${migrationName}'
      ) ORDER BY migration_name;`),
      [
        "20260829090000_organization_identity_v2_expand_ddl|2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119|true|true",
        "20260829091000_organization_identity_v2_legacy_link_backfill_dml|d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426|true|true",
        "20260829092000_organization_identity_v2_contract_ddl|1d8368c81f7af17dcb96999d23a4cd35d387436282935c20eb11befcb8c08396|true|true",
        `${migrationName}|${migrationChecksum}|true|true`,
      ].join("\n"),
    );
  });

  it("keeps the exact public command and private helper catalog closed", () => {
    assert.equal(
      successfulSql(`SELECT p.proname||'|'||
        pg_get_function_identity_arguments(p.oid)||'|'||
        pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||
        array_to_string(p.proconfig, ',')||'|'||
        has_function_privilege('app_user',p.oid,'EXECUTE')||'|'||
        has_function_privilege('public',p.oid,'EXECUTE')
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (
        'organization_identity_acquire_advisory_until_v1',
        'organization_identity_authority_from_raw_v1',
        'organization_identity_blocker_from_raw_v1',
        'organization_identity_canonical_suppression_value_v1',
        'organization_identity_plan_from_snapshot_v1',
        'resolve_organization_identity_for_raw_v1'
      )
      ORDER BY p.proname;`),
      [
        "organization_identity_acquire_advisory_until_v1|p_lock_key bigint, p_deadline timestamp with time zone|global|false|search_path=pg_catalog, public|false|false",
        "organization_identity_authority_from_raw_v1|p_provider_key text, p_raw jsonb|global|false|search_path=pg_catalog, public|false|false",
        "organization_identity_blocker_from_raw_v1|p_raw jsonb|global|false|search_path=pg_catalog, public|false|false",
        "organization_identity_canonical_suppression_value_v1|p_type text, p_value text|global|false|search_path=pg_catalog, public|false|false",
        "organization_identity_plan_from_snapshot_v1|p_snapshot jsonb|global|false|search_path=pg_catalog, public|false|false",
        "resolve_organization_identity_for_raw_v1|p_workspace_id text, p_raw_record_id text|global|true|search_path=pg_catalog, public,lock_timeout=5s,statement_timeout=60s,row_security=off|true|false",
      ].join("\n"),
    );
    assert.equal(
      successfulSql(`SELECT
        to_regprocedure('public.apply_organization_identity_resolution_v1(jsonb)') IS NULL,
        has_table_privilege(
          'app_user','organization_identifier','INSERT,UPDATE,DELETE'
        );`),
      "t|f",
    );
  });

  it("denies a direct owner invocation with an exact non-echoing oracle", () => {
    const error = typedError(
      appCallSql({
        workspaceId: WORKSPACE_A,
        rawRecordId: RAW_A,
        workspaceSetting: WORKSPACE_A,
      }),
    );
    assert.deepEqual(
      { sqlstate: error.sqlstate, message: error.message },
      { sqlstate: "42501", message: "IDENTITY_RESOLUTION_COMMAND_DENIED" },
    );
  });

  it("denies SET ROLE app_user because it is not the app_user session", () => {
    const error = typedError(`BEGIN;
SET ROLE app_user;
SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true);
SELECT * FROM public.resolve_organization_identity_for_raw_v1(
  '${WORKSPACE_A}', '${RAW_A}'
);
ROLLBACK;`);
    assert.deepEqual(
      { sqlstate: error.sqlstate, message: error.message },
      { sqlstate: "42501", message: "IDENTITY_RESOLUTION_COMMAND_DENIED" },
    );
  });

  it("denies an app_user invocation with no workspace GUC", () => {
    const error = typedError(
      appCallSql({
        workspaceId: WORKSPACE_A,
        rawRecordId: RAW_A,
        workspaceSetting: null,
      }),
      { appUser: true },
    );
    assert.deepEqual(
      { sqlstate: error.sqlstate, message: error.message },
      { sqlstate: "42501", message: "IDENTITY_RESOLUTION_COMMAND_DENIED" },
    );
  });

  it("denies an app_user invocation whose exact workspace GUC disagrees", () => {
    const error = typedError(
      appCallSql({
        workspaceId: WORKSPACE_A,
        rawRecordId: RAW_A,
        workspaceSetting: WORKSPACE_B,
      }),
      { appUser: true },
    );
    assert.deepEqual(
      { sqlstate: error.sqlstate, message: error.message },
      { sqlstate: "42501", message: "IDENTITY_RESOLUTION_COMMAND_DENIED" },
    );
  });

  for (const [field, workspaceId, rawRecordId] of [
    ["workspace", "not-a-uuid-a4-workspace-marker", RAW_A],
    ["Raw", WORKSPACE_A, "not-a-uuid-a4-raw-marker"],
  ]) {
    it(`rejects the malformed ${field} text marker without echo`, () => {
      const marker = field === "workspace" ? workspaceId : rawRecordId;
      const error = typedError(
        appCallSql({
          workspaceId,
          rawRecordId,
          workspaceSetting: WORKSPACE_A,
        }),
        { appUser: true },
      );
      assert.deepEqual(
        { sqlstate: error.sqlstate, message: error.message },
        { sqlstate: "P0001", message: "IDENTITY_RESOLUTION_INPUT_INVALID" },
      );
      assert.equal(error.output.includes(marker), false);
    });
  }
});
