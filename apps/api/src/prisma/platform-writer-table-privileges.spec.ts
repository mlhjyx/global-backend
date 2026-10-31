import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 平台写入者（execution_budget_platform_writer）的业务表权限清单与授予迁移必须逐字一致。
// 真库的执行期闸门是迁移里的 DO 自检（多一项少一项都让迁移失败）；这里保证清单与
// 迁移文本不漂移，任何权限变更都必须同时改两边、走审查。

interface Manifest {
  schemaVersion: string;
  role: string;
  schema: string;
  tables: Record<string, string[]>;
}

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'docs/governance/platform-writer-table-privileges.json'), 'utf8'),
) as Manifest;
const migration = readFileSync(
  path.join(
    ROOT,
    'packages/db/prisma/migrations/20261031140000_platform_writer_business_grants/migration.sql',
  ),
  'utf8',
);

const PRIVILEGES = new Set(['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']);

function grantedFromMigration(): Map<string, Set<string>> {
  const granted = new Map<string, Set<string>>();
  const pattern = /GRANT ([A-Z, ]+) ON TABLE([\s\S]*?)\s+TO execution_budget_platform_writer;/g;
  for (const match of migration.matchAll(pattern)) {
    const privileges = match[1].split(',').map((value) => value.trim()).filter(Boolean);
    for (const name of match[2].matchAll(/"([a-z_][a-z0-9_]*)"/g)) {
      const set = granted.get(name[1]) ?? new Set<string>();
      for (const privilege of privileges) set.add(privilege);
      granted.set(name[1], set);
    }
  }
  return granted;
}

describe('platform writer table privilege manifest', () => {
  it('is closed, sorted and names only known privileges', () => {
    expect(Object.keys(manifest).sort()).toEqual(['role', 'schema', 'schemaVersion', 'tables']);
    expect(manifest.schemaVersion).toBe('platform-writer-table-privileges/v1');
    expect(manifest.role).toBe('execution_budget_platform_writer');
    expect(manifest.schema).toBe('public');
    const tableNames = Object.keys(manifest.tables);
    expect(tableNames).toEqual([...tableNames].sort());
    for (const privileges of Object.values(manifest.tables)) {
      expect(privileges.length).toBeGreaterThan(0);
      for (const privilege of privileges) expect(PRIVILEGES.has(privilege)).toBe(true);
    }
  });

  it('matches the grant migration exactly', () => {
    const granted = grantedFromMigration();
    const manifestTables = new Set(Object.keys(manifest.tables));
    expect([...granted.keys()].sort()).toEqual([...manifestTables].sort());
    for (const [table, privileges] of Object.entries(manifest.tables)) {
      expect([...(granted.get(table) ?? [])].sort()).toEqual([...privileges].sort());
    }
  });

  it('does not grant TRUNCATE anywhere', () => {
    for (const privileges of grantedFromMigration().values()) {
      expect(privileges.has('TRUNCATE')).toBe(false);
    }
  });
});
