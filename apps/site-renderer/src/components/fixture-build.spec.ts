import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// CI 构建门：每个 fixture 物化为 SITESPEC_PATH 后真实跑 astro build，
// 实例化 Section/Base/全 55 组件（不只是查 JSON）。Base 的可选 slot（contact.*/nav.book）
// 用 safe 探测，缺 key 不崩；未知 type/preset fail-closed throw 会让 build 失败。
const fixturesDir = join(process.cwd(), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('-spec.json'));

const astroBin =
  process.platform === 'win32'
    ? 'node_modules\\.bin\\astro.CMD'
    : 'node_modules/.bin/astro';

describe('每 fixture 真实 Astro 构建（CI 构建门）', () => {
  for (const f of fixtures) {
    it(`${f}: astro build 成功（SITESPEC_PATH 物化，实例化全组件）`, () => {
      const env = {
        ...process.env,
        SITESPEC_PATH: join('fixtures', f),
        OUT_DIR: 'dist-test-' + f.replace('.json', ''),
      };
      expect(() =>
        execSync(`${astroBin} build`, {
          env,
          stdio: 'pipe',
          timeout: 60000,
        }),
      ).not.toThrow();
    }, 90000);
  }
});
