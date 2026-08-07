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
    expect(() =>
      resolvePiiBackfillAuthorization(['--apply', '--unknown'], ENV),
    ).toThrowError(/PII_BACKFILL_ARGUMENT_INVALID/);
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
    expect(() =>
      resolvePiiBackfillAuthorization(['--apply'], {
        ...ENV,
        PII_BACKFILL_DATABASE_URL: 'mysql://owner:secret@db.example/pilot',
      }),
    ).toThrowError(/PII_BACKFILL_DATABASE_URL_INVALID/);
  });

  it.each([
    ['', 'PII_BACKFILL_AUTHORIZATION_ID_INVALID'],
    ['contains spaces', 'PII_BACKFILL_AUTHORIZATION_ID_INVALID'],
    ['x'.repeat(129), 'PII_BACKFILL_AUTHORIZATION_ID_INVALID'],
  ])('rejects unsafe authorization id %j', (value, code) => {
    expect(() =>
      resolvePiiBackfillAuthorization(['--apply'], {
        ...ENV,
        PII_BACKFILL_AUTHORIZATION_ID: value,
      }),
    ).toThrowError(new RegExp(code));
  });

  it.each(['', '-pilot', 'pilot/database', 'x'.repeat(64)])(
    'rejects unsafe expected database %j',
    (PII_BACKFILL_EXPECTED_DATABASE) => {
      expect(() =>
        resolvePiiBackfillAuthorization(['--apply'], {
          ...ENV,
          PII_BACKFILL_EXPECTED_DATABASE,
        }),
      ).toThrowError(/PII_BACKFILL_EXPECTED_DATABASE_INVALID/);
    },
  );

  it.each(['', 'abc', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)])(
    'rejects unsafe build SHA %j',
    (PII_BACKFILL_EXPECTED_BUILD_SHA) => {
      expect(() =>
        resolvePiiBackfillAuthorization(['--verify-only'], {
          ...ENV,
          PII_BACKFILL_EXPECTED_BUILD_SHA,
        }),
      ).toThrowError(/PII_BACKFILL_EXPECTED_BUILD_SHA_INVALID/);
    },
  );

  it('normalizes an uppercase build SHA without changing the authorization identity', () => {
    expect(
      resolvePiiBackfillAuthorization(['--verify-only'], {
        ...ENV,
        PII_BACKFILL_EXPECTED_BUILD_SHA: 'A'.repeat(40),
      }),
    ).toMatchObject({
      mode: 'VERIFY_ONLY',
      authorizationId: ENV.PII_BACKFILL_AUTHORIZATION_ID,
      expectedBuildSha: 'a'.repeat(40),
    });
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
