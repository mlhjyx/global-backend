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
});
