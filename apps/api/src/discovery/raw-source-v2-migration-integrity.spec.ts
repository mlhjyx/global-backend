import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/migrations/20260812110000_raw_source_v2/migration.sql'),
  'utf8',
);

describe('Raw Source v2 migration invariants', () => {
  it('applies the receipt columns, constraints, triggers and privilege change atomically', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]+?BEGIN;/u);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/u);
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '60s'");
  });

  it('is forward-only and does not scan or rewrite historical payloads', () => {
    expect(migration).toContain('Historical rows remain raw-source/v1');
    expect(migration).not.toMatch(/UPDATE\s+"raw_source_record"/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"raw_source_record"/iu);
  });

  it('requires complete receipts for all newly ingested v2 rows', () => {
    expect(migration).toContain('raw_source_record_v2_receipt_check');
    expect(migration).toContain('"ingest_version" <> \'raw-source/v2\'');
    expect(migration).toContain('"payload_hash" ~ \'^[0-9a-f]{64}$\'');
    expect(migration).toContain('"expires_at" IS NOT NULL');
  });

  it('provides deterministic per-run processing-key uniqueness', () => {
    expect(migration).toContain('raw_source_record_run_provider_ingest_key_key');
    expect(migration).toContain('WHERE "ingest_key" IS NOT NULL');
  });

  it('guards accepted raw payloads against mutation while allowing one-way expiry', () => {
    expect(migration).toContain('raw_source_record_v2_immutable_guard');
    expect(migration).toContain("OLD.\"ingest_status\" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')");
    expect(migration).toContain('NEW."ingest_status" = \'EXPIRED\'');
    expect(migration).toContain('raw-source/expired-v1');
  });

  it('keeps retention as a one-way receipt update and forbids physical deletion', () => {
    expect(migration).toContain('REVOKE DELETE ON TABLE "raw_source_record" FROM app_user');
    expect(migration).toContain('reject_raw_source_record_delete');
    expect(migration).toContain('CREATE TRIGGER "raw_source_record_delete_guard"');
    expect(migration).toContain('BEFORE DELETE ON "raw_source_record"');
    expect(migration).toContain('physical deletion is forbidden; use one-way expiry receipt');
  });
});
