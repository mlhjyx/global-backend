import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { contentAddressedObjectKey, stagingObjectKey } from './artifact-key';
import { parseLifecycleExpiration } from './generic-operation-artifact.object-contract';
import {
  ArtifactStorageError,
  GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
  S3GenericOperationArtifactStore,
  type ArtifactS3Client,
  type StagedArtifact,
} from './generic-operation-artifact.store';
import {
  ARTIFACT_ID,
  BUCKET,
  RESULT_SCHEMA,
  MemoryS3Client,
  bytes,
  collect,
  expectStorageCode,
  minioLifecycleExpiry,
  sha256,
  source,
  stage,
  store,
} from './generic-operation-artifact.store.spec-helper';

describe('S3GenericOperationArtifactStore stage', () => {
  it('streams and hashes a zero-byte source without rejecting an empty result', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [], 8);
    expect(staged).toEqual({
      artifactId: ARTIFACT_ID,
      stagingKey: stagingObjectKey(ARTIFACT_ID),
      sha256: sha256([]),
      sizeBytes: '0',
      mediaType: 'application/octet-stream',
      sourceDigest: null,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'CONFIDENTIAL_TENANT',
    });
    expect(client.objects.get(staged.stagingKey)?.chunks).toEqual([]);
    expect(Object.isFrozen(staged)).toBe(true);
  });

  it('accepts an exact multi-chunk maximum with one-chunk backpressure and no Buffer accumulation', async () => {
    const chunks = [bytes(1, 2), bytes(3, 4), bytes(5, 6)] as const;
    let nextInFlight = false;
    let maxConcurrentNext = 0;
    let nextCalls = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        if (nextInFlight) throw new Error('source was read ahead');
        nextInFlight = true;
        maxConcurrentNext = Math.max(maxConcurrentNext, Number(nextInFlight));
        await Promise.resolve();
        const chunk = chunks[nextCalls];
        nextCalls += 1;
        nextInFlight = false;
        return chunk === undefined
          ? { done: true, value: undefined }
          : { done: false, value: chunk };
      },
    };
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    const { client, store: target } = store();
    const bufferConcat = vi.spyOn(Buffer, 'concat');
    const staged = await target.stage({
      artifactId: ARTIFACT_ID,
      source: source([], { body }),
      maxBytes: 6,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'PERSONAL_DATA',
    });
    expect(staged.sizeBytes).toBe('6');
    expect(staged.sha256).toBe(sha256(chunks));
    expect(client.objects.get(staged.stagingKey)?.chunks).toEqual(chunks);
    expect(maxConcurrentNext).toBe(1);
    expect(bufferConcat).not.toHaveBeenCalled();
    bufferConcat.mockRestore();
  });

  it('rejects maximum + 1 before yielding the overflowing chunk', async () => {
    const { client, store: target } = store();
    await expectStorageCode(
      stage(target, [bytes(1, 2), bytes(3, 4), bytes(5)], 4),
      'GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED',
    );
    expect(client.objects.has(stagingObjectKey(ARTIFACT_ID))).toBe(false);
  });

  it('contains source stream failures behind a fixed redacted code', async () => {
    const body = (async function* () {
      yield bytes(1);
      throw new Error('provider token=https://secret.invalid/access-key');
    })();
    const { store: target } = store();
    const result = target.stage({
      artifactId: ARTIFACT_ID,
      source: source([], { body }),
      maxBytes: 4,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'PUBLIC_ORGANIZATION',
    });
    await expectStorageCode(result, 'GENERIC_OPERATION_ARTIFACT_SOURCE_FAILED');
    await expect(result).rejects.not.toThrow(
      /secret|access-key|provider token/i,
    );
  });

  it('contains staging transport failures behind a fixed redacted code', async () => {
    const client = new MemoryS3Client();
    client.stagingPutFailure = new Error(
      'bucket=private endpoint=https://secret.invalid accessKey=secret',
    );
    const { store: target } = store(client);
    const result = stage(target, [bytes(1)], 4);
    await expectStorageCode(
      result,
      'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    );
    await expect(result).rejects.not.toThrow(/private|secret|accessKey/i);
  });

  it('recovers only the UUID-derived staging object after a lost staging ACK', async () => {
    const abort = new AbortController();
    const client = new MemoryS3Client();
    client.stagingPutAckFailure = true;
    client.stagingPutAckAbort = abort;
    const { store: target } = store(client);
    await expect(
      stage(target, [bytes(1), bytes(2, 3)], 3, abort.signal),
    ).resolves.toMatchObject({
      stagingKey: stagingObjectKey(ARTIFACT_ID),
      sizeBytes: '3',
      sha256: sha256([bytes(1), bytes(2, 3)]),
    });
    expect(abort.signal.aborted).toBe(true);
    const getKeys = client.commands
      .filter((command) => command instanceof GetObjectCommand)
      .map((command) => (command as GetObjectCommand).input.Key);
    expect(getKeys).toEqual([stagingObjectKey(ARTIFACT_ID)]);
  });

  it('returns a fixed stage ACK-unknown error when staging recovery is unavailable', async () => {
    const abort = new AbortController();
    const client = new MemoryS3Client();
    client.stagingPutAckFailure = true;
    client.stagingPutAckAbort = abort;
    client.getFailure = new Error(
      'endpoint=https://secret.invalid credential=secret',
    );
    const { store: target } = store(client);
    const result = stage(target, [bytes(1)], 1, abort.signal);
    await expectStorageCode(
      result,
      'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN',
    );
    await expect(result).rejects.not.toThrow(/secret|credential/i);
    expect(abort.signal.aborted).toBe(true);
  });

  it.each([
    ['missing resultSchema', { resultSchema: undefined }],
    ['invalid resultSchema', { resultSchema: '../credential' }],
    ['missing privacyClass', { privacyClass: undefined }],
    ['invalid privacyClass', { privacyClass: 'PUBLIC' }],
  ])('rejects %s before sending storage commands', async (_label, mutation) => {
    const { client, store: target } = store();
    const input = {
      artifactId: ARTIFACT_ID,
      source: source([bytes(1)]),
      maxBytes: 4,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'PERSONAL_DATA',
      ...mutation,
    };
    await expectStorageCode(
      target.stage(input as Parameters<typeof target.stage>[0]),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
    expect(client.commands).toEqual([]);
  });

  it.each([
    ['invalid artifact UUID', { artifactId: 'not-a-uuid' }],
    ['negative maximum', { maxBytes: -1 }],
    ['fractional maximum', { maxBytes: 1.5 }],
    ['invalid media type', { source: source([], { mediaType: 'invalid' }) }],
    [
      'invalid source digest',
      { source: source([], { sourceDigest: 'not-a-digest' }) },
    ],
  ])('rejects %s at the stage boundary', async (_label, mutation) => {
    const { client, store: target } = store();
    await expectStorageCode(
      target.stage({
        artifactId: ARTIFACT_ID,
        source: source([]),
        maxBytes: 0,
        resultSchema: RESULT_SCHEMA,
        privacyClass: 'PERSONAL_DATA',
        ...mutation,
      }),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
    expect(client.commands).toEqual([]);
  });

  it('honors an already-aborted signal before reading or sending', async () => {
    let sourceReads = 0;
    const abort = new AbortController();
    abort.abort();
    const { client, store: target } = store();
    await expectStorageCode(
      target.stage({
        artifactId: ARTIFACT_ID,
        source: {
          mediaType: 'application/octet-stream',
          body: {
            [Symbol.asyncIterator]() {
              sourceReads += 1;
              return (async function* () {
                yield bytes(1);
              })();
            },
          },
        },
        maxBytes: 4,
        resultSchema: RESULT_SCHEMA,
        privacyClass: 'PERSONAL_DATA',
        signal: abort.signal,
      }),
      'GENERIC_OPERATION_ARTIFACT_ABORTED',
    );
    expect(sourceReads).toBe(0);
    expect(client.commands).toEqual([]);
  });
});

describe('S3GenericOperationArtifactStore promote/inspect', () => {
  it('promotes with immutable digest, size, schema and privacy metadata', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(1, 2), bytes(3)], 3);
    const mutable = { ...staged };
    const result = target.promote(mutable);
    Object.assign(mutable, {
      artifactId: '11111111-1111-4111-8111-111111111111',
      stagingKey: '../attacker',
      sha256: 'ab'.repeat(32),
      sizeBytes: '999',
      mediaType: 'text/plain',
      sourceDigest: 'cd'.repeat(32),
      resultSchema: 'attacker/v1',
      privacyClass: 'PERSONAL_DATA',
    });
    const stored = await result;
    expect(stored).toEqual({
      objectKey: contentAddressedObjectKey(
        staged.sha256,
        staged.privacyClass,
      ),
      versionId: 'version-1',
      sha256: staged.sha256,
      sizeBytes: '3',
      mediaType: staged.mediaType,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'CONFIDENTIAL_TENANT',
    });
    expect(client.objects.get(stored.objectKey)?.metadata).toEqual({
      sha256: staged.sha256,
      'size-bytes': '3',
      schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
      'result-schema': RESULT_SCHEMA,
      'privacy-class': 'CONFIDENTIAL_TENANT',
    });
    const getKeys = client.commands
      .filter((command) => command instanceof GetObjectCommand)
      .map((command) => (command as GetObjectCommand).input.Key);
    expect(getKeys).toEqual([
      staged.stagingKey,
      contentAddressedObjectKey(staged.sha256, staged.privacyClass),
    ]);
    const finalPut = client.commands.find(
      (command) =>
        command instanceof PutObjectCommand &&
        command.input.IfNoneMatch === '*',
    ) as PutObjectCommand;
    expect(finalPut.input).toMatchObject({
      Key: stored.objectKey,
      ContentLength: 3,
      ContentType: staged.mediaType,
    });
  });

  it('recovers a matching immutable target when the promote ACK is unknown', async () => {
    const client = new MemoryS3Client();
    const { store: target } = store(client);
    const staged = await stage(target, [bytes(7, 8)], 2);
    client.finalPutFailure = 'after_commit';
    await expect(target.promote(staged)).resolves.toMatchObject({
      sha256: staged.sha256,
      sizeBytes: '2',
    });
    const headKeys = client.commands
      .filter((command) => command instanceof HeadObjectCommand)
      .map((command) => (command as HeadObjectCommand).input.Key);
    expect(headKeys).toEqual([
      contentAddressedObjectKey(staged.sha256, staged.privacyClass),
      contentAddressedObjectKey(staged.sha256, staged.privacyClass),
    ]);
    const getKeys = client.commands
      .filter((command) => command instanceof GetObjectCommand)
      .map((command) => (command as GetObjectCommand).input.Key);
    expect(getKeys).toEqual([
      staged.stagingKey,
      contentAddressedObjectKey(staged.sha256, staged.privacyClass),
    ]);
  });

  it('returns a fixed ACK-unknown error when the digest-derived target is absent', async () => {
    const client = new MemoryS3Client();
    const { store: target } = store(client);
    const staged = await stage(target, [bytes(7, 8)], 2);
    client.finalPutFailure = 'before_commit';
    await expectStorageCode(
      target.promote(staged),
      'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN',
    );
  });

  it.each(['successful PUT', 'promote ACK recovery', 'existing target'])(
    'rejects corrupt final readback after %s',
    async (path) => {
      const client = new MemoryS3Client();
      const target = store(client).store;
      const staged = await stage(target, [bytes(1, 2)], 2);
      if (path === 'existing target') await target.promote(staged);
      if (path === 'promote ACK recovery')
        client.finalPutFailure = 'after_commit';
      client.finalReadbackChunks = [bytes(1, 3)];
      await expectStorageCode(
        target.promote(staged),
        'GENERIC_OPERATION_ARTIFACT_INVALID',
      );
    },
  );

  it.each(['ContentLength', 'Metadata'])(
    'rejects conflicting final GET %s',
    async (field) => {
      const client = new MemoryS3Client();
      const target = store(client).store;
      const staged = await stage(target, [bytes(4, 5)], 2);
      if (field === 'ContentLength') client.finalReadbackContentLength = 3;
      else
        client.finalReadbackMetadata = {
          sha256: staged.sha256,
          'size-bytes': '2',
          schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
          'result-schema': staged.resultSchema,
          'privacy-class': 'PERSONAL_DATA',
        };
      await expectStorageCode(
        target.promote(staged),
        'GENERIC_OPERATION_ARTIFACT_INVALID',
      );
    },
  );

  it('accepts an already-existing immutable target only when all metadata matches', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(9, 10)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks: [bytes(9, 10)],
      contentType: staged.mediaType,
      tagSet: [{ Key: 'artifact-privacy', Value: staged.privacyClass }],
      serverSideEncryption: 'AES256',
      versionId: 'version-existing',
      metadata: {
        sha256: staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': staged.resultSchema,
        'privacy-class': staged.privacyClass,
      },
    });
    await expect(target.promote(staged)).resolves.toMatchObject({
      objectKey: key,
      sha256: staged.sha256,
    });
    expect(client.objects.get(key)?.chunks).toEqual([bytes(9, 10)]);
    const getKeys = client.commands
      .filter((command) => command instanceof GetObjectCommand)
      .map((command) => (command as GetObjectCommand).input.Key);
    expect(getKeys).toEqual([key]);
  });

  it('shares an existing immutable target first written under another result schema and media type', async () => {
    // Same bytes inside one privacy boundary are one object: an empty HEAD probe
    // (http-get/v1, text/plain) and an empty crawl (crawl4ai-fetch/v1,
    // text/markdown) must not reject each other.
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(9, 10)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks: [bytes(9, 10)],
      contentType: 'text/markdown',
      tagSet: [{ Key: 'artifact-privacy', Value: staged.privacyClass }],
      serverSideEncryption: 'AES256',
      versionId: 'version-existing',
      metadata: {
        sha256: staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': 'crawl4ai-fetch/v1',
        'privacy-class': staged.privacyClass,
      },
    });
    await expect(target.promote(staged)).resolves.toMatchObject({
      objectKey: key,
      sha256: staged.sha256,
      sizeBytes: staged.sizeBytes,
      mediaType: 'text/markdown',
      resultSchema: 'crawl4ai-fetch/v1',
      versionId: 'version-existing',
    });
    expect(client.objects.get(key)?.chunks).toEqual([bytes(9, 10)]);
    // The existing object is reused as it is, never rewritten with the new contract.
    expect(
      client.commands.filter((command) => command instanceof PutObjectCommand),
    ).toHaveLength(0);
    expect(client.objects.get(key)?.metadata['result-schema']).toBe('crawl4ai-fetch/v1');
  });

  it.each([
    ['missing privacy tag', []],
    [
      'conflicting privacy tag',
      [{ Key: 'artifact-privacy', Value: 'PUBLIC_ORGANIZATION' }],
    ],
    [
      'extra object tag',
      [
        { Key: 'artifact-privacy', Value: 'CONFIDENTIAL_TENANT' },
        { Key: 'attacker', Value: 'retention-bypass' },
      ],
    ],
  ])('rejects an immutable target with %s', async (_label, tagSet) => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(31, 32)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks: [bytes(31, 32)],
      contentType: staged.mediaType,
      metadata: {
        sha256: staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': staged.resultSchema,
        'privacy-class': staged.privacyClass,
      },
      tagSet,
      serverSideEncryption: 'AES256',
    });

    await expectStorageCode(
      target.promote(staged),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('rejects an immutable target without per-object AES256 encryption evidence', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(33, 34)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks: [bytes(33, 34)],
      contentType: staged.mediaType,
      metadata: {
        sha256: staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': staged.resultSchema,
        'privacy-class': staged.privacyClass,
      },
      tagSet: [{ Key: 'artifact-privacy', Value: staged.privacyClass }],
      serverSideEncryption: undefined,
    });

    await expectStorageCode(
      target.promote(staged),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('rejects an existing target whose final GET bytes contradict matching metadata', async () => {
    const client = new MemoryS3Client();
    const { store: target } = store(client);
    const staged = await stage(target, [bytes(9, 10)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks: [bytes(9, 11)],
      contentType: staged.mediaType,
      tagSet: [{ Key: 'artifact-privacy', Value: staged.privacyClass }],
      serverSideEncryption: 'AES256',
      metadata: {
        sha256: staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': staged.resultSchema,
        'privacy-class': staged.privacyClass,
      },
    });
    await expectStorageCode(
      target.promote(staged),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('rejects Proxy, accessor, exotic, non-enumerable, symbol and extra-field staged inputs before S3', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(21, 22)], 2);
    const commandCount = client.commands.length;
    let getterReads = 0;
    const accessor = { ...staged };
    Object.defineProperty(accessor, 'stagingKey', {
      enumerable: true,
      get: () => (++getterReads === 1 ? staged.stagingKey : '../attacker-key'),
    });
    const nonEnumerable = { ...staged };
    Object.defineProperty(nonEnumerable, 'mediaType', { enumerable: false });
    const cases = [
      new Proxy(staged, {}),
      accessor,
      Object.assign(Object.create({}), staged),
      Object.assign(Object.create(null), staged),
      nonEnumerable,
      { ...staged, [Symbol('attacker')]: '../attacker-key' },
      { ...staged, attackerKey: '../attacker-key' },
    ] as const;
    for (const value of cases) {
      await expectStorageCode(
        target.promote(value as StagedArtifact),
        'GENERIC_OPERATION_ARTIFACT_INVALID',
      );
      expect(client.commands).toHaveLength(commandCount);
    }
    expect(getterReads).toBe(0);
  });

  it.each([
    ['HEAD size mismatch', { contentLength: 3 }],
    ['digest metadata mismatch', { sha256: 'ab'.repeat(32) }],
    ['privacy metadata mismatch', { privacyClass: 'PERSONAL_DATA' }],
  ])('rejects an immutable target with %s', async (_label, mutation) => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(11, 12)], 2);
    const key = contentAddressedObjectKey(staged.sha256, staged.privacyClass);
    client.objects.set(key, {
      chunks:
        mutation.contentLength === 3 ? [bytes(11, 12, 13)] : [bytes(11, 12)],
      contentType: staged.mediaType,
      tagSet: [{ Key: 'artifact-privacy', Value: staged.privacyClass }],
      serverSideEncryption: 'AES256',
      metadata: {
        sha256: mutation.sha256 ?? staged.sha256,
        'size-bytes': staged.sizeBytes,
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': mutation.resultSchema ?? staged.resultSchema,
        'privacy-class': mutation.privacyClass ?? staged.privacyClass,
      },
    });
    await expectStorageCode(
      target.promote(staged),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('returns null only for an absent digest-derived object', async () => {
    const { store: target } = store();
    await expect(
      target.inspect('cd'.repeat(32), 'PERSONAL_DATA'),
    ).resolves.toBeNull();
  });

  it('contains HEAD transport details and honors aborts', async () => {
    const client = new MemoryS3Client();
    client.headFailure = new Error(
      'endpoint=https://secret.invalid credential=secret',
    );
    const { store: target } = store(client);
    const result = target.inspect('cd'.repeat(32), 'PERSONAL_DATA');
    await expectStorageCode(
      result,
      'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    );
    await expect(result).rejects.not.toThrow(/secret|credential/i);
    const abort = new AbortController();
    abort.abort();
    await expectStorageCode(
      target.inspect('cd'.repeat(32), 'PERSONAL_DATA', abort.signal),
      'GENERIC_OPERATION_ARTIFACT_ABORTED',
    );
  });
});

describe('S3GenericOperationArtifactStore read/delete/readiness', () => {
  it('reads only the digest-derived final key as a streaming byte iterable', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(1), bytes(2, 3)], 3);
    const stored = await target.promote(staged);
    const body = await target.read(stored.sha256, stored.privacyClass);
    await expect(collect(body)).resolves.toEqual([bytes(1), bytes(2, 3)]);
    const getKeys = client.commands
      .filter((command) => command instanceof GetObjectCommand)
      .map((command) => (command as GetObjectCommand).input.Key);
    expect(getKeys.at(-1)).toBe(
      contentAddressedObjectKey(stored.sha256, stored.privacyClass),
    );
  });

  it('contains read transport details behind a fixed redacted code', async () => {
    const client = new MemoryS3Client();
    client.getFailure = new Error(
      'bucket=private endpoint=https://secret.invalid credential=secret',
    );
    const { store: target } = store(client);
    const result = target.read('ef'.repeat(32), 'PERSONAL_DATA');
    await expectStorageCode(
      result,
      'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    );
    await expect(result).rejects.not.toThrow(/private|secret|credential/i);
  });

  it('contains a read stream failure and an in-flight abort behind fixed codes', async () => {
    const digest = 'ef'.repeat(32);
    const firstClient: ArtifactS3Client = {
      async send() {
        return {
          Body: (async function* () {
            yield bytes(1);
            throw new Error('stream endpoint=https://secret.invalid');
          })(),
        };
      },
    };
    const firstStore = new S3GenericOperationArtifactStore({
      bucket: BUCKET,
      client: firstClient,
    });
    const failingBody = await firstStore.read(digest, 'PERSONAL_DATA');
    const failingIterator = failingBody[Symbol.asyncIterator]();
    await expect(failingIterator.next()).resolves.toEqual({
      done: false,
      value: bytes(1),
    });
    await expectStorageCode(
      failingIterator.next(),
      'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    );

    const abort = new AbortController();
    const abortingBody = await firstStore.read(
      digest,
      'PERSONAL_DATA',
      abort.signal,
    );
    const abortingIterator = abortingBody[Symbol.asyncIterator]();
    await expect(abortingIterator.next()).resolves.toMatchObject({
      done: false,
    });
    abort.abort();
    await expectStorageCode(
      abortingIterator.next(),
      'GENERIC_OPERATION_ARTIFACT_ABORTED',
    );
  });

  it('deletes only the UUID-derived staging key', async () => {
    const { client, store: target } = store();
    const staged = await stage(target, [bytes(1)], 1);
    await target.deleteStaging(ARTIFACT_ID);

    expect(client.objects.has(staged.stagingKey)).toBe(false);
    const deletes = client.commands.filter(
      (command) => command instanceof DeleteObjectCommand,
    );
    expect(deletes).toHaveLength(1);
    expect((deletes[0] as DeleteObjectCommand).input.Key).toBe(
      stagingObjectKey(ARTIFACT_ID),
    );
  });

  it('rejects a caller-controlled staging key input before delete', async () => {
    const { client, store: target } = store();

    await expectStorageCode(
      target.deleteStaging('../final/object'),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
    expect(client.commands).toEqual([]);
  });

  it('reports readiness without provisioning and redacts validation failures', async () => {
    const ready = store();
    await expect(ready.store.checkReadiness()).resolves.toEqual({
      status: 'ready',
    });
    expect(
      ready.client.commands.map((command) => command.constructor.name),
    ).toEqual([
      'GetBucketVersioningCommand',
      'GetBucketEncryptionCommand',
      'GetBucketLifecycleConfigurationCommand',
      'PutObjectCommand',
      'GetObjectCommand',
      'DeleteObjectCommand',
      'HeadObjectCommand',
      'ListObjectVersionsCommand',
    ]);
    expect(
      ready.client.commands.some(
        (command) =>
          command.constructor.name.startsWith('Create') ||
          command.constructor.name.startsWith('PutBucket'),
      ),
    ).toBe(false);
    expect(
      [...ready.client.objects.keys()].some((key) =>
        key.startsWith('generic-operation-results/v1/readiness/'),
      ),
    ).toBe(false);

    const unavailableClient = new MemoryS3Client();
    unavailableClient.readinessFailure = new Error(
      'endpoint=https://secret.invalid key=secret',
    );
    const unavailable = store(unavailableClient);
    await expect(unavailable.store.checkReadiness()).resolves.toEqual({
      status: 'not_ready',
      code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    });
  });

  it('uses stable error objects whose message never carries a cause', () => {
    const error = new ArtifactStorageError(
      'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    );

    expect(error).toEqual(
      expect.objectContaining({
        name: 'ArtifactStorageError',
        code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
        message: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
      }),
    );
    expect(error).not.toHaveProperty('cause');
  });

  it('reports a final object the bucket no longer holds with the bounded OBJECT_MISSING code', async () => {
    const { store: target } = store();
    await expectStorageCode(
      target.read('ef'.repeat(32), 'PERSONAL_DATA'),
      'GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING',
    );
    await expect(
      target.inspect('ef'.repeat(32), 'PERSONAL_DATA'),
    ).resolves.toBeNull();
  });
});

/*
 * The content object is shared by every manifest with the same bytes, but the
 * bucket lifecycle expires it by the age of its current version. A later
 * manifest therefore has to move that age forward when its own expiry would
 * outlive the version the first writer created (xin, 2026-10-14: 23 live rows
 * pointed at an object MinIO had already deleted).
 */
describe('S3GenericOperationArtifactStore retention refresh on reuse', () => {
  const FIRST_WRITE = new Date('2026-10-12T17:34:40.000Z');
  const REUSE = new Date('2026-10-13T16:36:09.000Z');
  const REUSE_EXPIRES_AT = '2026-10-14T16:36:09.000Z';

  async function firstWrite(
    client: MemoryS3Client,
    logger?: { warn(code: string): void },
  ) {
    client.now = FIRST_WRITE;
    const { store: target } = store(client, logger);
    const staged = await target.stage({
      artifactId: ARTIFACT_ID,
      source: source([bytes(1, 2, 3)]),
      maxBytes: 3,
      resultSchema: RESULT_SCHEMA,
      privacyClass: 'PERSONAL_DATA',
    });
    const stored = await target.promote(staged);
    expect(stored.versionId).toBe('version-1');
    return { target, staged, stored };
  }

  function copies(client: MemoryS3Client): CopyObjectCommand[] {
    return client.commands.filter(
      (command): command is CopyObjectCommand =>
        command instanceof CopyObjectCommand,
    );
  }

  it('copies the object onto itself when the lifecycle expiry precedes the manifest expiry', async () => {
    const client = new MemoryS3Client();
    const { target, staged, stored } = await firstWrite(client);
    // The first version expires at midnight UTC after 2026-10-14 17:34, i.e. 2026-10-14 00:00.
    expect(minioLifecycleExpiry(FIRST_WRITE, 1).toISOString()).toBe(
      '2026-10-14T00:00:00.000Z',
    );

    client.now = REUSE;
    const reused = await target.promote(staged, {
      retainUntil: REUSE_EXPIRES_AT,
    });

    const [copy, ...rest] = copies(client);
    expect(rest).toHaveLength(0);
    expect(copy?.input).toEqual({
      Bucket: BUCKET,
      Key: stored.objectKey,
      CopySource: `${BUCKET}/${stored.objectKey}`,
      MetadataDirective: 'REPLACE',
      Metadata: {
        sha256: staged.sha256,
        'size-bytes': '3',
        schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
        'result-schema': RESULT_SCHEMA,
        'privacy-class': 'PERSONAL_DATA',
      },
      ContentType: staged.mediaType,
      TaggingDirective: 'REPLACE',
      Tagging: 'artifact-privacy=PERSONAL_DATA',
      ServerSideEncryption: 'AES256',
    });
    expect(reused).toEqual({ ...stored, versionId: 'copy-version-1' });
    const object = client.objects.get(stored.objectKey);
    expect(object?.lastModified).toEqual(REUSE);
    expect(object?.chunks).toEqual([bytes(1, 2, 3)]);
    expect(object?.serverSideEncryption).toBe('AES256');
    expect(
      minioLifecycleExpiry(REUSE, 1).getTime(),
    ).toBeGreaterThanOrEqual(Date.parse(REUSE_EXPIRES_AT));
    await expect(
      target.inspect(staged.sha256, 'PERSONAL_DATA'),
    ).resolves.toEqual(reused);
  });

  it('keeps the current version when its lifecycle expiry already covers the manifest expiry', async () => {
    const client = new MemoryS3Client();
    const { target, staged, stored } = await firstWrite(client);

    client.now = new Date('2026-10-12T17:40:00.000Z');
    const reused = await target.promote(staged, {
      retainUntil: '2026-10-13T17:40:00.000Z',
    });

    expect(copies(client)).toHaveLength(0);
    expect(reused).toEqual(stored);
    expect(client.objects.get(stored.objectKey)?.lastModified).toEqual(
      FIRST_WRITE,
    );
  });

  it('refreshes when the object announces no lifecycle expiry at all', async () => {
    const client = new MemoryS3Client();
    const { target, staged } = await firstWrite(client);
    client.emitExpiration = false;

    client.now = new Date('2026-10-12T17:40:00.000Z');
    const reused = await target.promote(staged, {
      retainUntil: '2026-10-13T17:40:00.000Z',
    });

    expect(copies(client)).toHaveLength(1);
    expect(reused.versionId).toBe('copy-version-1');
  });

  it('never copies when the caller states no retention requirement', async () => {
    const client = new MemoryS3Client();
    const { target, staged, stored } = await firstWrite(client);

    client.now = REUSE;
    await expect(target.promote(staged)).resolves.toEqual(stored);
    expect(copies(client)).toHaveLength(0);
  });

  it('keeps the verified version and logs one bounded code when the refresh copy fails', async () => {
    const client = new MemoryS3Client();
    const logger = { warn: vi.fn() };
    const { target, staged, stored } = await firstWrite(client, logger);
    client.copyFailure = new Error(
      'bucket=private endpoint=https://secret.invalid credential=secret',
    );

    client.now = REUSE;
    await expect(
      target.promote(staged, { retainUntil: REUSE_EXPIRES_AT }),
    ).resolves.toEqual(stored);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /private|secret|credential/i,
    );
  });

  it('records the copied version even when a concurrent refresh landed afterwards', async () => {
    const client = new MemoryS3Client();
    const { target, staged } = await firstWrite(client);
    client.copyResponseVersionId = false;

    client.now = REUSE;
    const reused = await target.promote(staged, {
      retainUntil: REUSE_EXPIRES_AT,
    });

    // Without a version in the copy response the current version is the only truth.
    expect(reused.versionId).toBe('copy-version-1');
  });

  it('keeps the first writer\'s metadata, content type and tag when a reuse under another contract refreshes the object', async () => {
    // #644 lets byte-identical artifacts of different result schemas share one
    // object and keeps the first writer's contract on it; the refresh copy must
    // not rewrite that contract with the later manifest's.
    const client = new MemoryS3Client();
    const { store: target } = store(client);
    client.now = FIRST_WRITE;
    const first = await target.promote(
      await target.stage({
        artifactId: ARTIFACT_ID,
        source: source([], { mediaType: 'text/markdown' }),
        maxBytes: 0,
        resultSchema: 'crawl4ai-fetch/v1',
        privacyClass: 'PERSONAL_DATA',
      }),
    );
    const firstObject = client.objects.get(first.objectKey);
    const firstMetadata = { ...firstObject?.metadata };
    const firstTags = [...(firstObject?.tagSet ?? [])];

    client.now = REUSE;
    const reused = await target.promote(
      await target.stage({
        artifactId: '5d1c3b8e-2f0a-4a4e-9a51-3f7d2b6c8e10',
        source: source([], { mediaType: 'text/plain' }),
        maxBytes: 0,
        resultSchema: 'http-get/v1',
        privacyClass: 'PERSONAL_DATA',
      }),
      { retainUntil: REUSE_EXPIRES_AT },
    );

    const [copy, ...rest] = copies(client);
    expect(rest).toHaveLength(0);
    expect(copy?.input).toMatchObject({
      MetadataDirective: 'REPLACE',
      Metadata: firstMetadata,
      ContentType: 'text/markdown',
      TaggingDirective: 'REPLACE',
      Tagging: 'artifact-privacy=PERSONAL_DATA',
    });
    const after = client.objects.get(first.objectKey);
    expect(after?.contentType).toBe('text/markdown');
    expect(after?.metadata).toEqual(firstMetadata);
    expect(after?.metadata['result-schema']).toBe('crawl4ai-fetch/v1');
    expect(after?.tagSet).toEqual(firstTags);
    expect(after?.lastModified).toEqual(REUSE);
    expect(reused).toEqual({ ...first, versionId: 'copy-version-1' });
  });

  it.each([
    ['content type', (client: MemoryS3Client) => {
      client.copyContentTypeDrift = 'text/plain';
    }],
    ['result schema', (client: MemoryS3Client) => {
      client.copyResultSchemaDrift = 'crawl4ai-fetch/v1';
    }],
  ])('rejects a refreshed object whose %s drifted from the existing object\'s contract', async (_label, drift) => {
    const client = new MemoryS3Client();
    const { target, staged } = await firstWrite(client);
    drift(client);

    client.now = REUSE;
    await expectStorageCode(
      target.promote(staged, { retainUntil: REUSE_EXPIRES_AT }),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('rejects a refresh whose copy lands with the later manifest\'s contract instead of the first writer\'s', async () => {
    const client = new MemoryS3Client();
    const { target, stored } = await firstWrite(client);
    expect(stored.mediaType).toBe('application/octet-stream');
    // The copy lands carrying the reusing manifest's media type, as an S3
    // implementation that ignored the requested contract would leave it.
    client.copyContentTypeDrift = 'text/plain';

    client.now = REUSE;
    await expectStorageCode(
      target.promote(
        await target.stage({
          artifactId: '5d1c3b8e-2f0a-4a4e-9a51-3f7d2b6c8e10',
          source: source([bytes(1, 2, 3)], { mediaType: 'text/plain' }),
          maxBytes: 3,
          resultSchema: 'crawl4ai-fetch/v1',
          privacyClass: 'PERSONAL_DATA',
        }),
        { retainUntil: REUSE_EXPIRES_AT },
      ),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('reads the lifecycle expiry only from a well-formed x-amz-expiration header', () => {
    expect(
      parseLifecycleExpiration(
        'expiry-date="Fri, 16 Oct 2026 00:00:00 GMT", rule-id="generic-operation-artifact-personal-data-ttl"',
      ),
    ).toEqual(new Date('2026-10-16T00:00:00.000Z'));
    for (const header of [
      undefined,
      null,
      42,
      '',
      'rule-id="x"',
      'expiry-date="not a date"',
      `expiry-date="${'x'.repeat(65)}"`,
    ]) {
      expect(parseLifecycleExpiration(header)).toBeNull();
    }
  });

  it.each([
    ['a non-canonical retainUntil', 'tomorrow'],
    ['a retainUntil with an offset', '2026-10-14T16:36:09+02:00'],
  ])('rejects %s before touching storage', async (_label, retainUntil) => {
    const client = new MemoryS3Client();
    const { target, staged } = await firstWrite(client);
    const before = client.commands.length;

    await expectStorageCode(
      target.promote(staged, { retainUntil }),
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
    expect(client.commands).toHaveLength(before);
  });
});
