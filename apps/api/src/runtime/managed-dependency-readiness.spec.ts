import { describe, expect, it, vi } from 'vitest';
import {
  checkBrowserReadiness,
  checkImagePipelineIsolationReadiness,
  checkModelGatewayReadiness,
  checkRedisReadiness,
  rendererRuntimeIdentity,
} from './managed-dependency-readiness';

const identity = {
  attested: true as const,
  schema_version: 'global-runtime-release-identity/v1' as const,
  build_sha: 'a'.repeat(40),
  built_at: '2026-08-16T00:00:00.000Z',
  image_digest: `sha256:${'b'.repeat(64)}`,
  artifact_digest: `sha256:${'c'.repeat(64)}`,
  artifact_manifest_digest: `sha256:${'d'.repeat(64)}`,
  sbom_digest: `sha256:${'e'.repeat(64)}`,
  source_tree_digest: `sha256:${'f'.repeat(64)}`,
  renderer_digest: `sha256:${'1'.repeat(64)}`,
  migration_revision: '20260816000000_runtime_process_lease',
  schema_digest: `sha256:${'2'.repeat(64)}`,
};

describe('managed dependency readiness', () => {
  it('holds Worker readiness when the Linux image decoder limiter is absent', async () => {
    await expect(
      checkImagePipelineIsolationReadiness('linux', async () => false),
    ).resolves.toEqual({
      status: 'failed',
      code: 'IMAGE_PIPELINE_ISOLATION_UNAVAILABLE',
    });
    await expect(
      checkImagePipelineIsolationReadiness('linux', async () => true),
    ).resolves.toEqual({ status: 'ok' });
  });

  it('requires an authoritative Redis PING and fails closed when config is missing', async () => {
    await expect(checkRedisReadiness({}, vi.fn())).resolves.toEqual({
      status: 'failed',
      code: 'REDIS_CONFIG_REQUIRED',
    });
    const client = {
      status: 'wait',
      connect: vi.fn(async () => undefined),
      ping: vi.fn(async () => 'PONG'),
      disconnect: vi.fn(),
    };
    await expect(
      checkRedisReadiness(
        { REDIS_URL: 'redis://127.0.0.1:6379' },
        vi.fn(() => client),
      ),
    ).resolves.toEqual({ status: 'ok' });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    'redis://cache.example.test:6379/0',
    'http://127.0.0.1:6379',
    'rediss://cache.example.test:6380/0?family=4',
    'rediss://cache.example.test:6380/0#private-fragment',
    'rediss://cache.example.test:6380/not-a-db',
  ])('rejects an unsafe Redis URL before constructing a client: %s', async (url) => {
    const factory = vi.fn();
    const result = await checkRedisReadiness({ REDIS_URL: url }, factory);
    expect(result).toEqual({ status: 'failed', code: 'REDIS_CONFIG_INVALID' });
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it('allows credentials in a TLS URL but never returns them when the probe fails', async () => {
    const configured = 'rediss://user:must-never-leak@cache.example.test:6380/0';
    const factory = vi.fn(() => {
      throw new Error(`failed ${configured}`);
    });
    const result = await checkRedisReadiness({ REDIS_URL: configured }, factory);
    expect(result).toEqual({ status: 'failed', code: 'REDIS_UNAVAILABLE' });
    expect(factory).toHaveBeenCalledWith(configured);
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
  });

  it('uses only the no-generation model-list probe and bounds failures', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      body: { cancel: vi.fn(async () => undefined) },
    }));
    await expect(
      checkModelGatewayReadiness(
        {
          MODEL_GATEWAY_URL: 'http://127.0.0.1:3001/v1',
          MODEL_GATEWAY_KEY: 'must-not-be-returned',
        },
        fetcher as never,
      ),
    ).resolves.toEqual({ status: 'ok' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.stringify(await checkModelGatewayReadiness({}, fetcher as never))).not.toContain(
      'must-not-be-returned',
    );
  });

  it('never sends the gateway key to an unsafe probe origin', async () => {
    for (const url of [
      'http://gateway.example.test/v1',
      'https://user:password@gateway.example.test/v1',
      'https://gateway.example.test/v1?redirect=evil',
    ]) {
      const fetcher = vi.fn();
      const result = await checkModelGatewayReadiness(
        { MODEL_GATEWAY_URL: url, MODEL_GATEWAY_KEY: 'never-dispatch-this-key' },
        fetcher,
      );
      expect(result).toEqual({
        status: 'failed',
        code: 'MODEL_GATEWAY_CONFIG_INVALID',
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('never-dispatch-this-key');
    }
  });

  it('derives the renderer identity from the attested renderer component digest', () => {
    expect(rendererRuntimeIdentity(identity)).toBe(
      `site-renderer@${identity.renderer_digest}`,
    );
    expect(() =>
      rendererRuntimeIdentity({
        attested: false,
        schema_version: 'global-runtime-release-identity/v1',
        code: 'BUILD_ATTESTATION_REQUIRED',
      }),
    ).toThrow('RENDERER_IDENTITY_NOT_PROVEN');
  });

  it('launches only the fixed local Chromium binary with a zero-network data document', async () => {
    const probe = vi.fn(async () => undefined);
    await expect(checkBrowserReadiness({}, probe)).resolves.toEqual({ status: 'ok' });
    expect(probe).toHaveBeenCalledWith(
      '/usr/bin/chromium',
      expect.arrayContaining([
        '--headless=new',
        '--disable-background-networking',
        expect.stringMatching(/^data:text\/html,/),
      ]),
    );
    const unsafe = vi.fn();
    await expect(
      checkBrowserReadiness({ CHROME_PATH: '/tmp/downloaded-chrome' }, unsafe),
    ).resolves.toEqual({
      status: 'failed',
      code: 'BROWSER_RUNTIME_CONFIG_INVALID',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });
});
