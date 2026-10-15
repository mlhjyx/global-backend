import {
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentAddressedObjectKey, stagingObjectKey } from './artifact-key';
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GenericOperationArtifactError,
} from './artifact.types';
import type { GenericOperationArtifactRepository } from './generic-operation-artifact.repository';
import { objectMetadata } from './generic-operation-artifact.object-contract';
import { GenericOperationArtifactService } from './generic-operation-artifact.service';
import {
  ArtifactStorageError,
  S3GenericOperationArtifactStore,
  type StagedArtifact,
  type StoredArtifact,
} from './generic-operation-artifact.store';
import { createPersonalArtifactCleanupRuntime } from './personal-artifact-cleanup.runtime';
import { S3PersonalArtifactCleanupAdapter } from './personal-artifact-cleanup.store';

const enabled = process.env.PERSONAL_ARTIFACT_CLEANUP_MINIO_TEST === '1';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`PERSONAL_CLEANUP_MINIO_CONFIG_REQUIRED:${name}`);
  return value;
}

function client(accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: required('PERSONAL_ARTIFACT_CLEANUP_MINIO_ENDPOINT'),
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId, secretAccessKey },
  });
}

function runtimeClient(): S3Client {
  return client(
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_RUNTIME_ACCESS_KEY'),
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_RUNTIME_SECRET_KEY'),
  );
}

function cleanupClient(): S3Client {
  return client(
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_ACCESS_KEY'),
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_SECRET_KEY'),
  );
}

function rootClient(): S3Client {
  return client(
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_ROOT_ACCESS_KEY'),
    required('PERSONAL_ARTIFACT_CLEANUP_MINIO_ROOT_SECRET_KEY'),
  );
}

function source(value: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield value;
    },
  };
}

function denied(error: unknown): boolean {
  const record = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    record?.name === 'AccessDenied' || record?.$metadata?.httpStatusCode === 403
  );
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  let observed = false;
  try {
    await promise;
  } catch (error) {
    observed = denied(error);
  }
  expect(observed).toBe(true);
}

/**
 * ListObjectVersions with the prefix query parameter repeated. The values are
 * set before signing, so the request is validly signed with both of them.
 */
function sendWithPrefixes(s3: S3Client, bucket: string, prefixes: string[]): Promise<unknown> {
  const command = new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefixes[0] });
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { query?: Record<string, string | string[]> };
      request.query = { ...(request.query ?? {}), prefix: prefixes };
      return next(args);
    },
    { step: 'build', name: 'repeatPrefixParameter' },
  );
  return s3.send(command);
}

function notFound(error: unknown): boolean {
  const record = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    record?.name === 'NoSuchKey' ||
    record?.name === 'NotFound' ||
    record?.$metadata?.httpStatusCode === 404
  );
}

/** Erasure as the cleanup service drives it: one durable command at a time. */
function erase(
  adapter: S3PersonalArtifactCleanupAdapter,
  input: Readonly<{ sha256: string; versionId: string }>,
): Promise<'DELETED' | 'ABSENT'> {
  return adapter.eraseFinalObject(input);
}

type FinalVersion = Readonly<{ key: string; versionId: string }>;
type CleanupLedger = {
  readonly clients: S3Client[];
  readonly keys: string[];
  readonly versions: FinalVersion[];
  readonly staging: Array<{
    store: S3GenericOperationArtifactStore;
    artifactId: string;
  }>;
};

function cleanupLedger(): CleanupLedger {
  return { clients: [], keys: [], versions: [], staging: [] };
}

function artifactStore(ledger: CleanupLedger): {
  s3: S3Client;
  store: S3GenericOperationArtifactStore;
} {
  const s3 = runtimeClient();
  ledger.clients.push(s3);
  const store = new S3GenericOperationArtifactStore({
    bucket: required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET'),
    client: s3 as never,
    logger: { warn: () => undefined },
  });
  return { s3, store };
}

async function stage(
  store: S3GenericOperationArtifactStore,
  privacyClass: 'PERSONAL_DATA' | 'CONFIDENTIAL_TENANT',
  value: Uint8Array,
  ledger: CleanupLedger,
): Promise<StagedArtifact> {
  const artifactId = randomUUID();
  ledger.keys.push(stagingObjectKey(artifactId));
  ledger.staging.push({ store, artifactId });
  const staged = await store.stage({
    artifactId,
    source: {
      body: source(value),
      mediaType: 'application/octet-stream',
    },
    maxBytes: value.byteLength,
    resultSchema: 'http-get/v1',
    privacyClass,
  });
  ledger.keys.push(
    contentAddressedObjectKey(staged.sha256, staged.privacyClass),
  );
  return staged;
}

async function promote(
  privacyClass: 'PERSONAL_DATA' | 'CONFIDENTIAL_TENANT',
  byte: number,
  ledger: CleanupLedger,
) {
  const { s3, store } = artifactStore(ledger);
  const value = new TextEncoder().encode(`${byte}:${randomUUID()}`);
  const staged = await stage(store, privacyClass, value, ledger);
  const stored = await store.promote(staged);
  ledger.versions.push({ key: stored.objectKey, versionId: stored.versionId });
  return { s3, store, staged, stored, value };
}

/**
 * A reuse whose manifest outlives the object's lifecycle expiry copies the
 * object onto itself. The test records nothing in any ledger for this version,
 * exactly like a settlement that never committed (process death, a fenced
 * SUBJECT_TOMBSTONED rollback, a lost copy ACK, a failed HEAD after the copy).
 */
async function refreshWithoutSettlement(
  store: S3GenericOperationArtifactStore,
  staged: StagedArtifact,
  ledger: CleanupLedger,
): Promise<StoredArtifact> {
  const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const refreshed = await store.promote(staged, { retainUntil: later });
  ledger.versions.push({
    key: refreshed.objectKey,
    versionId: refreshed.versionId,
  });
  return refreshed;
}

async function keyEntries(
  root: S3Client,
  bucket: string,
  key: string,
): Promise<{
  versions: Array<{ versionId: string; isLatest: boolean }>;
  deleteMarkers: Array<{ versionId: string; isLatest: boolean }>;
}> {
  const listed = await root.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
  );
  const pick = (
    entries: ReadonlyArray<{ Key?: string; VersionId?: string; IsLatest?: boolean }>,
  ) =>
    entries
      .filter((entry) => entry.Key === key)
      .map((entry) => ({
        versionId: String(entry.VersionId),
        isLatest: entry.IsLatest === true,
      }));
  return {
    versions: pick(listed.Versions ?? []),
    deleteMarkers: pick(listed.DeleteMarkers ?? []),
  };
}

async function expectNoVersionLeft(
  root: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await expect(keyEntries(root, bucket, key)).resolves.toEqual({
    versions: [],
    deleteMarkers: [],
  });
  let missing = false;
  try {
    await root.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    missing = notFound(error);
  }
  expect(missing).toBe(true);
}

/** The version a plain read of `key` returns now, or null when nothing is readable. */
async function currentVersion(
  root: S3Client,
  bucket: string,
  key: string,
): Promise<string | null> {
  try {
    const head = await root.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.VersionId ?? 'unversioned-read';
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function cleanupTrackedObjects(
  root: S3Client,
  bucket: string,
  ledger: CleanupLedger,
): Promise<void> {
  for (const staged of ledger.staging) {
    await staged.store.deleteStaging(staged.artifactId).catch(() => undefined);
  }
  for (const entry of [...ledger.versions].reverse()) {
    await root
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: entry.key,
          VersionId: entry.versionId,
        }),
      )
      .catch(() => undefined);
  }
  for (const key of new Set([
    ...ledger.versions.map((entry) => entry.key),
    ...ledger.keys,
  ])) {
    const discovered = await root.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    for (const entry of [
      ...(discovered.Versions ?? []),
      ...(discovered.DeleteMarkers ?? []),
    ]) {
      if (entry.Key === key && entry.VersionId) {
        await root.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: entry.VersionId,
          }),
        );
      }
    }
    const remaining = await root.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    expect(
      (remaining.Versions ?? []).filter((entry) => entry.Key === key),
    ).toHaveLength(0);
    expect(
      (remaining.DeleteMarkers ?? []).filter((entry) => entry.Key === key),
    ).toHaveLength(0);
  }
}

describe.runIf(enabled)('PERSONAL_DATA cleanup real MinIO boundary', () => {
  it('physically isolates delete and list authority to the personal-data prefix', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const personal = await promote('PERSONAL_DATA', 0x61, ledger);
      const confidential = await promote(
        'CONFIDENTIAL_TENANT',
        0x62,
        ledger,
      );
      for (const [prefixClass, tagClass] of [
        ['CONFIDENTIAL_TENANT', 'PERSONAL_DATA'],
        ['PERSONAL_DATA', 'CONFIDENTIAL_TENANT'],
        ['PUBLIC_ORGANIZATION', 'PERSONAL_DATA'],
      ] as const) {
        const sha256 = createHash('sha256')
          .update(`${prefixClass}:${tagClass}:${randomUUID()}`)
          .digest('hex');
        await expectDenied(
          personal.s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: contentAddressedObjectKey(sha256, prefixClass),
              Body: Uint8Array.of(0x71),
              ContentType: 'application/octet-stream',
              ServerSideEncryption: 'AES256',
              Tagging: `artifact-privacy=${tagClass}`,
            }),
          ),
        );
      }

      const untaggedSha = createHash('sha256')
        .update(`untagged:${randomUUID()}`)
        .digest('hex');
      const untaggedKey = contentAddressedObjectKey(
        untaggedSha,
        'CONFIDENTIAL_TENANT',
      );
      ledger.keys.push(untaggedKey);
      const untagged = await root.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: untaggedKey,
          Body: Uint8Array.of(0x72),
          ContentType: 'application/octet-stream',
          ServerSideEncryption: 'AES256',
        }),
      );
      const untaggedVersionId = untagged.VersionId;
      if (untaggedVersionId) {
        ledger.versions.push({
          key: untaggedKey,
          versionId: untaggedVersionId,
        });
      }
      await expectDenied(
        personal.s3.send(
          new PutObjectTaggingCommand({
            Bucket: bucket,
            Key: untaggedKey,
            VersionId: untaggedVersionId,
            Tagging: {
              TagSet: [
                { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
              ],
            },
          }),
        ),
      );

      // The cleanup principal lists the versions of one full personal-data key
      // it already knows, never a shorter prefix: with its version-read grant a
      // listable prefix would hand it every PERSONAL_DATA object in bulk.
      await expect(
        cleanup.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: personal.stored.objectKey,
          }),
        ),
      ).resolves.toBeDefined();
      const personalShard = personal.stored.objectKey.slice(
        0,
        personal.stored.objectKey.lastIndexOf('/') + 1,
      );
      for (const prefix of [
        confidential.stored.objectKey,
        'generic-operation-results/v1/final/',
        'generic-operation-results/v1/staging/',
        'generic-operation-results/v1/final/personal-data/',
        'generic-operation-results/v1/final/personal-data/sha256/',
        personalShard,
        personal.stored.objectKey.slice(0, -1),
      ]) {
        await expectDenied(
          cleanup.send(
            new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
          ),
        );
      }
      await expectDenied(
        cleanup.send(new ListObjectVersionsCommand({ Bucket: bucket })),
      );
      // A repeated prefix parameter must not widen the listing: the policy
      // requires EVERY prefix value to be the full key (ForAllValues), because
      // MinIO lists by the first value while a plain StringLike passes on any.
      for (const shorter of ['generic-operation-results/v1/final/personal-data/', '']) {
        await expectDenied(
          sendWithPrefixes(cleanup, bucket, [shorter, personal.stored.objectKey]),
        );
      }

      await expect(
        erase(adapter, {
          sha256: personal.stored.sha256,
          versionId: personal.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      await expect(
        erase(adapter, {
          sha256: confidential.stored.sha256,
          versionId: confidential.stored.versionId,
        }),
      ).resolves.toBe('ABSENT');
      await expect(
        root.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: confidential.stored.objectKey,
            VersionId: confidential.stored.versionId,
          }),
        ),
      ).resolves.toMatchObject({ VersionId: confidential.stored.versionId });
      await expectDenied(
        cleanup.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: confidential.stored.objectKey,
            VersionId: confidential.stored.versionId,
          }),
        ),
      );
      await expectDenied(
        cleanup.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        ),
      );
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('erases a refresh copy that no settlement recorded, so the key holds no version at all', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const first = await promote('PERSONAL_DATA', 0x64, ledger);
      const refreshed = await refreshWithoutSettlement(
        first.store,
        first.staged,
        ledger,
      );
      expect(refreshed.versionId).not.toBe(first.stored.versionId);
      const before = await keyEntries(root, bucket, first.stored.objectKey);
      expect(before.versions.find((entry) => entry.isLatest)?.versionId).toBe(
        refreshed.versionId,
      );

      // The only durable command names the settled first version.
      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: first.stored.versionId,
        }),
      ).resolves.toBe('DELETED');

      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
      await expect(
        first.store.inspect(first.stored.sha256, 'PERSONAL_DATA'),
      ).resolves.toBeNull();
      await expect(
        first.store.read(first.stored.sha256, 'PERSONAL_DATA'),
      ).rejects.toEqual(
        new ArtifactStorageError('GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING'),
      );
      // A later command for a version this erasure already removed completes ABSENT.
      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: refreshed.versionId,
        }),
      ).resolves.toBe('ABSENT');
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('erasing the current version never makes an older version current again', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const first = await promote('PERSONAL_DATA', 0x65, ledger);
      const refreshed = await refreshWithoutSettlement(
        first.store,
        first.staged,
        ledger,
      );

      // After every delete the erasure sends, record what a plain read sees.
      const readable: Array<string | null> = [];
      const observed = new S3PersonalArtifactCleanupAdapter({
        bucket,
        client: {
          send: async (command: object) => {
            const output = await cleanup.send(command as never);
            if (command instanceof DeleteObjectCommand) {
              readable.push(
                await currentVersion(root, bucket, first.stored.objectKey),
              );
            }
            return output;
          },
        },
      });

      // Only the current (refreshed) version is commanded; the older one is noncurrent.
      await expect(
        erase(observed, {
          sha256: first.stored.sha256,
          versionId: refreshed.versionId,
        }),
      ).resolves.toBe('DELETED');
      // The noncurrent version goes first, so the refreshed one stays current
      // until it goes too; the older bytes are never readable on the way.
      expect(readable).toEqual([refreshed.versionId, null]);
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: refreshed.versionId,
        }),
      ).resolves.toBe('ABSENT');
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('keeps going when another sweep removed a listed version before its delete', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    try {
      const first = await promote('PERSONAL_DATA', 0x69, ledger);
      const refreshed = await refreshWithoutSettlement(
        first.store,
        first.staged,
        ledger,
      );
      const raced: unknown[] = [];
      const adapter = new S3PersonalArtifactCleanupAdapter({
        bucket,
        client: {
          send: async (command: object) => {
            const racing =
              command instanceof DeleteObjectCommand &&
              command.input.VersionId === first.stored.versionId &&
              raced.length === 0;
            if (racing) {
              // A second deletion request sweeping the same shared digest wins the race.
              await root.send(
                new DeleteObjectCommand({
                  Bucket: bucket,
                  Key: first.stored.objectKey,
                  VersionId: first.stored.versionId,
                }),
              );
            }
            const output = await cleanup.send(command as never);
            if (racing) raced.push(output);
            return output;
          },
        },
      });

      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: first.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      // MinIO acknowledges a delete of a version that is already gone without
      // naming any version; the erasure confirms the absence and carries on.
      expect(raced).toHaveLength(1);
      expect((raced[0] as { VersionId?: string }).VersionId).toBeUndefined();
      expect(refreshed.versionId).not.toBe(first.stored.versionId);
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('removes delete markers only after every object version is gone', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const first = await promote('PERSONAL_DATA', 0x66, ledger);
      // A plain DELETE puts a delete marker on top; the version beneath stays stored.
      await root.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: first.stored.objectKey }),
      );
      const hidden = await keyEntries(root, bucket, first.stored.objectKey);
      expect(hidden.versions).toEqual([
        { versionId: first.stored.versionId, isLatest: false },
      ]);
      expect(hidden.deleteMarkers).toHaveLength(1);

      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: first.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('erases every version whoever wrote it and cannot mutate tags', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const first = await promote('PERSONAL_DATA', 0x63, ledger);
      const bytes = first.value;
      const sha256 = first.stored.sha256;
      const second = await root.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: contentAddressedObjectKey(sha256, 'PERSONAL_DATA'),
          Body: bytes,
          ContentType: 'application/octet-stream',
          Metadata: objectMetadata({
            sha256,
            sizeBytes: String(bytes.byteLength),
            mediaType: 'application/octet-stream',
            resultSchema: 'http-get/v1',
            privacyClass: 'PERSONAL_DATA',
          }),
          Tagging: 'artifact-privacy=PERSONAL_DATA',
          ServerSideEncryption: 'AES256',
        }),
      );
      const secondVersionId = second.VersionId;
      expect(secondVersionId).toEqual(expect.any(String));
      if (secondVersionId) {
        ledger.versions.push({
          key: first.stored.objectKey,
          versionId: secondVersionId,
        });
      }

      await expectDenied(
        cleanup.send(
          new PutObjectTaggingCommand({
            Bucket: bucket,
            Key: first.stored.objectKey,
            VersionId: first.stored.versionId,
            Tagging: {
              TagSet: [
                { Key: 'artifact-privacy', Value: 'CONFIDENTIAL_TENANT' },
              ],
            },
          }),
        ),
      );
      await expectDenied(
        cleanup.send(
          new DeleteObjectTaggingCommand({
            Bucket: bucket,
            Key: first.stored.objectKey,
            VersionId: first.stored.versionId,
          }),
        ),
      );

      await expect(
        erase(adapter, { sha256, versionId: first.stored.versionId }),
      ).resolves.toBe('DELETED');
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('refuses the whole key when any version lacks the PERSONAL_DATA tag and deletes nothing', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      const first = await promote('PERSONAL_DATA', 0x67, ledger);
      const untagged = await root.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: first.stored.objectKey,
          Body: first.value,
          ContentType: 'application/octet-stream',
          ServerSideEncryption: 'AES256',
        }),
      );
      if (untagged.VersionId) {
        ledger.versions.push({
          key: first.stored.objectKey,
          versionId: untagged.VersionId,
        });
      }

      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: first.stored.versionId,
        }),
      ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
      const entries = await keyEntries(root, bucket, first.stored.objectKey);
      expect(entries.versions.map((entry) => entry.versionId).sort()).toEqual(
        [first.stored.versionId, String(untagged.VersionId)].sort(),
      );
      expect(entries.deleteMarkers).toEqual([]);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('leaves every other manifest of a shared object with OBJECT_MISSING, never stale bytes', async () => {
    const ledger = cleanupLedger();
    const cleanup = cleanupClient();
    const root = rootClient();
    const bucket = required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET');
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket,
      client: cleanup as never,
    });
    try {
      // Two subjects' operations produced the same bytes: one content object.
      const first = await promote('PERSONAL_DATA', 0x68, ledger);
      const other = artifactStore(ledger);
      const otherStaged = await stage(
        other.store,
        'PERSONAL_DATA',
        first.value,
        ledger,
      );
      const otherStored = await refreshWithoutSettlement(
        other.store,
        otherStaged,
        ledger,
      );
      expect(otherStored.objectKey).toBe(first.stored.objectKey);

      await expect(
        erase(adapter, {
          sha256: first.stored.sha256,
          versionId: first.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      await expectNoVersionLeft(root, bucket, first.stored.objectKey);

      // The other subject's manifest is still live in the database; replay reads it.
      const workspaceId = randomUUID();
      const authorityId = randomUUID();
      const operationId = randomUUID();
      const artifactId = otherStaged.artifactId;
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const manifest = Object.freeze({
        schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
        artifactId,
        scopeKind: 'workspace' as const,
        workspaceId,
        authorityId,
        operationId,
        resultSchema: 'http-get/v1' as const,
        objectKey: otherStored.objectKey,
        sha256: otherStored.sha256,
        sizeBytes: otherStored.sizeBytes,
        mediaType: otherStored.mediaType,
        privacyClass: 'PERSONAL_DATA' as const,
        sourceDigest: null,
        createdAt: new Date().toISOString(),
        expiresAt,
      });
      const repository = {
        findExact: async () =>
          Object.freeze({
            manifest,
            expectedFacts: Object.freeze({
              status: 200,
              ok: true,
              sanitizedUrl: 'https://example.com/final',
              blocked: null,
            }),
          }),
      } as unknown as GenericOperationArtifactRepository;
      const service = new GenericOperationArtifactService(
        repository,
        other.store,
        {} as never,
      );
      await expect(
        service.readVerified({
          scopeKind: 'workspace',
          workspaceId,
          authorityId,
          reference: {
            schemaVersion: 'generic-operation-artifact-ref/v1',
            artifactId,
            operationId,
            resultSchema: 'http-get/v1',
            sha256: otherStored.sha256,
            sizeBytes: otherStored.sizeBytes,
            mediaType: otherStored.mediaType,
            expiresAt,
          },
        }),
      ).rejects.toEqual(
        new GenericOperationArtifactError(
          'GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING',
        ),
      );
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('reports ready only when the cleanup principal can list personal-data versions', async () => {
    const runtime = createPersonalArtifactCleanupRuntime({
      GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_ENDPOINT',
      ),
      GENERIC_OPERATION_ARTIFACT_S3_BUCKET: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET',
      ),
      GENERIC_OPERATION_ARTIFACT_S3_REGION: 'us-east-1',
      GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
      GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_ACCESS_KEY',
      ),
      GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_SECRET_KEY',
      ),
    });
    // The runtime principal reads the bucket location too, but cannot list final versions.
    const runtimeOnly = createPersonalArtifactCleanupRuntime({
      GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_ENDPOINT',
      ),
      GENERIC_OPERATION_ARTIFACT_S3_BUCKET: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET',
      ),
      GENERIC_OPERATION_ARTIFACT_S3_REGION: 'us-east-1',
      GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
      GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_RUNTIME_ACCESS_KEY',
      ),
      GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: required(
        'PERSONAL_ARTIFACT_CLEANUP_MINIO_RUNTIME_SECRET_KEY',
      ),
    });
    try {
      await expect(runtime.checkReadiness()).resolves.toEqual({ status: 'ok' });
      await expect(runtimeOnly.checkReadiness()).resolves.toEqual({
        status: 'failed',
        code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
      });
    } finally {
      runtime.destroy();
      runtimeOnly.destroy();
    }
  });

  it('does not convert a missing bucket into ABSENT', async () => {
    const cleanup = cleanupClient();
    try {
      const adapter = new S3PersonalArtifactCleanupAdapter({
        bucket: `missing-${randomUUID()}`,
        client: cleanup as never,
      });
      await expect(
        erase(adapter, {
          sha256: 'ab'.repeat(32),
          versionId: 'known-version-id',
        }),
      ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    } finally {
      cleanup.destroy();
    }
  });
});
