import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../packages/db/prisma/migrations/20260830130200_discovery_query_lineage_execution_outcome/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(
  new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url),
  'utf8',
);

describe('Discovery query lineage execution outcome migration', () => {
  it('adds one append-only FORCE RLS outcome relation without rewriting v1 receipt rows', () => {
    expect(migration).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/u);
    expect(migration).toContain('CREATE TABLE public.discovery_query_execution_outcome');
    expect(migration).toContain('budget_truncated BOOLEAN NOT NULL');
    expect(migration).toContain('FOREIGN KEY (workspace_id, run_id, query_key)');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('discovery_query_execution_outcome_immutable');
    expect(migration).toContain('GRANT SELECT ON TABLE public.discovery_query_execution_outcome TO app_user');
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+public\.discovery_query_receipt\s+ADD/iu);
    expect(schema).toContain('model DiscoveryQueryExecutionOutcome');
    expect(schema).toMatch(/budgetTruncated\s+Boolean\s+@map\("budget_truncated"\)/u);
  });

  it('installs explicit v2 append and read-only attest successors over frozen v1 facts', () => {
    for (const name of [
      'append_discovery_query_lineage_v2',
      'attest_discovery_query_lineage_v2',
    ]) {
      expect(migration).toContain(`CREATE FUNCTION public.${name}`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(JSONB) TO app_user`);
    }
    expect(migration).toContain('discovery-query-lineage-command/v2');
    expect(migration).toContain('c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c');
    expect(migration).toContain('append_discovery_query_lineage_v1(v1_command)');
    expect(migration).toMatch(/attempt->>'contractSha256'<>[\s\S]{0,160}c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c/u);
    expect(migration).toContain('attest_discovery_query_lineage_v1(p_attestation_key)');
    const attest = migration.slice(
      migration.indexOf('CREATE FUNCTION public.attest_discovery_query_lineage_v2'),
    );
    expect(attest).not.toMatch(/\bUPDATE\b|\bDELETE\b/iu);
    expect(attest).toContain('discovery_query_execution_outcome');
  });

  it('lineage v3 replaces the v2 contract hash and keeps frozen history readable', () => {
    const v3 = readFileSync(
      new URL(
        '../../../../packages/db/prisma/migrations/20261108120000_discovery_query_lineage_contract_v3/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(v3).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/u);
    for (const name of [
      'append_discovery_query_lineage_v2',
      'attest_discovery_query_lineage_v2',
      'admit_discovery_company_materialization_v1',
    ]) {
      expect(v3).toContain(`CREATE OR REPLACE FUNCTION public.${name}`);
      expect(v3).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(JSONB) TO app_user`);
    }
    expect(v3).toContain('7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37');
    // 委托 v1 的旧哈希不变（v1 函数与其回执是冻结事实）。
    expect(v3).toContain('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0');
    // append/attest 的自家合同检查只认新哈希；表级 CHECK 同时接受新旧（不可改写历史行）。
    expect(v3).toMatch(/p_append_command->>'contractSha256'<>[\s\S]{0,160}7b29dc8f/u);
    expect(v3).toMatch(/attempt->>'contractSha256'<>[\s\S]{0,160}7b29dc8f/u);
    expect(v3).toMatch(
      /contract_sha256 IN \([\s\S]{0,200}c665fc06[\s\S]{0,200}7b29dc8f/u,
    );
    expect(v3).toMatch(/q_contract_sha256 IN \('c665fc06[\s\S]{0,200}7b29dc8f/u);
    const attest = v3.slice(v3.indexOf('CREATE OR REPLACE FUNCTION public.attest_discovery_query_lineage_v2'));
    expect(attest).not.toMatch(/\bUPDATE\b|\bDELETE\b/iu);
  });
});
