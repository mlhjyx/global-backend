import { describe, expect, it, vi } from 'vitest';

import {
  resolveRuntimeProcessSnapshot,
  type RuntimeEnvironment,
} from '../runtime/runtime-admission';
import { StorageService } from './storage.service';

const PILOT_ENV = Object.freeze({
  DEPLOYMENT_STAGE: 'pilot',
  NODE_ENV: 'production',
  AUTH_JWKS_URI: 'https://identity.example.test/jwks.json',
  AUTH_ISSUER: 'https://identity.example.test',
  MODEL_GATEWAY_URL: 'https://models.example.test/v1',
  MODEL_GATEWAY_KEY: 'test-key',
  S3_ACCESS_KEY: 'test-access',
  S3_SECRET_KEY: 'test-secret',
  DATA_PROCESSOR_JURISDICTION: 'EU',
  SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
});

function storageService(
  env: RuntimeEnvironment = {
    DEPLOYMENT_STAGE: 'development',
    NODE_ENV: 'test',
    AUTH_ALLOW_DEV_TOKENS: 'true',
  },
): StorageService {
  const snapshot = resolveRuntimeProcessSnapshot(env);
  return new StorageService({ getProcessSnapshot: () => snapshot });
}

describe('StorageService variant-attempt lifecycle', () => {
  it('uses a conditional create for immutable Release objects and reconciles 412 as existing', async () => {
    const service = storageService();
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('precondition failed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        }),
      );
    (service as unknown as { client: { send: typeof send } }).client.send = send;

    await expect(
      service.putBufferImmutable(
        'sites/s/releases/r/attempts/t/files/index.html',
        Buffer.from('immutable'),
        'text/html; charset=utf-8',
        '3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7',
      ),
    ).resolves.toBe('created');
    await expect(
      service.putBufferImmutable(
        'sites/s/releases/r/attempts/t/files/index.html',
        Buffer.from('immutable'),
        'text/html; charset=utf-8',
        '3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7',
      ),
    ).resolves.toBe('exists');

    const command = send.mock.calls[0]?.[0] as {
      input: {
        IfNoneMatch?: string;
        ChecksumSHA256?: string;
        Metadata?: Record<string, string>;
      };
    };
    expect(command.input.IfNoneMatch).toBe('*');
    expect(command.input.ChecksumSHA256).toBe(
      Buffer.from(
        '3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7',
        'hex',
      ).toString('base64'),
    );
    expect(command.input.Metadata).toEqual({
      sha256:
        '3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7',
    });

    await expect(
      service.putBufferImmutable(
        'sites/s/releases/r/attempts/t/files/bad.html',
        Buffer.from('immutable'),
        'text/html; charset=utf-8',
        '0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow('immutable object sha256 mismatch');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('tags only producer-isolated attempt writes for automatic expiry', async () => {
    const service = storageService();
    const send = vi.fn(async () => ({}));
    (service as unknown as { client: { send: typeof send } }).client.send = send;

    await service.putBuffer(
      'ws/w/s/variant-attempts/a/t/r.webp',
      Buffer.from('attempt'),
      'image/webp',
      undefined,
      { lifecycle: 'variant-attempt' },
    );
    await service.putBuffer(
      'ws/w/s/variants/a/r.webp',
      Buffer.from('canonical'),
      'image/webp',
    );

    const attempt = send.mock.calls[0]?.[0] as { input: { Tagging?: string } };
    const canonical = send.mock.calls[1]?.[0] as { input: { Tagging?: string } };
    expect(attempt.input.Tagging).toBe('global-lifecycle=variant-attempt');
    expect(canonical.input.Tagging).toBeUndefined();
  });

  it('strips source lifecycle tags while copying into a canonical key', async () => {
    const service = storageService();
    const send = vi.fn(async () => ({}));
    (service as unknown as { client: { send: typeof send } }).client.send = send;

    await service.copy('attempt', 'canonical');

    const copy = send.mock.calls[0]?.[0] as {
      input: { TaggingDirective?: string; Tagging?: string };
    };
    expect(copy.input.TaggingDirective).toBe('REPLACE');
    expect(copy.input.Tagging).toBe('');
  });

  it('keeps production replicas validate-only and fails startup when the required rule is absent', async () => {
    const service = storageService(PILOT_ENV);
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetBucketLifecycleConfigurationCommand') return { Rules: [] };
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    (service as unknown as { client: { send: typeof send } }).client.send = send;
    const ensure = service as unknown as { ensureVariantAttemptLifecycle(): Promise<void> };

    await expect(ensure.ensureVariantAttemptLifecycle()).rejects.toThrow(/required variant-attempt lifecycle/);
    expect(send.mock.calls.some(([command]) =>
      (command as { constructor: { name: string } }).constructor.name ===
        'PutBucketLifecycleConfigurationCommand')).toBe(false);
  });

  it('fails pilot admission before service construction when object storage credentials are absent', () => {
    expect(() =>
      resolveRuntimeProcessSnapshot({
        ...PILOT_ENV,
        S3_ACCESS_KEY: undefined,
        S3_SECRET_KEY: undefined,
      }),
    ).toThrow(/S3_ACCESS_KEY.*S3_SECRET_KEY/);
  });
});
