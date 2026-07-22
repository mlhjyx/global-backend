import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// CI 构建门：每个 fixture 物化为 SITESPEC_PATH 后真实跑 astro build，
// 实例化 Section/Base/全 55 组件（不只是查 JSON）。
const fixturesDir = join(process.cwd(), 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('-spec.json'));
const astroBin =
  process.platform === 'win32'
    ? 'node_modules\\.bin\\astro.CMD'
    : 'node_modules/.bin/astro';

function runBuild(specPath: string, outDir: string): void {
  execSync(`${astroBin} build`, {
    env: { ...process.env, SITESPEC_PATH: specPath, OUT_DIR: outDir },
    stdio: 'pipe',
    timeout: 60000,
  });
}

describe('每 fixture 真实 Astro 构建（CI 构建门）', () => {
  for (const f of fixtures) {
    it(`${f}: astro build 成功（实例化全 55 组件）`, () => {
      expect(() =>
        runBuild(join('fixtures', f), 'dist-test-' + f.replace('.json', '')),
      ).not.toThrow();
    }, 90000);
  }
});

describe('未知 type/preset 真实 build fail-closed 负例', () => {
  const baseSpec = {
    specVersion: '1.0.0',
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset: 'modern-industrial' },
      nav: [],
      seoGlobal: { siteName: 'T' },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        puck: { content: [], root: {} },
        seo: { titleKey: 't', descriptionKey: 'd' },
      },
    ],
    assets: {},
    copyBundles: { en: { t: 'T', d: 'D' } },
  };

  it('未知 block.type -> astro build throw UNKNOWN_COMPONENT_TYPE', () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: { content: [{ type: 'UnknownType', props: {} }], root: {} },
        },
      ],
    };
    const tmp = join(fixturesDir, '__tmp-unknown-type.json');
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      runBuild('fixtures/__tmp-unknown-type.json', 'dist-test-unknown-type');
    } catch (e) {
      err = e;
    } finally {
      try { unlinkSync(tmp); } catch { /* noop */ }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })
        ?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        '',
    );
    expect(out).toContain('UNKNOWN_COMPONENT_TYPE');
  }, 90000);

  it('未知 theme.preset -> astro build throw UNKNOWN_STYLE_PRESET', () => {
    const spec = {
      ...baseSpec,
      site: { ...baseSpec.site, theme: { preset: 'unknown-preset' } },
    };
    const tmp = join(fixturesDir, '__tmp-unknown-preset.json');
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      runBuild('fixtures/__tmp-unknown-preset.json', 'dist-test-unknown-preset');
    } catch (e) {
      err = e;
    } finally {
      try { unlinkSync(tmp); } catch { /* noop */ }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })
        ?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        '',
    );
    expect(out).toContain('UNKNOWN_STYLE_PRESET');
  }, 90000);

  it('缺必填 props -> astro build fail-closed (COPY_SLOT_MISSING)', () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: { content: [{ type: 'HeroBanner', props: {} }], root: {} },
        },
      ],
    };
    const tmp = join(fixturesDir, '__tmp-missing-prop.json');
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      runBuild('fixtures/__tmp-missing-prop.json', 'dist-test-missing-prop');
    } catch (e) {
      err = e;
    } finally {
      try { unlinkSync(tmp); } catch { /* noop */ }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })
        ?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        '',
    );
    expect(out).toContain('COPY_SLOT_MISSING');
  }, 90000);
});
