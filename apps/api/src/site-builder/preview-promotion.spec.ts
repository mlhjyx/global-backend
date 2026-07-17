import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const live = path.join(root, 'acme');
  const staging = path.join(root, '.staging', 'run-1');
  await mkdir(live, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(live, 'index.html'), 'old');
  await writeFile(path.join(staging, 'index.html'), 'candidate');
  return { root, live };
}

describe('preparePreviewPromotion', () => {
  it('restores the previously served preview when the DB transaction fails', async () => {
    const { root, live } = await fixture();
    const promotion = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    expect(await readFile(path.join(live, 'index.html'), 'utf8')).toBe(
      'candidate',
    );
    await promotion.rollback();
    expect(await readFile(path.join(live, 'index.html'), 'utf8')).toBe('old');
  });

  it('keeps the candidate and removes rollback state after commit', async () => {
    const { root, live } = await fixture();
    const promotion = await preparePreviewPromotion({
      root,
      slug: 'acme',
      buildRunId: 'run-1',
    });
    await promotion.commit();
    expect(await readFile(path.join(live, 'index.html'), 'utf8')).toBe(
      'candidate',
    );
    await expect(
      readFile(path.join(root, '.rollback', 'run-1', 'index.html')),
    ).rejects.toThrow();
  });
});
