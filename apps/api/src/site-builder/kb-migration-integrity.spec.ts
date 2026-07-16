import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APPLIED_MIGRATIONS = {
  '20260717020000_site_builder_kb_r2_reconcile/migration.sql':
    '80c9c9ac9db501fe5175ad3c742d57f54ac7e64dc516b53c97a3c6359aa86327',
  '20260717021000_site_builder_kb_r2_constraints/migration.sql':
    '65f0002e7de79220ffe853375db3a4bce9ca19908befcd6eeccb26583fb18fab',
} as const;

describe('R2-A2 applied migration integrity', () => {
  it.each(Object.entries(APPLIED_MIGRATIONS))(
    'keeps %s byte-for-byte immutable after shared-dev application',
    (relativePath, expectedSha256) => {
      const path = fileURLToPath(
        new URL(`../../../../packages/db/prisma/migrations/${relativePath}`, import.meta.url),
      );
      const actualSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');

      expect(actualSha256).toBe(expectedSha256);
    },
  );
});
