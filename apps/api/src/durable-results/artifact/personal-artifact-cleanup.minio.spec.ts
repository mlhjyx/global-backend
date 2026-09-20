import {
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
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
import { objectMetadata } from './generic-operation-artifact.object-contract';
import { S3GenericOperationArtifactStore } from './generic-operation-artifact.store';
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

async function promote(
  privacyClass: 'PERSONAL_DATA' | 'CONFIDENTIAL_TENANT',
  byte: number,
  ledger: CleanupLedger,
) {
  const s3 = runtimeClient();
  ledger.clients.push(s3);
  const store = new S3GenericOperationArtifactStore({
    bucket: required('PERSONAL_ARTIFACT_CLEANUP_MINIO_BUCKET'),
    client: s3 as never,
  });
  const artifactId = randomUUID();
  ledger.keys.push(stagingObjectKey(artifactId));
  ledger.staging.push({ store, artifactId });
  const value = new TextEncoder().encode(`${byte}:${randomUUID()}`);
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
  const stored = await store.promote(staged);
  ledger.versions.push({ key: stored.objectKey, versionId: stored.versionId });
  return { artifactId, s3, store, stored, value };
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
  it('physically isolates delete authority to the personal-data prefix', async () => {
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

      await expect(
        adapter.deleteFinalVersion({
          sha256: personal.stored.sha256,
          versionId: personal.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      await expect(
        adapter.deleteFinalVersion({
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

  it('deletes only one tagged exact version and cannot mutate tags', async () => {
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
        adapter.deleteFinalVersion({
          sha256,
          versionId: first.stored.versionId,
        }),
      ).resolves.toBe('DELETED');
      await expect(
        root.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: first.stored.objectKey,
            VersionId: secondVersionId,
          }),
        ),
      ).resolves.toMatchObject({ VersionId: secondVersionId });
      const versions = await root.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: first.stored.objectKey,
        }),
      );
      expect(versions.DeleteMarkers ?? []).toHaveLength(0);
    } finally {
      await cleanupTrackedObjects(root, bucket, ledger);
      for (const client of ledger.clients) client.destroy();
      cleanup.destroy();
      root.destroy();
    }
  }, 20_000);

  it('does not convert a missing bucket into ABSENT', async () => {
    const cleanup = cleanupClient();
    try {
      const adapter = new S3PersonalArtifactCleanupAdapter({
        bucket: `missing-${randomUUID()}`,
        client: cleanup as never,
      });
      await expect(
        adapter.deleteFinalVersion({
          sha256: 'ab'.repeat(32),
          versionId: 'known-version-id',
        }),
      ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    } finally {
      cleanup.destroy();
    }
  });
});
