import { GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createPersonalArtifactCleanupRuntime } from './personal-artifact-cleanup.runtime';

const valid = Object.freeze({
  GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: 'http://127.0.0.1:19000',
  GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'personal-cleanup-test',
  GENERIC_OPERATION_ARTIFACT_S3_REGION: 'us-east-1',
  GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-writer',
  GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
  GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
  GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: 'cleanup-secret-123',
});

describe('personal artifact cleanup runtime configuration', () => {
  it('builds and probes a separate cleanup capability without exposing credentials', async () => {
    const send = vi.fn(async () => ({ LocationConstraint: 'us-east-1' }));
    const destroy = vi.fn();
    const runtime = createPersonalArtifactCleanupRuntime(
      { ...valid },
      () => ({ send, destroy }),
    );
    expect(runtime.port).toBeDefined();
    expect(runtime.destroy).toEqual(expect.any(Function));
    await expect(runtime.checkReadiness()).resolves.toEqual({ status: 'ok' });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketLocationCommand);
    runtime.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('returns a bounded not-ready code for cleanup-principal denial', async () => {
    const runtime = createPersonalArtifactCleanupRuntime(
      { ...valid },
      () => ({
        send: vi.fn(async () => {
          throw new Error('provider secret must not escape');
        }),
        destroy: vi.fn(),
      }),
    );
    await expect(runtime.checkReadiness()).resolves.toEqual({
      status: 'failed',
      code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    });
    runtime.destroy();
  });

  it.each([
    ['missing cleanup secret', { GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: '' }],
    ['merged principal', { GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'runtime-writer' }],
    ['remote plaintext endpoint', { GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: 'http://storage.example.test' }],
    ['endpoint credentials', { GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: 'https://user:pass@storage.example.test' }],
    ['invalid path style', { GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'yes' }],
    ['invalid bucket', { GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'Caller/Chosen' }],
  ])('fails closed for %s', (_case, override) => {
    expect(() =>
      createPersonalArtifactCleanupRuntime({ ...valid, ...override }),
    ).toThrow('PERSONAL_ARTIFACT_CLEANUP_CONFIG_INVALID');
  });
});
