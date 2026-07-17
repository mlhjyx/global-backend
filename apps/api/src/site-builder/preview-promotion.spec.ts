import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePreviewPromotion } from './preview-promotion';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'preview-promotion-'));
  roots.push(root);
  const oldVersion = path.join(root, '.versions', 'old-run');
  const staging = path.join(root, '.staging', 'run-1');
  const activeDir = path.join(root, '.active');
  const active = path.join(activeDir, 'acme');
  await Promise.all([
    mkdir(oldVersion, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(activeDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(oldVersion, 'index.html'), 'old'),
    writeFile(path.join(staging, 'index.html'), 'candidate'),
  ]);
  await symlink(path.join('..', '.versions', 'old-run'), active, 'dir');
  return { root, active, staging };
}

describe('preparePreviewPromotion', () => {
  it('keeps the old served pointer while the DB transaction is uncommitted and restores staging on rollback', async () => {
    const { root, active, staging } = await fixture();
    const promotion = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    expect(await readFile(path.join(active, 'index.html'), 'utf8')).toBe('old');
    await promotion.rollback();
    expect(await readFile(path.join(active, 'index.html'), 'utf8')).toBe('old');
    expect(await readFile(path.join(staging, 'index.html'), 'utf8')).toBe(
      'candidate',
    );
  });

  it('atomically replaces only the active symlink after commit', async () => {
    const { root, active } = await fixture();
    const promotion = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    expect(await readFile(path.join(active, 'index.html'), 'utf8')).toBe('old');
    await promotion.commit();
    expect(await readlink(active)).toBe(path.join('..', '.versions', 'run-1'));
    expect(await readFile(path.join(active, 'index.html'), 'utf8')).toBe(
      'candidate',
    );
  });

  it('reconstructs a pending pointer after a post-commit Activity crash', async () => {
    const { root, active } = await fixture();
    const first = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    // Simulate process death after DB commit: immutable version exists, pending pointer is lost.
    await rm(path.join(root, '.active', '.pending-run-1'), { force: true });
    void first;
    const retry = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    await retry.commit();
    expect(await readFile(path.join(active, 'index.html'), 'utf8')).toBe(
      'candidate',
    );
  });
});
