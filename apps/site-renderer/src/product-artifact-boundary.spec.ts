import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('site renderer product artifact boundary', () => {
  it('does not emit a visual gallery route in a production site build', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'site-renderer-product-'));
    roots.push(outDir);
    execFileSync('node_modules/.bin/astro', ['build'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SITESPEC_PATH: 'fixtures/demo-spec.json',
        SITE_ORIGIN: 'https://preview.example.test',
        OUT_DIR: outDir,
      },
      stdio: 'pipe',
      timeout: 60_000,
    });

    expect(existsSync(join(outDir, 'gallery', 'index.html'))).toBe(false);
  }, 90_000);
});
