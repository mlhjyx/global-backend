import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  probePiiBackfillGitSource,
  verifyPiiBackfillSourceIdentity,
} from './pii-backfill-source-identity';

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

  it('reads a real clean Git checkout and detects later worktree dirtiness', () => {
    const root = mkdtempSync(join(tmpdir(), 'pii-backfill-source-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: root,
      });
      execFileSync('git', ['config', 'user.name', 'PII Backfill Test'], {
        cwd: root,
      });
      writeFileSync(join(root, 'tracked.txt'), 'fixed\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'fixed source'], { cwd: root });

      const clean = probePiiBackfillGitSource(root);
      expect(clean.repositoryRoot).toBe(root);
      expect(clean.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(clean.porcelainStatus).toBe('');
      expect(
        verifyPiiBackfillSourceIdentity({
          expectedBuildSha: clean.headSha,
          expectedRepositoryRoot: root,
        }),
      ).toEqual({ actualBuildSha: clean.headSha, repositoryRoot: root });

      writeFileSync(join(root, 'tracked.txt'), 'drifted\n');
      expect(probePiiBackfillGitSource(root).porcelainStatus).not.toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('masks invalid path and non-repository failures', () => {
    expect(() => probePiiBackfillGitSource('/definitely/missing/source')).toThrow(
      /PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED/,
    );
    const root = mkdtempSync(join(tmpdir(), 'pii-backfill-not-git-'));
    try {
      expect(() => probePiiBackfillGitSource(root)).toThrow(
        /PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
