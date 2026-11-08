import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChannelSecretUnavailableError,
  CompositeChannelSecretResolver,
  EnvChannelSecretResolver,
  FileChannelSecretResolver,
} from './secret-resolver';

describe('ChannelSecretResolver（密钥只存引用）', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'channel-secrets-'));
    mkdirSync(join(root, 'acme'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeVersion(file: string, value: string): void {
    writeFileSync(join(root, 'acme', file), JSON.stringify({ value, createdAt: '2026-11-09T00:00:00Z' }), 'utf8');
  }

  it('file：取最高版本，返回 provider/version，绝不回显值到错误里', async () => {
    writeVersion('api-key.v1.json', 'old-key');
    writeVersion('api-key.v2.json', 'new-key');
    const resolver = new FileChannelSecretResolver({ rootDir: root });
    await expect(resolver.resolve('channel/acme/api-key')).resolves.toEqual({
      value: 'new-key',
      version: 2,
      provider: 'file',
    });
  });

  it('file：TTL 缓存按 ref 失效（轮换后 60s 内旧版本，过期后新版本）', async () => {
    let nowMs = 1_000_000;
    const resolver = new FileChannelSecretResolver({ rootDir: root, cacheTtlMs: 60_000, now: () => nowMs });
    writeVersion('api-key.v1.json', 'v1');
    await expect(resolver.resolve('channel/acme/api-key')).resolves.toMatchObject({ value: 'v1', version: 1 });
    writeVersion('api-key.v2.json', 'v2');
    // TTL 内命中缓存（轮换不打断运行中的 run）。
    await expect(resolver.resolve('channel/acme/api-key')).resolves.toMatchObject({ value: 'v1', version: 1 });
    nowMs += 60_001;
    await expect(resolver.resolve('channel/acme/api-key')).resolves.toMatchObject({ value: 'v2', version: 2 });
  });

  it('file：缺失/非法引用/坏 JSON 一律 CHANNEL_SECRET_UNAVAILABLE（不区分原因）', async () => {
    const resolver = new FileChannelSecretResolver({ rootDir: root });
    for (const ref of ['channel/acme/missing', 'channel/../etc/passwd', 'channel/acme', 'not-a-ref']) {
      await expect(resolver.resolve(ref), ref).rejects.toBeInstanceOf(ChannelSecretUnavailableError);
    }
    writeFileSync(join(root, 'acme', 'broken.v1.json'), '{not json', 'utf8');
    await expect(resolver.resolve('channel/acme/broken')).rejects.toBeInstanceOf(ChannelSecretUnavailableError);
  });

  it('env：CHANNEL_SECRET_<SLUG>_<KEY>（大写，非字母数字转下划线）', async () => {
    const resolver = new EnvChannelSecretResolver({ CHANNEL_SECRET_ACME_API_KEY: 'env-key' });
    await expect(resolver.resolve('channel/acme/api-key')).resolves.toEqual({
      value: 'env-key',
      version: 1,
      provider: 'env',
    });
    await expect(resolver.resolve('channel/acme/other')).rejects.toBeInstanceOf(ChannelSecretUnavailableError);
  });

  it('composite：按顺序回退（env 优先，file 兜底）', async () => {
    writeVersion('api-key.v3.json', 'file-key');
    const env = new EnvChannelSecretResolver({ CHANNEL_SECRET_ACME_API_KEY: 'env-key' });
    const file = new FileChannelSecretResolver({ rootDir: root });
    const composite = new CompositeChannelSecretResolver([env, file]);
    await expect(composite.resolve('channel/acme/api-key')).resolves.toMatchObject({ value: 'env-key', provider: 'env' });
    await expect(composite.resolve('channel/acme/only-file')).rejects.toBeInstanceOf(ChannelSecretUnavailableError);
  });

  it('错误信息不包含密钥值', async () => {
    writeVersion('api-key.v1.json', 'super-secret-value');
    const resolver = new FileChannelSecretResolver({ rootDir: root });
    const error = await resolver.resolve('channel/acme/missing').catch((cause: unknown) => cause);
    expect(String(error)).not.toContain('super-secret-value');
    expect((error as Error).message).not.toContain('super-secret-value');
  });
});
