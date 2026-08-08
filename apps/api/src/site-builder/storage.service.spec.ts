import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
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
  AUTH_AUDIENCE: 'global-api',
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

function clientHarness(env?: RuntimeEnvironment) {
  const service = storageService(env);
  const send = vi.fn();
  (service as unknown as { client: { send: typeof send } }).client.send = send;
  return { service, send };
}

describe('StorageService bounded object operations', () => {
  it('returns normalized head metadata and maps all not-found shapes to null', async () => {
    const h = clientHarness();
    h.send.mockResolvedValueOnce({ ContentLength: undefined, ContentType: undefined });
    await expect(h.service.head('key')).resolves.toEqual({ size: 0, contentType: null });
    for (const name of ['NotFound', 'NoSuchKey', '404']) {
      h.send.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
      await expect(h.service.head('key')).resolves.toBeNull();
    }
    h.send.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(h.service.head('key')).rejects.toThrow('storage unavailable');
  });

  it('passes abort signals to S3 and reads a complete body', async () => {
    const h = clientHarness();
    const signal = new AbortController().signal;
    h.send.mockResolvedValue({ Body: { transformToByteArray: async () => Uint8Array.from([1, 2]) } });
    await expect(h.service.getBuffer('key', signal)).resolves.toEqual(Buffer.from([1, 2]));
    expect(h.send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
    h.send.mockResolvedValue({ Body: undefined });
    await expect(h.service.getBuffer('key')).rejects.toThrow('empty object body');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid bounded-read ceiling %s before S3',
    async (maxBytes) => {
      const h = clientHarness();
      await expect(h.service.getBufferBounded('key', maxBytes)).rejects.toThrow('maxBytes must be positive');
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it('reads Buffer and Uint8Array chunks under the ceiling and rejects empty/oversized streams', async () => {
    const h = clientHarness();
    h.send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('ab'), Uint8Array.from([99])]) });
    await expect(h.service.getBufferBounded('key', 3)).resolves.toEqual(Buffer.from('abc'));

    h.send.mockResolvedValueOnce({ Body: undefined });
    await expect(h.service.getBufferBounded('key', 3)).rejects.toThrow('empty object body');
    h.send.mockResolvedValueOnce({ Body: Readable.from([]) });
    await expect(h.service.getBufferBounded('key', 3)).rejects.toThrow('empty object body');
    h.send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('abcd')]) });
    await expect(h.service.getBufferBounded('key', 3)).rejects.toThrow('object exceeds 3 bytes');
  });

  it('streams hashes and caps the retained magic-number head at 16 bytes', async () => {
    const h = clientHarness();
    const bytes = Buffer.from('0123456789abcdefghijklmnop');
    h.send.mockResolvedValueOnce({ Body: Readable.from([bytes.subarray(0, 5), Uint8Array.from(bytes.subarray(5))]) });
    await expect(h.service.hashObject('key')).resolves.toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      head: bytes.subarray(0, 16),
      size: bytes.length,
    });
    h.send.mockResolvedValueOnce({ Body: undefined });
    await expect(h.service.hashObject('key')).rejects.toThrow('empty object body');
  });

  it('passes signals to put/copy/delete commands', async () => {
    const h = clientHarness();
    const signal = new AbortController().signal;
    h.send.mockResolvedValue({});
    await h.service.putBuffer('key', Buffer.from('x'), 'text/plain', signal);
    await h.service.copy('from/a b', 'to', signal);
    await h.service.delete('to', signal);
    expect(h.send.mock.calls.every((call) => call[1]?.abortSignal === signal)).toBe(true);
    const copy = h.send.mock.calls[1]?.[0] as { input: { CopySource: string } };
    expect(copy.input.CopySource).toContain('from/a%20b');
  });

  it('recognizes both immutable-precondition shapes and rethrows unrelated errors', async () => {
    const h = clientHarness();
    const data = Buffer.from('immutable');
    const digest = createHash('sha256').update(data).digest('hex');
    h.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'PreconditionFailed' }))
      .mockRejectedValueOnce(new Error('denied'));
    await expect(h.service.putBufferImmutable('key', data, 'text/plain', digest)).resolves.toBe('exists');
    await expect(h.service.putBufferImmutable('key', data, 'text/plain', digest)).resolves.toBe('exists');
    await expect(h.service.putBufferImmutable('key', data, 'text/plain', digest)).rejects.toThrow('denied');
  });

  it('validates deletion prefixes, ignores missing list keys and deletes pages until empty', async () => {
    const h = clientHarness();
    await expect(h.service.deletePrefix('unsafe')).rejects.toThrow('invalid object deletion prefix');
    await expect(h.service.deletePrefix('../unsafe/')).rejects.toThrow('invalid object deletion prefix');
    expect(h.send).not.toHaveBeenCalled();

    h.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'safe/a' }, {}, { Key: 'safe/b' }] })
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({ Contents: [] });
    await expect(h.service.deletePrefix('safe/')).resolves.toBe(2);
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it('fails closed when bulk deletion reports object errors', async () => {
    const h = clientHarness();
    h.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'safe/a' }] })
      .mockResolvedValueOnce({ Errors: [{ Key: 'safe/a', Code: 'Denied' }] });
    await expect(h.service.deletePrefix('safe/')).rejects.toThrow('returned object errors');
  });
});

describe('StorageService startup lifecycle admission', () => {
  it('allows explicitly unavailable development storage but not an unavailable strict runtime snapshot', async () => {
    const development = storageService();
    await expect(development.onModuleInit()).resolves.toBeUndefined();

    const base = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'development', NODE_ENV: 'test', AUTH_ALLOW_DEV_TOKENS: 'true',
    });
    const strict = new StorageService({
      getProcessSnapshot: () => ({
        ...base,
        safety: {
          ...base.safety,
          storage: { ...base.safety.storage, available: false, allowUnavailable: false },
        },
      }),
    });
    await expect(strict.onModuleInit()).rejects.toThrow('S3_ACCESS_KEY and S3_SECRET_KEY are required');
  });

  it('accepts an existing exact lifecycle rule without rewriting it', async () => {
    const h = clientHarness({
      DEPLOYMENT_STAGE: 'development', NODE_ENV: 'test', AUTH_ALLOW_DEV_TOKENS: 'true',
      S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret',
    });
    h.send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetBucketLifecycleConfigurationCommand') {
        return {
          Rules: [{
            ID: 'global-variant-attempt-ttl', Status: 'Enabled', Expiration: { Days: 1 },
            Filter: { Tag: { Key: 'global-lifecycle', Value: 'variant-attempt' } },
          }],
        };
      }
      return {};
    });
    await expect(h.service.onModuleInit()).resolves.toBeUndefined();
    expect(h.send.mock.calls.some(([command]) =>
      (command as { constructor: { name: string } }).constructor.name ===
      'PutBucketLifecycleConfigurationCommand')).toBe(false);
  });

  it('creates/replaces the lifecycle rule in development and tolerates known bucket existence', async () => {
    const h = clientHarness({
      DEPLOYMENT_STAGE: 'development', NODE_ENV: 'test', AUTH_ALLOW_DEV_TOKENS: 'true',
      S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret',
    });
    h.send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateBucketCommand') {
        throw Object.assign(new Error('exists'), { name: 'BucketAlreadyExists' });
      }
      if (command.constructor.name === 'GetBucketLifecycleConfigurationCommand') {
        throw Object.assign(new Error('none'), { name: 'NoSuchLifecycleConfiguration' });
      }
      return {};
    });
    await expect(h.service.onModuleInit()).resolves.toBeUndefined();
    expect(h.send.mock.calls.some(([command]) =>
      (command as { constructor: { name: string } }).constructor.name ===
      'PutBucketLifecycleConfigurationCommand')).toBe(true);
  });

  it('warns rather than blocking development on unexpected bucket/lifecycle failures', async () => {
    const h = clientHarness({
      DEPLOYMENT_STAGE: 'development', NODE_ENV: 'test', AUTH_ALLOW_DEV_TOKENS: 'true',
      S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret',
    });
    h.send.mockRejectedValue(new Error('storage down'));
    await expect(h.service.onModuleInit()).resolves.toBeUndefined();
  });
});
