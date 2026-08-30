import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const schemaMigrationUrl = new URL(
  'packages/db/prisma/migrations/20260830130300_discovery_company_materialization_schema/migration.sql',
  repositoryRoot,
);
const prismaSchemaUrl = new URL('packages/db/prisma/schema.prisma', repositoryRoot);
const discoveryServiceUrl = new URL(
  'apps/api/src/discovery/discovery.service.ts',
  repositoryRoot,
);
const C_TX_CONTRACT_SHA256 =
  '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';

const WORKSPACE_TABLES = [
  'discovery_company_materialization_admission',
  'discovery_company_materialization_outcome',
  'discovery_company_materialization_batch_receipt',
  'discovery_company_materialization_query_receipt',
  'discovery_company_materialization_run_receipt',
] as const;

const FROZEN_Q_MIGRATIONS = {
  '20260830130000_discovery_query_lineage_schema':
    '400053567f4c53fa61e328d0970aa85b8f0eca7caec601b70efff5c6ba5b6a2c',
  '20260830130100_discovery_query_lineage_functions':
    'd62cb9edddb16fb40fe7664d8fbb5a931a3e37ed8f3ecd695658db61c21e1db3',
  '20260830130200_discovery_query_lineage_execution_outcome':
    'a8dc0dfe7f82413405df6f0f1f1a713169a84fcea0135a77a9ab73d3291c44d1',
} as const;

function compact(value: string): string {
  return value
    .replaceAll('"', '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ',')
    .replace(/\s*\(\s*/gu, '(')
    .replace(/\s*\)/gu, ')')
    .trim()
    .toLowerCase();
}

function requireText(value: string, fragment: string, code: string): void {
  if (!value.includes(fragment)) throw new Error(code);
}

function validateMaterializationSchemaMigration(sql: string): void {
  const normalized = compact(sql);
  requireText(
    normalized,
    'alter table public.discovery_run add column materialization_contract_version',
    'C_TX_RUN_MARKER_COLUMN_MISSING',
  );
  requireText(
    normalized,
    'discovery-company-materialization/v1',
    'C_TX_RUN_MARKER_ALLOWLIST_MISSING',
  );
  requireText(normalized, 'before insert on public.discovery_run', 'C_TX_RUN_INSERT_GUARD_MISSING');
  requireText(normalized, 'before update on public.discovery_run', 'C_TX_RUN_MARKER_IMMUTABILITY_MISSING');

  requireText(
    normalized,
    'create table public.discovery_company_materialization_activation',
    'C_TX_ACTIVATION_TABLE_MISSING',
  );
  requireText(normalized, 'activation_id smallint', 'C_TX_ACTIVATION_SINGLETON_ID_MISSING');
  requireText(normalized, 'check(activation_id=1)', 'C_TX_ACTIVATION_SINGLETON_CHECK_MISSING');
  requireText(
    normalized,
    'discovery_company_materialization_activation_immutable',
    'C_TX_ACTIVATION_IMMUTABILITY_MISSING',
  );
  if (/insert\s+into\s+public\.discovery_company_materialization_activation/iu.test(sql)) {
    throw new Error('C_TX_RELEASE_A_MUST_NOT_ACTIVATE');
  }

  for (const table of WORKSPACE_TABLES) {
    requireText(normalized, `create table public.${table}`, `C_TX_TABLE_MISSING_${table}`);
    requireText(
      normalized,
      `alter table public.${table} enable row level security`,
      `C_TX_RLS_ENABLE_MISSING_${table}`,
    );
    requireText(
      normalized,
      `alter table public.${table} force row level security`,
      `C_TX_RLS_FORCE_MISSING_${table}`,
    );
    requireText(
      normalized,
      `grant select on table public.${table} to app_user`,
      `C_TX_APP_SELECT_MISSING_${table}`,
    );
    requireText(normalized, `${table}_immutable`, `C_TX_IMMUTABILITY_MISSING_${table}`);
  }

  for (const required of [
    'unique(workspace_id,admission_id,run_id)',
    'references public.discovery_run(workspace_id,id)',
    'foreign key(workspace_id,admission_id,run_id)',
    'references public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)',
    'deferrable initially deferred',
    'create table public.discovery_company_materialization_tx_fence',
    'backend_pid integer',
    'transaction_id xid8',
    'snapshot_sha256 char(64)',
    "canonical_type='company'",
    'unique(workspace_id,id,canonical_type,canonical_id,raw_record_id)',
    'unique(workspace_id,id,raw_record_id)',
  ]) {
    requireText(normalized, required, `C_TX_CONTRACT_MISSING_${required}`);
  }

  if (/grant\s+(?:insert|update|delete|all)[^;]*to\s+app_user/iu.test(sql)) {
    throw new Error('C_TX_APP_DML_EXPOSED');
  }
  if (/grant\s+[^;]*discovery_company_materialization_tx_fence[^;]*to\s+(?:app_user|runtime_)/iu.test(sql)) {
    throw new Error('C_TX_FENCE_RUNTIME_ACL_EXPOSED');
  }

  requireText(normalized, 'from public.identity_link', 'C_TX_IDENTITY_INVENTORY_MISSING');
  requireText(normalized, 'group by workspace_id,raw_record_id', 'C_TX_IDENTITY_GROUPING_MISSING');
  requireText(normalized, 'count(*)', 'C_TX_IDENTITY_DUPLICATE_INVENTORY_MISSING');
  requireText(
    normalized,
    'count(distinct canonical_id)',
    'C_TX_IDENTITY_MULTI_TARGET_INVENTORY_MISSING',
  );
  requireText(normalized, 'before insert on public.identity_link', 'C_TX_TYPED_TARGET_TRIGGER_MISSING');
  requireText(normalized, 'security definer', 'C_TX_TYPED_TARGET_DEFINER_MISSING');
  requireText(normalized, 'canonical_company', 'C_TX_COMPANY_TARGET_CHECK_MISSING');
  requireText(normalized, 'canonical_contact', 'C_TX_CONTACT_TARGET_CHECK_MISSING');
}

async function readRequired(url: URL, missingCode: string): Promise<string> {
  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(missingCode, { cause: error });
    }
    throw error;
  }
}

describe('Discovery company materialization C-TX inventory and schema migration', () => {
  it('mutation-proves the focused static migration validator', () => {
    const tableContracts = WORKSPACE_TABLES.map(
      (table) => `
        CREATE TABLE public.${table} (
          workspace_id uuid, admission_id uuid, run_id uuid,
          FOREIGN KEY (workspace_id, admission_id, run_id)
            REFERENCES public.discovery_company_materialization_admission
              (workspace_id, admission_id, run_id) DEFERRABLE INITIALLY DEFERRED
        );
        ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;
        GRANT SELECT ON TABLE public.${table} TO app_user;
        CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON public.${table}
          FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();`,
    ).join('\n');
    const valid = `
      ALTER TABLE public.discovery_run ADD COLUMN materialization_contract_version varchar(64);
      CREATE TRIGGER discovery_run_materialization_insert_guard BEFORE INSERT ON public.discovery_run
        FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_materialization_marker_v1();
      CREATE TRIGGER discovery_run_materialization_update_guard BEFORE UPDATE ON public.discovery_run
        FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_materialization_marker_v1();
      SELECT 'discovery-company-materialization/v1';
      CREATE TABLE public.discovery_company_materialization_activation (
        activation_id smallint CHECK (activation_id=1));
      CREATE TRIGGER discovery_company_materialization_activation_immutable
        BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_activation
        FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();
      CREATE TABLE public.discovery_company_materialization_tx_fence (
        backend_pid integer, transaction_id xid8, snapshot_sha256 char(64));
      ALTER TABLE public.discovery_company_materialization_admission
        ADD UNIQUE (workspace_id,admission_id,run_id),
        ADD FOREIGN KEY (workspace_id,run_id) REFERENCES public.discovery_run(workspace_id,id);
      ALTER TABLE public.identity_link
        ADD UNIQUE (workspace_id,id,canonical_type,canonical_id,raw_record_id);
      ALTER TABLE public.raw_source_governance_disposition
        ADD UNIQUE (workspace_id,id,raw_record_id);
      CREATE UNIQUE INDEX identity_link_company_raw_unique
        ON public.identity_link(workspace_id,raw_record_id) WHERE canonical_type='company';
      DO $inventory$ BEGIN
        PERFORM 1 FROM public.identity_link WHERE canonical_type='company'
          GROUP BY workspace_id,raw_record_id
          HAVING count(*)>1 OR count(DISTINCT canonical_id)>1;
      END $inventory$;
      CREATE FUNCTION public.validate_identity_link_typed_target_v1() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
        BEGIN PERFORM 1 FROM public.canonical_company; PERFORM 1 FROM public.canonical_contact;
        RETURN NEW; END $body$;
      CREATE TRIGGER identity_link_typed_target BEFORE INSERT ON public.identity_link
        FOR EACH ROW EXECUTE FUNCTION public.validate_identity_link_typed_target_v1();
      ${tableContracts}`;

    expect(() => validateMaterializationSchemaMigration(valid)).not.toThrow();
    expect(() => validateMaterializationSchemaMigration(valid.replace('FORCE ROW LEVEL SECURITY', '')))
      .toThrow(/C_TX_RLS_FORCE_MISSING/u);
    expect(() => validateMaterializationSchemaMigration(valid.replace('count(DISTINCT canonical_id)>1', 'false')))
      .toThrow('C_TX_IDENTITY_MULTI_TARGET_INVENTORY_MISSING');
    expect(() => validateMaterializationSchemaMigration(`${valid}\nGRANT INSERT ON public.identity_link TO app_user;`))
      .toThrow('C_TX_APP_DML_EXPOSED');
    expect(() => validateMaterializationSchemaMigration(
      `${valid}\nINSERT INTO public.discovery_company_materialization_activation VALUES (1);`,
    )).toThrow('C_TX_RELEASE_A_MUST_NOT_ACTIVATE');
  });

  it('requires the additive C-TX schema migration and inventory guards', async () => {
    const migration = await readRequired(
      schemaMigrationUrl,
      'DISCOVERY_COMPANY_MATERIALIZATION_SCHEMA_MIGRATION_MISSING',
    );
    validateMaterializationSchemaMigration(migration);
    expect(migration.split(C_TX_CONTRACT_SHA256).length - 1).toBeGreaterThanOrEqual(8);
    expect(migration).toContain('DISCOVERY_COMPANY_MATERIALIZATION_MIGRATION_PRINCIPAL_INVALID');
    expect(migration).toContain('discovery_company_materialization_activation_insert_guard');
    expect(migration).toMatch(/NOLOGIN\s+NOINHERIT[\s\S]{0,100}BYPASSRLS/u);
    expect(migration).toContain('membership.roleid=reader_oid OR membership.member=reader_oid');
    for (const catalog of [
      'information_schema.column_privileges',
      'pg_database database_object',
      'pg_namespace schema_object',
      'pg_default_acl defaults',
      'pg_type object',
      'pg_operator object',
      'pg_foreign_data_wrapper object',
      'pg_largeobject_metadata object',
    ]) expect(migration).toContain(catalog);
    expect(migration).toContain(
      'UNIQUE(workspace_id,id,operation_id,relation_key)',
    );
    expect(migration).toContain(
      'REFERENCES public.governed_subject_relation(workspace_id,id,operation_id,relation_key)',
    );
  });

  it('requires Prisma parity while preserving the existing FieldEvidence identity key', async () => {
    const schema = await readRequired(prismaSchemaUrl, 'PRISMA_SCHEMA_MISSING');
    expect(schema).toMatch(
      /materializationContractVersion\s+String\?\s+@map\("materialization_contract_version"\)/u,
    );
    expect(schema).toContain(C_TX_CONTRACT_SHA256);
    expect(schema).toContain('canonicalGovernedSubjectType');
    for (const model of [
      'DiscoveryCompanyMaterializationAdmission',
      'DiscoveryCompanyMaterializationOutcome',
      'DiscoveryCompanyMaterializationBatchReceipt',
      'DiscoveryCompanyMaterializationQueryReceipt',
      'DiscoveryCompanyMaterializationRunReceipt',
    ]) expect(schema).toContain(`model ${model}`);
    expect(schema).toContain(
      '@@unique([workspaceId, entityType, entityId, field, rawRecordId], map: "field_evidence_raw_field_unique")',
    );
  });

  it('requires every product DiscoveryRun creator to write the explicit v1 marker', async () => {
    const source = await readRequired(discoveryServiceUrl, 'DISCOVERY_RUN_CREATOR_MISSING');
    expect(source).toContain(
      'materializationContractVersion: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION',
    );
    expect(source).toContain(
      "import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from './discovery-company-materialization-ctx';",
    );
  });

  it('pins all previously accepted Q-TX migration bytes', async () => {
    for (const [name, expected] of Object.entries(FROZEN_Q_MIGRATIONS)) {
      const bytes = await readRequired(
        new URL(`packages/db/prisma/migrations/${name}/migration.sql`, repositoryRoot),
        `FROZEN_Q_MIGRATION_MISSING_${name}`,
      );
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(expected);
    }
  });
});
