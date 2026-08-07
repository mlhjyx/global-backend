import { describe, expect, it, vi } from 'vitest';
import { verifyPiiBackfillSourceIdentity } from './pii-backfill-source-identity';

const SHA = 'a'.repeat(40);
const ROOT = '/srv/global/backend-release';

function probe(overrides: Partial<{
  repositoryRoot: string;
  headSha: string;
  porcelainStatus: string;
}> = {}) {
  return vi.fn(() => ({
    repositoryRoot: ROOT,
    headSha: SHA,
    porcelainStatus: '',
    ...overrides,
  }));
}

describe('PII backfill source identity', () => {
  it('binds a clean exact checkout to the authorized SHA', () => {
    const read = probe();
    expect(
      verifyPiiBackfillSourceIdentity(
        { expectedBuildSha: SHA, expectedRepositoryRoot: ROOT },
        read,
      ),
    ).toEqual({ actualBuildSha: SHA, repositoryRoot: ROOT });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ headSha: 'b'.repeat(40) }, 'PII_BACKFILL_BUILD_SHA_MISMATCH'],
    [{ porcelainStatus: ' M apps/api/scripts/backfill-pii-encryption.mts' }, 'PII_BACKFILL_SOURCE_DIRTY'],
    [{ repositoryRoot: '/srv/global/other' }, 'PII_BACKFILL_SOURCE_ROOT_MISMATCH'],
    [{ headSha: 'not-a-sha' }, 'PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED'],
  ] as const)('fails closed on source drift %#', (overrides, code) => {
    expect(() =>
      verifyPiiBackfillSourceIdentity(
        { expectedBuildSha: SHA, expectedRepositoryRoot: ROOT },
        probe(overrides),
      ),
    ).toThrowError(new RegExp(code));
  });

  it('normalizes an uppercase authorized SHA before comparison', () => {
    expect(
      verifyPiiBackfillSourceIdentity(
        { expectedBuildSha: SHA.toUpperCase(), expectedRepositoryRoot: ROOT },
        probe(),
      ).actualBuildSha,
    ).toBe(SHA);
  });
});
