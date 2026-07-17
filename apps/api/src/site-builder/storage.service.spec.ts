import { describe, expect, it, vi } from 'vitest';

import { StorageService } from './storage.service';

describe('StorageService variant-attempt lifecycle', () => {
  it('tags only producer-isolated attempt writes for automatic expiry', async () => {
    const service = new StorageService();
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
    const service = new StorageService();
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
    const previousNodeEnv = process.env.NODE_ENV;
    const previousManage = process.env.S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE;
    process.env.NODE_ENV = 'production';
    delete process.env.S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE;
    try {
      const service = new StorageService();
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
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousManage === undefined) delete process.env.S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE;
      else process.env.S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE = previousManage;
    }
  });

  it('fails production startup before lifecycle validation when object storage credentials are absent', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAccessKey = process.env.S3_ACCESS_KEY;
    process.env.NODE_ENV = 'production';
    delete process.env.S3_ACCESS_KEY;
    try {
      const service = new StorageService();
      await expect(service.onModuleInit()).rejects.toThrow(/S3_ACCESS_KEY is required/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAccessKey === undefined) delete process.env.S3_ACCESS_KEY;
      else process.env.S3_ACCESS_KEY = previousAccessKey;
    }
  });
});
