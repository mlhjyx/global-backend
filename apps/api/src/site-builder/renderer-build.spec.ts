import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRendererEnv,
  buildSiteSpecWithTemporaryFile,
  assertRenderedOutboundDomains,
  type RendererBuildInput,
} from './renderer-build';

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('buildRendererEnv — Renderer 子进程最小环境', () => {
  it('只包含确定性构建变量，不继承数据库、对象存储或模型密钥', () => {
    const env = buildRendererEnv({
      specPath: '/tmp/spec.json',
      outDir: '/tmp/out',
      basePath: '/preview/acme/',
    });

    expect(env).toEqual({
      NODE_ENV: 'production',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      SITESPEC_PATH: '/tmp/spec.json',
      OUT_DIR: '/tmp/out',
      BASE_PATH: '/preview/acme/',
      ASTRO_TELEMETRY_DISABLED: '1',
    });
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('S3_SECRET_KEY');
    expect(env).not.toHaveProperty('NEW_API_KEY');
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });
});

describe('rendered outbound-domain gate', () => {
  it('allows internal/self-hosted assets and explicitly approved HTTPS domains only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm1d-outbound-'));
    try {
      await writeFile(
        path.join(dir, 'index.html'),
        '<a href="/contact">local</a><img src="data:image/png;base64,x"><a href="https://docs.example.com/x">docs</a>',
      );
      await expect(
        assertRenderedOutboundDomains(dir, ['docs.example.com']),
      ).resolves.toBeUndefined();

      await writeFile(
        path.join(dir, 'app.js'),
        'fetch("https://tracker.invalid/collect")',
      );
      await expect(
        assertRenderedOutboundDomains(dir, ['docs.example.com']),
      ).rejects.toThrowError(/RENDERER_OUTBOUND_DOMAIN_FORBIDDEN/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildSiteSpecWithTemporaryFile — 临时 SiteSpec 生命周期', () => {
  it('构建期间使用 0600 随机临时文件，成功后删除整个临时目录', async () => {
    let observedPath = '';
    const execute = vi.fn(async (input: RendererBuildInput) => {
      observedPath = input.specPath;
      expect(path.basename(input.specPath)).toBe('site-spec.json');
      expect(await readFile(input.specPath, 'utf8')).toBe('{"safe":true}');
      expect((await stat(path.dirname(input.specPath))).mode & 0o777).toBe(0o700);
      expect((await stat(input.specPath)).mode & 0o777).toBe(0o600);
    });

    await buildSiteSpecWithTemporaryFile(
      { safe: true },
      { outDir: '/tmp/out', basePath: '/preview/acme/' },
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    await expectMissing(observedPath);
    await expectMissing(path.dirname(observedPath));
  });

  it('Renderer 抛错时仍在 finally 删除 SiteSpec 与随机临时目录，并保留原错误', async () => {
    let observedPath = '';
    const execute = vi.fn(async (input: RendererBuildInput) => {
      observedPath = input.specPath;
      expect(await readFile(input.specPath, 'utf8')).toBe('{"tenant":"content"}');
      throw new Error('astro failed');
    });

    await expect(
      buildSiteSpecWithTemporaryFile(
        { tenant: 'content' },
        { outDir: '/tmp/out', basePath: '/preview/acme/' },
        execute,
      ),
    ).rejects.toThrow('astro failed');

    await expectMissing(observedPath);
    await expectMissing(path.dirname(observedPath));
  });
});
