import { describe, expect, it } from 'vitest';
import {
  resolvePiiBackfillAuthorization,
  resolvePiiBackfillVerifierAuthorization,
} from './pii-backfill-admission';

const ENV = {
  PII_BACKFILL_DATABASE_URL: 'postgresql://maintenance:secret@db.example/pilot',
  PII_BACKFILL_AUTHORIZATION_ID: 'auth-pii-20260807-001',
  PII_BACKFILL_EXPECTED_DATABASE: 'pilot',
  PII_BACKFILL_EXPECTED_BUILD_SHA: 'a'.repeat(40),
  PII_BACKFILL_MAX_ROWS: '10000',
};

describe('PII backfill admission', () => {
  it('requires an explicit mutually-exclusive mode', () => {
    expect(() => resolvePiiBackfillAuthorization([], ENV)).toThrowError(
      /PII_BACKFILL_MODE_REQUIRED/,
    );
    expect(() =>
      resolvePiiBackfillAuthorization(['--apply', '--verify-only'], ENV),
    ).toThrowError(/PII_BACKFILL_MODE_CONFLICT/);
  });

  it('requires a dedicated maintenance URL and never falls back to DATABASE_URL', () => {
    expect(() =>
      resolvePiiBackfillAuthorization(['--apply'], {
        ...ENV,
        PII_BACKFILL_DATABASE_URL: undefined,
        DATABASE_URL: 'postgresql://owner:must-not-fallback@db.example/pilot',
      }),
    ).toThrowError(/PII_BACKFILL_DATABASE_URL_REQUIRED/);
  });

  it('binds mode, authorization, exact database, build SHA and finite row cap', () => {
    expect(resolvePiiBackfillAuthorization(['--apply'], ENV)).toMatchObject({
      mode: 'APPLY',
      authorizationId: 'auth-pii-20260807-001',
      expectedDatabaseName: 'pilot',
      expectedBuildSha: 'a'.repeat(40),
      maxRows: 10_000,
    });
    expect(
      resolvePiiBackfillAuthorization(['--verify-only'], ENV).mode,
    ).toBe('VERIFY_ONLY');
  });

  it.each(['0', '-1', 'Infinity', '1000001', 'not-a-number'])(
    'rejects unsafe PII_BACKFILL_MAX_ROWS=%s',
    (PII_BACKFILL_MAX_ROWS) => {
      expect(() =>
        resolvePiiBackfillAuthorization(['--apply'], {
          ...ENV,
          PII_BACKFILL_MAX_ROWS,
        }),
      ).toThrowError(/PII_BACKFILL_MAX_ROWS_INVALID/);
    },
  );

  it('does not leak the maintenance URL or password in errors', () => {
    let rendered = '';
    try {
      resolvePiiBackfillAuthorization(['--apply'], {
        ...ENV,
        PII_BACKFILL_DATABASE_URL: 'not-a-postgres-url-with-super-secret',
      });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).not.toContain('super-secret');
    expect(rendered).not.toContain(ENV.PII_BACKFILL_DATABASE_URL);
  });

  it('requires a second explicit isolated-database gate for the destructive verifier', () => {
    expect(() =>
      resolvePiiBackfillVerifierAuthorization({
        ...ENV,
        PII_BACKFILL_ISOLATED_VERIFY: undefined,
      }),
    ).toThrowError(/PII_BACKFILL_ISOLATED_VERIFY_REQUIRED/);

    expect(
      resolvePiiBackfillVerifierAuthorization({
        ...ENV,
        PII_BACKFILL_ISOLATED_VERIFY: 'true',
      }),
    ).toMatchObject({
      mode: 'APPLY',
      expectedDatabaseName: 'pilot',
    });
  });

  it.each(['1', 'TRUE', 'yes', 'false']) (
    'rejects ambiguous isolated-verifier gate value %s',
    (PII_BACKFILL_ISOLATED_VERIFY) => {
      expect(() =>
        resolvePiiBackfillVerifierAuthorization({
          ...ENV,
          PII_BACKFILL_ISOLATED_VERIFY,
        }),
      ).toThrowError(/PII_BACKFILL_ISOLATED_VERIFY_REQUIRED/);
    },
  );
});
