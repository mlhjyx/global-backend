import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261109100000_registry_frames';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);
const SCHEMA = fileURLToPath(new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url));

const PLATFORM_TABLES = [
  'registry_frame',
  'registry_snapshot',
  'registry_entity',
  'registry_entity_change',
  'registry_entity_link',
];

describe('registry frames migration (ch03 P2 · T3-01 platform subset)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');

  it('is additive and bounded', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates the five platform tables with closed vocabularies', () => {
    for (const table of PLATFORM_TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain("CHECK (\"status\" IN ('ACTIVE', 'PAUSED', 'ARCHIVED'))");
    expect(sql).toContain(
      "CHECK (\"status\" IN ('FETCHED', 'PARSED', 'FAILED', 'SUPERSEDED'))",
    );
    expect(sql).toContain(
      "CHECK (\"status\" IN ('ACTIVE', 'DISSOLVED', 'INSOLVENT', 'UNKNOWN'))",
    );
    expect(sql).toContain(
      "CHECK (\"change_type\" IN ('ADDED', 'UPDATED', 'WITHDRAWN', 'REAPPEARED'))",
    );
    expect(sql).toContain("CHECK (\"status\" IN ('PROPOSED', 'CONFIRMED', 'REJECTED'))");
    expect(sql).toContain('UNIQUE INDEX "registry_entity_scheme_reg_number_key"');
    expect(sql).toContain('UNIQUE INDEX "registry_snapshot_frame_id_sha256_key"');
    expect(sql).toContain('UNIQUE INDEX "registry_entity_change_identity_key"');
    expect(sql).toContain('UNIQUE INDEX "registry_entity_link_identity_key"');
  });

  it('keeps platform tables free of RLS and grants app_user read-only access', () => {
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY');
    for (const table of PLATFORM_TABLES) {
      expect(sql).toContain(`GRANT SELECT ON TABLE "${table}" TO app_user;`);
      expect(sql).not.toContain(`GRANT SELECT, INSERT ON TABLE "${table}"`);
    }
  });

  it('is registered in the privilege manifest as read-only', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    for (const table of PLATFORM_TABLES) {
      expect(manifest.tables[table]).toEqual(['SELECT']);
    }
  });

  it('mirrors the migration in the Prisma datamodel', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    for (const model of [
      'RegistryFrame',
      'RegistrySnapshot',
      'RegistryEntity',
      'RegistryEntityChange',
      'RegistryEntityLink',
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).toContain('@@unique([scheme, regNumber])');
    expect(schema).toContain('@@map("registry_entity")');
    expect(schema).toContain('@@map("registry_snapshot")');
  });
});
