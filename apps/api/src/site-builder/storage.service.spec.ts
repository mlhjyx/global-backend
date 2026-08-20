import { describe, expect, it, vi } from 'vitest';

import { StorageService } from './storage.service';

function markReady(service: StorageService): void {
  (service as unknown as { readiness: { status: 'ready' } }).readiness = Object.freeze({ status: 'ready' });
}

async function withStorageCredentials(run: () => Promise<void>): Promise<void> {
  const previousAccessKey = process.env.S3_ACCESS_KEY;
  const previousSecretKey = process.env.S3_SECRET_KEY;
  process.env.S3_ACCESS_KEY = 'test-access-key';
  process.env.S3_SECRET_KEY = 'test-secret-key';
  try {
    await run();
  } finally {
    if (previousAccessKey === undefined) delete process.env.S3_ACCESS_KEY;
    else process.env.S3_ACCESS_KEY = previousAccessKey;
    if (previousSecretKey === undefined) delete process.env.S3_SECRET_KEY;
    else process.env.S3_SECRET_KEY = previousSecretKey;
  }
}

describe('StorageService variant-attempt lifecycle', () => {
  it('rejects object operations before signing or network I/O while storage is not ready', async () => {
    const service = new StorageService();
    const send = vi.fn(async () => ({}));
    (service as unknown as { client: { send: typeof send } }).client.send = send;

    const objectBytes = Buffer.from('x');
    const operations: Array<() => Promise<unknown>> = [
      () => service.presignPut('staging/object', 'image/png'),
      () => service.presignGet('canonical/object'),
      () => service.head('canonical/object'),
      () => service.getBuffer('canonical/object'),
      () => service.getBufferBounded('canonical/object', 1),
      () => service.hashObject('canonical/object'),
      () => service.putBuffer('canonical/object', objectBytes, 'image/png'),
      () => service.putBufferImmutable(
        'canonical/immutable',
        objectBytes,
        'image/png',
        '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
      ),
      () => service.copy('attempt', 'canonical'),
      () => service.delete('canonical/object'),
      () => service.deletePrefix('sites/site-1/'),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow('OBJECT_STORAGE_CREDENTIALS_REQUIRED');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes one shared storage readiness contribution and unregisters it on destroy', async () => {
    let contribute: (() => unknown) | undefined;
    const unregister = vi.fn();
    const registry = {
      register: vi.fn((name: string, callback: () => unknown) => {
        expect(name).toBe('storage');
        contribute = callback;
        return unregister;
      }),
    };

    const service = new StorageService(registry as never);

    expect(registry.register).toHaveBeenCalledTimes(1);
    await expect(contribute?.()).resolves.toEqual({
      status: 'failed',
      code: 'OBJECT_STORAGE_CREDENTIALS_REQUIRED',
    });
    service.onModuleDestroy();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('publishes ready through the same registered readiness contribution', async () => {
    await withStorageCredentials(async () => {
      let contribute: (() => unknown) | undefined;
      const unregister = vi.fn();
      const service = new StorageService({
        register: vi.fn((_name: string, callback: () => unknown) => {
          contribute = callback;
          return unregister;
        }),
      } as never);
      const send = vi.fn(async () => ({
        Rules: [{
          ID: 'global-variant-attempt-ttl',
          Status: 'Enabled',
          Filter: { Tag: { Key: 'global-lifecycle', Value: 'variant-attempt' } },
          Expiration: { Days: 1 },
        }],
      }));
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();

      await expect(contribute?.()).resolves.toEqual({ status: 'ok' });
      service.onModuleDestroy();
      expect(unregister).toHaveBeenCalledOnce();
    });
  });

  it('revalidates a transient storage outage through the shared readiness contributor', async () => {
    await withStorageCredentials(async () => {
      let contribute: (() => unknown) | undefined;
      const service = new StorageService({
        register: vi.fn((_name: string, callback: () => unknown) => {
          contribute = callback;
          return vi.fn();
        }),
      } as never);
      const send = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary object-store outage'))
        .mockResolvedValue({
          Rules: [{
            ID: 'global-variant-attempt-ttl',
            Status: 'Enabled',
            Filter: { Tag: { Key: 'global-lifecycle', Value: 'variant-attempt' } },
            Expiration: { Days: 1 },
          }],
        });
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();
      expect(service.getReadiness()).toEqual({
        status: 'not_ready',
        code: 'OBJECT_STORAGE_VALIDATION_UNAVAILABLE',
      });
      await expect(contribute?.()).resolves.toEqual({ status: 'ok' });
      expect(service.getReadiness()).toEqual({ status: 'ready' });
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    ['missing Rules', async () => ({})],
    [
      'NoSuchLifecycleConfiguration',
      async () => {
        throw Object.assign(new Error('missing lifecycle'), {
          name: 'NoSuchLifecycleConfiguration',
        });
      },
    ],
    [
      'NoSuchLifecycle',
      async () => {
        throw Object.assign(new Error('missing lifecycle'), { name: 'NoSuchLifecycle' });
      },
    ],
  ])('reports an invalid lifecycle for a reachable bucket with %s', async (_case, response) => {
    await withStorageCredentials(async () => {
      const service = new StorageService();
      const send = vi.fn(response);
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();

      expect(service.getReadiness()).toEqual({
        status: 'not_ready',
        code: 'OBJECT_STORAGE_LIFECYCLE_INVALID',
      });
    });
  });

  it('bounds a non-Error validation failure without leaking it through readiness', async () => {
    await withStorageCredentials(async () => {
      const service = new StorageService();
      const send = vi.fn(async () => {
        throw 'transport unavailable';
      });
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();

      expect(service.getReadiness()).toEqual({
        status: 'not_ready',
        code: 'OBJECT_STORAGE_VALIDATION_UNAVAILABLE',
      });
    });
  });

  it('becomes ready only after validating the exact provisioned lifecycle contract', async () => {
    const previousAccessKey = process.env.S3_ACCESS_KEY;
    const previousSecretKey = process.env.S3_SECRET_KEY;
    process.env.S3_ACCESS_KEY = 'test-access-key';
    process.env.S3_SECRET_KEY = 'test-secret-key';
    try {
      const service = new StorageService();
      const send = vi.fn(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetBucketLifecycleConfigurationCommand') {
          return {
            Rules: [
              {
                ID: 'global-variant-attempt-ttl',
                Status: 'Enabled',
                Filter: {
                  Tag: {
                    Key: 'global-lifecycle',
                    Value: 'variant-attempt',
                  },
                },
                Expiration: { Days: 1 },
              },
            ],
          };
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      });
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();

      expect(service.getReadiness()).toEqual({ status: 'ready' });
      expect(() => service.assertReady()).not.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      if (previousAccessKey === undefined) delete process.env.S3_ACCESS_KEY;
      else process.env.S3_ACCESS_KEY = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env.S3_SECRET_KEY;
      else process.env.S3_SECRET_KEY = previousSecretKey;
    }
  });

  it('distinguishes an unavailable object store from a missing lifecycle contract', async () => {
    const previousAccessKey = process.env.S3_ACCESS_KEY;
    const previousSecretKey = process.env.S3_SECRET_KEY;
    process.env.S3_ACCESS_KEY = 'test-access-key';
    process.env.S3_SECRET_KEY = 'test-secret-key';
    try {
      const service = new StorageService();
      const send = vi.fn(async () => {
        throw Object.assign(new Error('connection refused'), {
          code: 'ECONNREFUSED',
        });
      });
      (service as unknown as { client: { send: typeof send } }).client.send = send;

      await service.onModuleInit();

      expect(service.getReadiness()).toEqual({
        status: 'not_ready',
        code: 'OBJECT_STORAGE_VALIDATION_UNAVAILABLE',
      });
    } finally {
      if (previousAccessKey === undefined) delete process.env.S3_ACCESS_KEY;
      else process.env.S3_ACCESS_KEY = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env.S3_SECRET_KEY;
      else process.env.S3_SECRET_KEY = previousSecretKey;
    }
  });

  it('uses a conditional create for immutable Release objects and reconciles 412 as existing', async () => {
    const service = new StorageService();
    markReady(service);
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
    const service = new StorageService();
    markReady(service);
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
    markReady(service);
    const send = vi.fn(async () => ({}));
    (service as unknown as { client: { send: typeof send } }).client.send = send;

    await service.copy('attempt', 'canonical');

    const copy = send.mock.calls[0]?.[0] as {
      input: { TaggingDirective?: string; Tagging?: string };
    };
    expect(copy.input.TaggingDirective).toBe('REPLACE');
    expect(copy.input.Tagging).toBe('');
  });

  it('keeps every managed replica validate-only when the required rule is absent', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousManage = process.env.S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE;
    process.env.NODE_ENV = 'development';
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

  it('starts for diagnostics but remains not-ready in managed development when credentials are absent', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAccessKey = process.env.S3_ACCESS_KEY;
    const previousSecretKey = process.env.S3_SECRET_KEY;
    process.env.NODE_ENV = 'development';
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    try {
      const service = new StorageService();
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.getReadiness()).toEqual({
        status: 'not_ready',
        code: 'OBJECT_STORAGE_CREDENTIALS_REQUIRED',
      });
      expect(() => service.assertReady()).toThrow(
        'OBJECT_STORAGE_CREDENTIALS_REQUIRED',
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAccessKey === undefined) delete process.env.S3_ACCESS_KEY;
      else process.env.S3_ACCESS_KEY = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env.S3_SECRET_KEY;
      else process.env.S3_SECRET_KEY = previousSecretKey;
    }
  });
});
