import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
  '../../../../packages/db/prisma/migrations/20261105030000_source_channel_run_truncated/migration.sql',
  import.meta.url,
);

describe('source_channel_run truncated migration (P4-P4c)', () => {
  it('adds a defaulted boolean without rewriting history', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain(
      'ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(sql).not.toMatch(/UPDATE\s+"source_channel_run"/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
