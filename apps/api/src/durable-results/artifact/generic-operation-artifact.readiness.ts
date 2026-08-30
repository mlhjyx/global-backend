import {
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ExecutionControlError } from '../../execution-budget/execution-control-error';

export interface ArtifactReadinessS3Client {
  send(command: object): Promise<unknown>;
}

export type ArtifactStorageReadiness =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'not_ready';
      code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE';
    }>;

const READINESS_PREFIX = 'generic-operation-results/v1/readiness/';
const READINESS_BODY = Uint8Array.from([
  0x67, 0x65, 0x6e, 0x65, 0x72, 0x69, 0x63, 0x2d, 0x61, 0x72, 0x74, 0x69, 0x66,
  0x61, 0x63, 0x74, 0x2d, 0x72, 0x65, 0x61, 0x64, 0x69, 0x6e, 0x65, 0x73, 0x73,
  0x2d, 0x76, 0x31,
]);

type ExpectedLifecycleRule = Readonly<{
  id: string;
  days?: number;
  noncurrentDays?: number;
  expiredDeleteMarker?: boolean;
  prefix?: string;
  tag?: Readonly<{ key: string; value: string }>;
}>;

const EXPECTED_LIFECYCLE_RULES: readonly ExpectedLifecycleRule[] =
  Object.freeze([
    Object.freeze({
      id: 'generic-operation-artifact-staging-ttl',
      days: 1,
      noncurrentDays: 1,
      prefix: 'generic-operation-results/v1/staging/',
    }),
    Object.freeze({
      id: 'generic-operation-artifact-public-organization-ttl',
      days: 30,
      noncurrentDays: 30,
      tag: Object.freeze({
        key: 'artifact-privacy',
        value: 'PUBLIC_ORGANIZATION',
      }),
    }),
    Object.freeze({
      id: 'generic-operation-artifact-confidential-tenant-ttl',
      days: 7,
      noncurrentDays: 7,
      tag: Object.freeze({
        key: 'artifact-privacy',
        value: 'CONFIDENTIAL_TENANT',
      }),
    }),
    Object.freeze({
      id: 'generic-operation-artifact-personal-data-ttl',
      days: 1,
      noncurrentDays: 1,
      tag: Object.freeze({ key: 'artifact-privacy', value: 'PERSONAL_DATA' }),
    }),
    Object.freeze({
      id: 'generic-operation-artifact-staging-delete-markers',
      expiredDeleteMarker: true,
      prefix: 'generic-operation-results/v1/staging/',
    }),
    Object.freeze({
      id: 'generic-operation-artifact-final-delete-markers',
      expiredDeleteMarker: true,
      prefix: 'generic-operation-results/v1/sha256/',
    }),
    Object.freeze({
      id: 'generic-operation-artifact-readiness-cleanup',
      expiredDeleteMarker: true,
      noncurrentDays: 1,
      prefix: 'generic-operation-results/v1/readiness/',
    }),
  ]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isAsyncByteIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function',
  );
}

function isNotFound(error: unknown): boolean {
  const record = asRecord(error);
  const metadata = asRecord(record?.$metadata);
  const name = error instanceof Error ? error.name : '';
  return (
    metadata?.httpStatusCode === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === '404'
  );
}

function readableBody(body: Iterable<Uint8Array>): Readable {
  const stream = Readable.from(body);
  stream.on('error', () => undefined);
  return stream;
}

function hasExpectedEncryption(value: unknown): boolean {
  const configuration = asRecord(
    asRecord(value)?.ServerSideEncryptionConfiguration,
  );
  const rules = configuration?.Rules;
  if (!Array.isArray(rules) || rules.length !== 1) return false;
  const defaultEncryption = asRecord(
    asRecord(rules[0])?.ApplyServerSideEncryptionByDefault,
  );
  return defaultEncryption?.SSEAlgorithm === 'AES256';
}

function hasExpectedLifecycle(value: unknown): boolean {
  const rules = asRecord(value)?.Rules;
  if (
    !Array.isArray(rules) ||
    rules.length !== EXPECTED_LIFECYCLE_RULES.length
  ) {
    return false;
  }
  const actual = new Map<string, Record<string, unknown>>();
  for (const candidate of rules) {
    const rule = asRecord(candidate);
    if (
      !rule ||
      typeof rule.ID !== 'string' ||
      rule.Status !== 'Enabled' ||
      actual.has(rule.ID)
    ) {
      return false;
    }
    actual.set(rule.ID, rule);
  }
  return EXPECTED_LIFECYCLE_RULES.every((expected) => {
    const rule = actual.get(expected.id);
    const expiration = asRecord(rule?.Expiration);
    const noncurrent = asRecord(rule?.NoncurrentVersionExpiration);
    const filter = asRecord(rule?.Filter);
    if (
      !filter ||
      (expected.days === undefined
        ? 'Days' in (expiration ?? {})
        : expiration?.Days !== expected.days) ||
      (expected.expiredDeleteMarker === undefined
        ? 'ExpiredObjectDeleteMarker' in (expiration ?? {})
        : expiration?.ExpiredObjectDeleteMarker !==
          expected.expiredDeleteMarker) ||
      (expected.noncurrentDays === undefined
        ? noncurrent !== null
        : noncurrent?.NoncurrentDays !== expected.noncurrentDays)
    ) {
      return false;
    }
    if (expected.prefix) {
      return filter.Prefix === expected.prefix && !('Tag' in filter);
    }
    const tag = asRecord(filter.Tag);
    return (
      tag?.Key === expected.tag?.key &&
      tag?.Value === expected.tag?.value &&
      !('Prefix' in filter)
    );
  });
}

export async function checkGenericOperationArtifactStorageReadiness(
  bucket: string,
  client: ArtifactReadinessS3Client,
): Promise<ArtifactStorageReadiness> {
  const readinessKey = `${READINESS_PREFIX}${randomUUID()}`;
  let wroteCanary = false;
  let canaryVersionId: string | undefined;
  try {
    const [versioning, encryption, lifecycle] = await Promise.all([
      client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      client.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
      client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      ),
    ]);
    if (
      asRecord(versioning)?.Status !== 'Enabled' ||
      !hasExpectedEncryption(encryption) ||
      !hasExpectedLifecycle(lifecycle)
    ) {
      throw new ExecutionControlError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
    const put = asRecord(
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: readinessKey,
          Body: readableBody([READINESS_BODY]),
          ContentLength: READINESS_BODY.byteLength,
          ContentType: 'application/octet-stream',
          ServerSideEncryption: 'AES256',
          Metadata: {
            schema: 'generic-operation-artifact-readiness/v1',
            'privacy-class': 'PUBLIC_ORGANIZATION',
          },
          Tagging: 'artifact-privacy=PUBLIC_ORGANIZATION',
          IfNoneMatch: '*',
        }),
      ),
    );
    if (typeof put?.VersionId !== 'string' || !put.VersionId) {
      throw new Error('VERSION_ID_NOT_PROVEN');
    }
    canaryVersionId = put.VersionId;
    wroteCanary = true;
    const readback = asRecord(
      await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: readinessKey }),
      ),
    );
    if (!isAsyncByteIterable(readback?.Body))
      throw new Error('READBACK_INVALID');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of readback.Body) {
      if (!(chunk instanceof Uint8Array)) throw new Error('READBACK_INVALID');
      size += chunk.byteLength;
      if (size > READINESS_BODY.byteLength) throw new Error('READBACK_INVALID');
      hash.update(chunk);
    }
    if (
      size !== READINESS_BODY.byteLength ||
      hash.digest('hex') !==
        createHash('sha256').update(READINESS_BODY).digest('hex')
    ) {
      throw new Error('READBACK_INVALID');
    }
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: readinessKey,
        VersionId: canaryVersionId,
      }),
    );
    wroteCanary = false;
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: readinessKey }),
      );
      throw new Error('DELETE_NOT_PROVEN');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const versions = asRecord(
      await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: readinessKey,
        }),
      ),
    );
    for (const collection of [versions?.Versions, versions?.DeleteMarkers]) {
      if (
        Array.isArray(collection) &&
        collection.some((entry) => asRecord(entry)?.Key === readinessKey)
      ) {
        throw new Error('VERSION_CLEANUP_NOT_PROVEN');
      }
    }
    return Object.freeze({ status: 'ready' });
  } catch {
    return Object.freeze({
      status: 'not_ready',
      code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    });
  } finally {
    if (wroteCanary && canaryVersionId) {
      await client
        .send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: readinessKey,
            VersionId: canaryVersionId,
          }),
        )
        .catch(() => undefined);
    }
  }
}
