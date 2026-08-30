import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260830130000_discovery_query_lineage_schema/migration.sql',
  import.meta.url,
);
const TABLES = [
  'discovery_query_receipt',
  'discovery_query_operation_attempt',
  'discovery_query_attempt_item',
] as const;

function compact(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ',').replace(/\(\s*/gu, '(').replace(/\s*\)/gu, ')')
    .trim().toLowerCase();
}

function validate(sql: string): void {
  const normalized = compact(sql);
  for (const table of TABLES) {
    if (!normalized.includes(`create table public.${table}`)) throw new Error(`MISSING_${table}`);
    if (!normalized.includes(`alter table public.${table} enable row level security`) ||
      !normalized.includes(`alter table public.${table} force row level security`)) {
      throw new Error(`RLS_${table}`);
    }
    if (!/workspace_id\s*=\s*public\.current_workspace_id\(\)/u.test(normalized)) {
      throw new Error(`POLICY_${table}`);
    }
    if (!normalized.includes(`revoke all on table public.${table} from public`)) {
      throw new Error(`REVOKE_${table}`);
    }
    if (!normalized.includes(`grant select on table public.${table} to app_user`)) {
      throw new Error(`SELECT_${table}`);
    }
  }
  for (const required of [
    'primary key (workspace_id,run_id,query_key)',
    'unique (workspace_id,run_id,query_ordinal)',
    'references public.discovery_run(workspace_id,id)',
    "purpose='discovery.run'",
    "subject_type='discovery_run'",
    "subject_id='request:'||request_sha256",
    'query_ordinal between 0 and 1023',
    'jsonb_array_length(providers)',
    'provider_count between 0 and 16',
    'record_count between 0 and 524160',
    'cost_cents between 0 and 1000000000',
    'primary key (workspace_id,operation_id)',
    'primary key (id)',
    'covered_item_count between 0 and least(provider_record_count,4095)',
    'references public.tool_budget_operation(scope_key,id)',
    'references public.execution_domain_ack(ack_id)',
    'unique (workspace_id,run_id,query_key,provider_key,record_index)',
    'unique (workspace_id,operation_id,relation_key)',
    'references public.raw_source_record(workspace_id,id)',
    "resolution_kind in ('inserted','existing','reuse_batch')",
    "raw_ingest_status in ('accepted','quarantined','rejected')",
    'source_record_index < record_index',
  ]) if (!normalized.includes(required)) throw new Error(`MISSING_CONTRACT_${required}`);
  if (/(canonical_company|identity_link|opportunity)/iu.test(sql)) {
    throw new Error('FORBIDDEN_OWNERSHIP');
  }
  if (/grant\s+(?:insert|update|delete|all)[^;]*to\s+app_user/iu.test(sql)) {
    throw new Error('APP_DML_EXPOSED');
  }
}

function fixture(): string {
  return TABLES.map((table) => `CREATE TABLE public.${table} (
    workspace_id uuid, run_id uuid, query_key char(64), query_ordinal integer,
    provider_key varchar(128), operation_id uuid, record_index integer,
    relation_key varchar(192), scope_key varchar(128), id uuid, ack_id char(64),
    raw_record_id uuid, request_sha256 char(64), purpose varchar(64),
    subject_type varchar(80), subject_id varchar(200), providers jsonb,
    provider_count integer, record_count bigint, cost_cents bigint,
    covered_item_count integer, provider_record_count integer,
    resolution_kind varchar(32), raw_ingest_status varchar(32), source_record_index integer,
    ${table === 'discovery_query_receipt' ? 'PRIMARY KEY (workspace_id,run_id,query_key),' :
      table === 'discovery_query_operation_attempt' ? 'PRIMARY KEY (workspace_id,operation_id),' :
      'PRIMARY KEY (id),' }
    UNIQUE (workspace_id, run_id, query_ordinal),
    UNIQUE (workspace_id, run_id, query_key, provider_key, record_index),
    UNIQUE (workspace_id, operation_id, relation_key),
    FOREIGN KEY (workspace_id,run_id) REFERENCES public.discovery_run(workspace_id,id),
    FOREIGN KEY (scope_key,id) REFERENCES public.tool_budget_operation(scope_key,id),
    FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id),
    FOREIGN KEY (workspace_id,raw_record_id) REFERENCES public.raw_source_record(workspace_id,id),
    CHECK (purpose='discovery.run'), CHECK (subject_type='discovery_run'),
    CHECK (subject_id='request:'||request_sha256), CHECK (query_ordinal BETWEEN 0 AND 1023),
    CHECK (provider_count=jsonb_array_length(providers)), CHECK (provider_count BETWEEN 0 AND 16),
    CHECK (record_count BETWEEN 0 AND 524160), CHECK (cost_cents BETWEEN 0 AND 1000000000),
    CHECK (covered_item_count BETWEEN 0 AND LEAST(provider_record_count,4095)),
    CHECK (resolution_kind IN ('INSERTED','EXISTING','REUSE_BATCH')),
    CHECK (raw_ingest_status IN ('ACCEPTED','QUARANTINED','REJECTED')),
    CHECK (source_record_index < record_index));
    ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_workspace ON public.${table}
      USING (workspace_id=public.current_workspace_id())
      WITH CHECK (workspace_id=public.current_workspace_id());
    REVOKE ALL ON TABLE public.${table} FROM PUBLIC;
    GRANT SELECT ON TABLE public.${table} TO app_user;`).join('\n');
}

describe('Discovery query lineage schema migration', () => {
  it('mutation-proves table, RLS, FK, check and ownership validation', () => {
    const valid = fixture();
    expect(() => validate(valid)).not.toThrow();
    expect(() => validate(valid.replace('FORCE ROW LEVEL SECURITY', ''))).toThrow();
    expect(() => validate(valid.replaceAll('REFERENCES public.execution_domain_ack(ack_id)', '')))
      .toThrow();
    expect(() => validate(`${valid}\nCREATE TABLE canonical_company_shadow(id uuid);`))
      .toThrow('FORBIDDEN_OWNERSHIP');
    expect(() => validate(`${valid}\nGRANT INSERT ON discovery_query_receipt TO app_user;`))
      .toThrow('APP_DML_EXPOSED');
  });

  it('requires only the additive 20260830130000 schema migration', async () => {
    let sql: string;
    try {
      sql = await readFile(migrationUrl, 'utf8');
    } catch {
      throw new Error('DISCOVERY_QUERY_LINEAGE_SCHEMA_MIGRATION_MISSING');
    }
    validate(sql);
  });
});
