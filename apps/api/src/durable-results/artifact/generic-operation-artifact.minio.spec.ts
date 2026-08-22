import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStorageError,
  S3GenericOperationArtifactStore,
} from './generic-operation-artifact.store';
import { contentAddressedObjectKey } from './artifact-key';
import { checkGenericArtifactStorageReadiness } from '../../runtime/managed-dependency-readiness';

const enabled = process.env.GENERIC_OPERATION_ARTIFACT_MINIO_TEST === '1';
const MAX_ARTIFACT_BYTES = 33_554_432;
const CHUNK_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

if (enabled) {
  if (process.env.GENERIC_OPERATION_ARTIFACT_MINIO_DISPOSABLE !== '1') {
    throw new Error('MINIO_TEST_DISPOSABLE_REQUIRED');
  }
  if (
    !/^operation-artifacts-t7-[0-9a-f]{8}$/u.test(
      required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
    )
  ) {
    throw new Error('MINIO_TEST_DISPOSABLE_BUCKET_REQUIRED');
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MINIO_TEST_CONFIG_REQUIRED:${name}`);
  return value;
}

function client(accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: required('GENERIC_OPERATION_ARTIFACT_MINIO_ENDPOINT'),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

function runtimeClient(): S3Client {
  return client(
    required('GENERIC_OPERATION_ARTIFACT_MINIO_ACCESS_KEY'),
    required('GENERIC_OPERATION_ARTIFACT_MINIO_SECRET_KEY'),
  );
}

function rootClient(): S3Client {
  return client(
    required('GENERIC_OPERATION_ARTIFACT_MINIO_ROOT_ACCESS_KEY'),
    required('GENERIC_OPERATION_ARTIFACT_MINIO_ROOT_SECRET_KEY'),
  );
}

function personalReadClient(): S3Client {
  return client(
    required('GENERIC_OPERATION_ARTIFACT_MINIO_PERSONAL_READ_ACCESS_KEY'),
    required('GENERIC_OPERATION_ARTIFACT_MINIO_PERSONAL_READ_SECRET_KEY'),
  );
}

function sourceOfLength(size: number, byte = 0x61): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      let remaining = size;
      while (remaining > 0) {
        const length = Math.min(CHUNK_BYTES, remaining);
        remaining -= length;
        yield new Uint8Array(length).fill(byte);
      }
    },
  };
}

function hashOfLength(size: number, byte = 0x61): string {
  const hash = createHash('sha256');
  let remaining = size;
  while (remaining > 0) {
    const length = Math.min(CHUNK_BYTES, remaining);
    remaining -= length;
    hash.update(new Uint8Array(length).fill(byte));
  }
  return hash.digest('hex');
}

async function bytes(body: unknown): Promise<Uint8Array> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
    throw new Error('MINIO_TEST_BODY_UNAVAILABLE');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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
    const result = (await promise) as { Body?: { destroy?: () => void } };
    result.Body?.destroy?.();
  } catch (error) {
    observed = denied(error);
  }
  expect(observed).toBe(true);
}

function artifactStore(s3: S3Client): S3GenericOperationArtifactStore {
  return new S3GenericOperationArtifactStore({
    bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
    client: s3 as never,
  });
}

function managedReadinessEnv(): NodeJS.ProcessEnv {
  return {
    GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: required(
      'GENERIC_OPERATION_ARTIFACT_MINIO_ENDPOINT',
    ),
    GENERIC_OPERATION_ARTIFACT_S3_BUCKET: required(
      'GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET',
    ),
    GENERIC_OPERATION_ARTIFACT_S3_REGION: 'us-east-1',
    GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: required(
      'GENERIC_OPERATION_ARTIFACT_MINIO_ACCESS_KEY',
    ),
    GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: required(
      'GENERIC_OPERATION_ARTIFACT_MINIO_SECRET_KEY',
    ),
    GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
  };
}

async function readFromFreshServiceProcess(sha256: string): Promise<number> {
  const program = `
    import { S3Client } from '@aws-sdk/client-s3';
    import { S3GenericOperationArtifactStore } from './src/durable-results/artifact/generic-operation-artifact.store.ts';
    const client = new S3Client({
      endpoint: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_ENDPOINT,
      region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_ACCESS_KEY,
        secretAccessKey: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_SECRET_KEY,
      },
    });
    const store = new S3GenericOperationArtifactStore({
      bucket: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET,
      client,
    });
    const body = await store.read(process.argv[1]);
    let size = 0;
    for await (const chunk of body) size += chunk.byteLength;
    client.destroy();
    process.stdout.write(String(size));
  `;
  const result = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, sha256],
    { cwd: process.cwd(), env: process.env, timeout: 15_000, maxBuffer: 1024 },
  );
  return Number(result.stdout.trim());
}

async function materializeHttpFromFreshServiceProcess(
  sha256: string,
  sizeBytes: string,
): Promise<unknown> {
  const program = `
    import { S3Client } from '@aws-sdk/client-s3';
    import { S3GenericOperationArtifactStore } from './src/durable-results/artifact/generic-operation-artifact.store.ts';
    import { httpGetMaterializer } from './src/durable-results/artifact/materializers/http-get.materializer.ts';
    const [sha256, sizeBytes] = process.argv.slice(1);
    const client = new S3Client({
      endpoint: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_ENDPOINT,
      region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_ACCESS_KEY,
        secretAccessKey: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_SECRET_KEY,
      },
    });
    const store = new S3GenericOperationArtifactStore({
      bucket: process.env.GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET,
      client,
    });
    const output = await httpGetMaterializer.materialize(
      await store.read(sha256),
      {
        schemaVersion: 'generic-operation-artifact/v1',
        artifactId: '11111111-1111-4111-8111-111111111111',
        scopeKind: 'workspace', workspaceId: '22222222-2222-4222-8222-222222222222',
        authorityId: '33333333-3333-4333-8333-333333333333',
        operationId: '44444444-4444-4444-8444-444444444444',
        resultSchema: 'http-get/v1',
        objectKey: 'generic-operation-results/v1/sha256/' + sha256.slice(0, 2) + '/' + sha256,
        sha256, sizeBytes, mediaType: 'text/plain',
        privacyClass: 'PUBLIC_ORGANIZATION', sourceDigest: null,
        createdAt: '2026-08-22T00:00:00.000Z', expiresAt: '2099-08-22T00:00:00.000Z',
      },
      { status: 200, ok: true, sanitizedUrl: 'https://example.com/final', blocked: null },
    );
    client.destroy();
    process.stdout.write(JSON.stringify(output));
  `;
  const result = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      program,
      sha256,
      sizeBytes,
    ],
    { cwd: process.cwd(), env: process.env, timeout: 15_000, maxBuffer: 4096 },
  );
  return JSON.parse(result.stdout);
}

describe.runIf(enabled)(
  'S3GenericOperationArtifactStore real MinIO contract',
  () => {
    it('persists the maximum object through one client and reuses it immutably through a second client', async () => {
      const firstClient = runtimeClient();
      const secondClient = runtimeClient();
      const admin = rootClient();
      const first = artifactStore(firstClient);
      const second = artifactStore(secondClient);
      const artifactId = randomUUID();
      try {
        const staged = await first.stage({
          artifactId,
          source: {
            body: sourceOfLength(MAX_ARTIFACT_BYTES),
            mediaType: 'application/xml',
          },
          maxBytes: MAX_ARTIFACT_BYTES,
          resultSchema: 'sanctions-download/v1',
          privacyClass: 'PERSONAL_DATA',
        });
        expect(staged.sizeBytes).toBe(String(MAX_ARTIFACT_BYTES));
        expect(staged.sha256).toBe(hashOfLength(MAX_ARTIFACT_BYTES));

        const stored = await first.promote(staged);
        await expect(second.promote(staged)).resolves.toEqual(stored);
        await expect(second.inspect(staged.sha256)).resolves.toEqual(stored);

        const read = await second.read(staged.sha256);
        let readBytes = 0;
        for await (const chunk of read) readBytes += chunk.byteLength;
        expect(readBytes).toBe(MAX_ARTIFACT_BYTES);
        await expect(readFromFreshServiceProcess(staged.sha256)).resolves.toBe(
          MAX_ARTIFACT_BYTES,
        );

        const runtime = runtimeClient();
        await expect(
          runtime.send(
            new PutObjectCommand({
              Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
              Key: stored.objectKey,
              Body: Uint8Array.of(0),
              IfNoneMatch: '*',
            }),
          ),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });

        const untaggedClient = runtimeClient();
        try {
          const untaggedSha = createHash('sha256')
            .update(`untagged-${randomUUID()}`)
            .digest('hex');
          await expectDenied(
            untaggedClient.send(
              new PutObjectCommand({
                Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
                Key: contentAddressedObjectKey(untaggedSha),
                Body: Uint8Array.of(1),
                ContentType: 'application/octet-stream',
                ServerSideEncryption: 'AES256',
              }),
            ),
          );
          for (const tagging of [
            'artifact-privacy=UNKNOWN',
            'artifact-privacy=PERSONAL_DATA&attacker=retention-bypass',
          ]) {
            const invalidTagSha = createHash('sha256')
              .update(`${tagging}-${randomUUID()}`)
              .digest('hex');
            await expectDenied(
              untaggedClient.send(
                new PutObjectCommand({
                  Bucket: required(
                    'GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET',
                  ),
                  Key: contentAddressedObjectKey(invalidTagSha),
                  Body: Uint8Array.of(1),
                  ContentType: 'application/octet-stream',
                  ServerSideEncryption: 'AES256',
                  Tagging: tagging,
                }),
              ),
            );
          }
        } finally {
          untaggedClient.destroy();
        }

        const tagMutationClient = runtimeClient();
        try {
          await expectDenied(
            tagMutationClient.send(
              new PutObjectTaggingCommand({
                Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
                Key: stored.objectKey,
                Tagging: {
                  TagSet: [
                    {
                      Key: 'artifact-privacy',
                      Value: 'PUBLIC_ORGANIZATION',
                    },
                  ],
                },
              }),
            ),
          );
          await expectDenied(
            tagMutationClient.send(
              new DeleteObjectTaggingCommand({
                Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
                Key: stored.objectKey,
              }),
            ),
          );
        } finally {
          tagMutationClient.destroy();
        }

        const deleteClient = runtimeClient();
        try {
          await expectDenied(
            deleteClient.send(
              new DeleteObjectCommand({
                Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
                Key: stored.objectKey,
              }),
            ),
          );
        } finally {
          deleteClient.destroy();
        }

        const tags = await admin.send(
          new GetObjectTaggingCommand({
            Bucket: required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET'),
            Key: stored.objectKey,
          }),
        );
        expect(tags.TagSet).toEqual([
          { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
        ]);
      } finally {
        await first.deleteStaging(artifactId).catch(() => undefined);
        firstClient.destroy();
        secondClient.destroy();
        admin.destroy();
      }
    }, 60_000);

    it('detects corrupt staging replacement and final metadata drift without accepting attacker bytes', async () => {
      const runtime = runtimeClient();
      const root = rootClient();
      const store = artifactStore(runtime);
      const artifactId = randomUUID();
      const bucket = required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET');
      try {
        const staged = await store.stage({
          artifactId,
          source: { body: sourceOfLength(1024, 0x62), mediaType: 'text/plain' },
          maxBytes: 1024,
          resultSchema: 'http-get/v1',
          privacyClass: 'CONFIDENTIAL_TENANT',
        });
        await root.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: staged.stagingKey,
            Body: new Uint8Array(1024).fill(0x63),
            ContentType: 'text/plain',
          }),
        );
        await expect(store.promote(staged)).rejects.toMatchObject({
          code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
        } satisfies Partial<ArtifactStorageError>);

        const cleanId = randomUUID();
        const clean = await store.stage({
          artifactId: cleanId,
          source: { body: sourceOfLength(32, 0x64), mediaType: 'text/plain' },
          maxBytes: 32,
          resultSchema: 'http-get/v1',
          privacyClass: 'CONFIDENTIAL_TENANT',
        });
        const stored = await store.promote(clean);
        await root.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: stored.objectKey,
            Body: new Uint8Array(32).fill(0x64),
            ContentType: 'text/plain',
            Metadata: {
              schema: 'generic-operation-artifact-object/v1',
              sha256: clean.sha256,
              'size-bytes': clean.sizeBytes,
              'result-schema': 'http-get/v1',
              'privacy-class': 'CONFIDENTIAL_TENANT',
            },
            Tagging: 'artifact-privacy=PERSONAL_DATA',
          }),
        );
        const driftClient = runtimeClient();
        try {
          await expect(
            artifactStore(driftClient).promote(clean),
          ).rejects.toMatchObject({
            code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
          } satisfies Partial<ArtifactStorageError>);
        } finally {
          driftClient.destroy();
        }
        await store.deleteStaging(cleanId);

        const multipartKey = `generic-operation-results/v1/staging/${randomUUID()}`;
        const multipart = await runtime.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: multipartKey,
            ContentType: 'application/octet-stream',
            ServerSideEncryption: 'AES256',
          }),
        );
        expect(multipart.UploadId).toEqual(expect.any(String));
        await runtime.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: multipartKey,
            UploadId: multipart.UploadId,
          }),
        );
        const remainingUploads = await root.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: multipartKey,
          }),
        );
        expect(remainingUploads.Uploads ?? []).toHaveLength(0);
      } finally {
        await store.deleteStaging(artifactId).catch(() => undefined);
        runtime.destroy();
        root.destroy();
      }
    }, 20_000);

    it('reads back fixed lifecycle classes, versioning, encryption and encrypted objects', async () => {
      const admin = rootClient();
      const bucket = required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET');
      try {
        const [versioning, encryption, lifecycle] = await Promise.all([
          admin.send(new GetBucketVersioningCommand({ Bucket: bucket })),
          admin.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
          admin.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
          ),
        ]);
        expect(versioning.Status).toBe('Enabled');
        expect(encryption.ServerSideEncryptionConfiguration?.Rules).toEqual([
          expect.objectContaining({
            ApplyServerSideEncryptionByDefault: expect.objectContaining({
              SSEAlgorithm: 'AES256',
            }),
          }),
        ]);
        expect(lifecycle.Rules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ID: 'generic-operation-artifact-public-organization-ttl',
              Status: 'Enabled',
              Expiration: expect.objectContaining({
                Days: 30,
              }),
              NoncurrentVersionExpiration: expect.objectContaining({
                NoncurrentDays: 30,
              }),
            }),
            expect.objectContaining({
              ID: 'generic-operation-artifact-confidential-tenant-ttl',
              Status: 'Enabled',
              Expiration: expect.objectContaining({
                Days: 7,
              }),
              NoncurrentVersionExpiration: expect.objectContaining({
                NoncurrentDays: 7,
              }),
            }),
            expect.objectContaining({
              ID: 'generic-operation-artifact-personal-data-ttl',
              Status: 'Enabled',
              Expiration: expect.objectContaining({
                Days: 1,
              }),
              NoncurrentVersionExpiration: expect.objectContaining({
                NoncurrentDays: 1,
              }),
            }),
            expect.objectContaining({
              ID: 'generic-operation-artifact-readiness-cleanup',
              Status: 'Enabled',
              Expiration: expect.objectContaining({
                ExpiredObjectDeleteMarker: true,
              }),
            }),
          ]),
        );

        const runtime = runtimeClient();
        const store = artifactStore(runtime);
        const artifactId = randomUUID();
        const staged = await store.stage({
          artifactId,
          source: { body: sourceOfLength(16), mediaType: 'text/plain' },
          maxBytes: 16,
          resultSchema: 'http-get/v1',
          privacyClass: 'PUBLIC_ORGANIZATION',
        });
        const stored = await store.promote(staged);
        const head = await admin.send(
          new HeadObjectCommand({ Bucket: bucket, Key: stored.objectKey }),
        );
        expect(head.ServerSideEncryption).toBe('AES256');
        expect(head.VersionId).toEqual(expect.any(String));
        await expect(
          materializeHttpFromFreshServiceProcess(
            stored.sha256,
            stored.sizeBytes,
          ),
        ).resolves.toEqual({
          status: 200,
          ok: true,
          mediaType: 'text/plain',
          text: 'a'.repeat(16),
          finalUrl: 'https://example.com/final',
        });
        await store.deleteStaging(artifactId);
        runtime.destroy();
      } finally {
        admin.destroy();
      }
    });

    it('limits the PERSONAL_DATA read role to tagged PERSONAL_DATA objects', async () => {
      const runtime = runtimeClient();
      const personalReader = personalReadClient();
      const store = artifactStore(runtime);
      const bucket = required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET');
      const objects: Array<{
        artifactId: string;
        key: string;
        privacy: string;
      }> = [];
      try {
        for (const [privacy, byte] of [
          ['PUBLIC_ORGANIZATION', 0x65],
          ['CONFIDENTIAL_TENANT', 0x66],
          ['PERSONAL_DATA', 0x67],
        ] as const) {
          const artifactId = randomUUID();
          const staged = await store.stage({
            artifactId,
            source: { body: sourceOfLength(8, byte), mediaType: 'text/plain' },
            maxBytes: 8,
            resultSchema: 'http-get/v1',
            privacyClass: privacy,
          });
          const stored = await store.promote(staged);
          objects.push({ artifactId, key: stored.objectKey, privacy });
        }

        const personal = objects.find(
          (object) => object.privacy === 'PERSONAL_DATA',
        )!;
        const allowed = await personalReader.send(
          new GetObjectCommand({ Bucket: bucket, Key: personal.key }),
        );
        expect(await bytes(allowed.Body)).toHaveLength(8);
        for (const object of objects.filter(
          (candidate) => candidate.privacy !== 'PERSONAL_DATA',
        )) {
          const deniedClient = personalReadClient();
          try {
            await expectDenied(
              deniedClient.send(
                new HeadObjectCommand({ Bucket: bucket, Key: object.key }),
              ),
            );
          } finally {
            deniedClient.destroy();
          }
        }
      } finally {
        for (const object of objects) {
          await store.deleteStaging(object.artifactId).catch(() => undefined);
        }
        runtime.destroy();
        personalReader.destroy();
      }
    });

    it('runs a bounded write/read/delete readiness canary and never provisions a missing bucket', async () => {
      const runtime = runtimeClient();
      const admin = rootClient();
      const store = artifactStore(runtime);
      const bucket = required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET');
      try {
        await expect(store.checkReadiness()).resolves.toEqual({
          status: 'ready',
        });
        await expect(
          checkGenericArtifactStorageReadiness(managedReadinessEnv()),
        ).resolves.toEqual({ status: 'ok' });
        const canaries = await admin.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'generic-operation-results/v1/readiness/',
          }),
        );
        expect(canaries.Contents ?? []).toHaveLength(0);
        const canaryVersions = await admin.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: 'generic-operation-results/v1/readiness/',
          }),
        );
        expect(canaryVersions.Versions ?? []).toHaveLength(0);
        expect(canaryVersions.DeleteMarkers ?? []).toHaveLength(0);

        const missingBucket = `missing-artifact-${randomUUID()}`;
        const missingStore = new S3GenericOperationArtifactStore({
          bucket: missingBucket,
          client: runtime as never,
        });
        await expect(missingStore.checkReadiness()).resolves.toEqual({
          status: 'not_ready',
          code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
        });
        await expect(
          admin.send(new HeadBucketCommand({ Bucket: missingBucket })),
        ).rejects.toBeTruthy();
      } finally {
        runtime.destroy();
        admin.destroy();
      }
    });

    it('fails closed when only the MinIO all-version expiry extension drifts', async () => {
      const runtime = runtimeClient();
      const admin = rootClient();
      const bucket = required('GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET');
      try {
        const standardLifecycle = await admin.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        );
        await admin.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: { Rules: standardLifecycle.Rules ?? [] },
          }),
        );
        await expect(artifactStore(runtime).checkReadiness()).resolves.toEqual({
          status: 'ready',
        });
        await expect(
          checkGenericArtifactStorageReadiness(managedReadinessEnv()),
        ).resolves.toEqual({
          status: 'failed',
          code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
        });
      } finally {
        runtime.destroy();
        admin.destroy();
      }
    });
  },
);
