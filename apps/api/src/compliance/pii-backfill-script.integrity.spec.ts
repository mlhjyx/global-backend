import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  resolve(process.cwd(), 'scripts/backfill-pii-encryption.mts'),
  'utf8',
);

describe('PII backfill execution integrity', () => {
  it('verifies immutable source identity before constructing a database client', () => {
    const identity = script.indexOf('verifyPiiBackfillSourceIdentity(');
    const database = script.indexOf('new PrismaClient(');
    expect(identity).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(identity);
    expect(script).toContain('actualBuildSha');
  });

  it('runs every mutation inside one bounded interactive transaction', () => {
    expect(script).toMatch(/owner\.\$transaction\s*\(/);
    expect(script).toMatch(/timeout:\s*PII_BACKFILL_TRANSACTION_TIMEOUT_MS/);
    expect(script).toMatch(/SET LOCAL statement_timeout/);
    expect(script).toMatch(/pg_advisory_xact_lock/);
  });

  it('counts and verifies suppression email plus all other plaintext surfaces', () => {
    for (const surface of [
      'canonical_contact',
      'contact_point',
      'field_evidence',
      'suppression_record',
    ]) {
      expect(script).toContain(`FROM "${surface}"`);
    }
    expect(script).toContain('PII_BACKFILL_SUPPRESSION_COLLISION');
  });
});
