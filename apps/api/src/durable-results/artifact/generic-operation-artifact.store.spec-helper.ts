import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
  S3GenericOperationArtifactStore,
  type ArtifactS3Client,
  type StagedArtifact,
} from './generic-operation-artifact.store';
export const ARTIFACT_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
export const BUCKET = 'generic-artifacts-test';
export const RESULT_SCHEMA = 'http-get/v1';
interface MemoryObject {
  readonly chunks: readonly Uint8Array[];
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tagSet?: readonly Readonly<{ Key: string; Value: string }>[];
  readonly serverSideEncryption?: string;
}
interface Failure extends Error {
  readonly $metadata?: Readonly<{ httpStatusCode?: number }>;
}
interface MemoryMultipartUpload {
  readonly key: string;
  readonly contentType: string;
  readonly parts: Map<number, readonly Uint8Array[]>;
}
function failure(
  name: string,
  message: string,
  httpStatusCode?: number,
): Failure {
  return Object.assign(new Error(message), {
    name,
    ...(httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } }),
  });
}
export function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}
export function sha256(chunks: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}
export async function collect(body: unknown): Promise<readonly Uint8Array[]> {
  if (
    typeof body !== 'object' ||
    body === null ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new Error('test transport requires an async iterable body');
  }
  const chunks: Uint8Array[] = [];
  for await (const value of body as AsyncIterable<unknown>) {
    if (!(value instanceof Uint8Array)) {
      throw new Error('test transport received a non-byte chunk');
    }
    chunks.push(Uint8Array.from(value));
  }
  return chunks;
}
export class MemoryS3Client implements ArtifactS3Client {
  readonly objects = new Map<string, MemoryObject>();
  readonly multipartUploads = new Map<string, MemoryMultipartUpload>();
  readonly commands: object[] = [];
  stagingPutFailure: Error | null = null;
  stagingPutAckFailure = false;
  stagingPutAckAbort: AbortController | null = null;
  finalPutFailure: 'before_commit' | 'after_commit' | null = null;
  finalReadbackChunks: readonly Uint8Array[] | null = null;
  finalReadbackContentLength: number | null = null;
  finalReadbackMetadata: Readonly<Record<string, string>> | null = null;
  getFailure: Error | null = null;
  headFailure: Error | null = null;
  readinessFailure: Error | null = null;
  async send(
    command: object,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) {
      if (this.stagingPutFailure) throw this.stagingPutFailure;
      if (
        command.input.Bucket !== BUCKET ||
        typeof command.input.Key !== 'string'
      ) {
        throw new Error('unexpected test bucket/key');
      }
      const uploadId = `upload-${this.multipartUploads.size + 1}`;
      this.multipartUploads.set(uploadId, {
        key: command.input.Key,
        contentType: command.input.ContentType ?? '',
        parts: new Map(),
      });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const upload =
        typeof command.input.UploadId === 'string'
          ? this.multipartUploads.get(command.input.UploadId)
          : undefined;
      if (!upload || typeof command.input.PartNumber !== 'number') {
        throw new Error('unexpected multipart upload');
      }
      upload.parts.set(
        command.input.PartNumber,
        await collect(command.input.Body),
      );
      return { ETag: `etag-${command.input.PartNumber}` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const uploadId = command.input.UploadId;
      const upload =
        typeof uploadId === 'string'
          ? this.multipartUploads.get(uploadId)
          : undefined;
      if (!upload) throw new Error('unexpected multipart completion');
      const chunks = [...upload.parts.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, part]) => part);
      this.objects.set(upload.key, {
        chunks,
        contentType: upload.contentType,
        metadata: Object.freeze({}),
        tagSet: Object.freeze([]),
        serverSideEncryption: 'AES256',
      });
      this.multipartUploads.delete(uploadId as string);
      if (this.stagingPutAckFailure) {
        this.stagingPutAckAbort?.abort();
        throw failure('TimeoutError', 'https://secret.invalid staging ACK');
      }
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      if (typeof command.input.UploadId === 'string') {
        this.multipartUploads.delete(command.input.UploadId);
      }
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const input = command.input;
      if (input.Bucket !== BUCKET || typeof input.Key !== 'string') {
        throw new Error('unexpected test bucket/key');
      }
      const isFinal = input.IfNoneMatch === '*';
      if (!isFinal && this.stagingPutFailure) throw this.stagingPutFailure;
      if (isFinal && this.objects.has(input.Key)) {
        throw failure('PreconditionFailed', 'target exists', 412);
      }
      if (isFinal && this.finalPutFailure === 'before_commit') {
        throw failure('TimeoutError', 'https://secret.invalid before ACK');
      }
      const chunks = await collect(input.Body);
      const tagSet = (input.Tagging ?? '')
        .split('&')
        .filter(Boolean)
        .map((entry) => {
          const [key = '', value = ''] = entry.split('=', 2);
          return Object.freeze({
            Key: decodeURIComponent(key),
            Value: decodeURIComponent(value),
          });
        });
      this.objects.set(input.Key, {
        chunks,
        contentType: input.ContentType ?? '',
        metadata: Object.freeze({ ...(input.Metadata ?? {}) }),
        tagSet: Object.freeze(tagSet),
        serverSideEncryption: input.ServerSideEncryption,
      });
      if (!isFinal && this.stagingPutAckFailure) {
        this.stagingPutAckAbort?.abort();
        throw failure('TimeoutError', 'https://secret.invalid staging ACK');
      }
      if (isFinal && this.finalPutFailure === 'after_commit') {
        throw failure('TimeoutError', 'https://secret.invalid after ACK');
      }
      return { VersionId: 'version-1' };
    }
    if (command instanceof HeadObjectCommand) {
      if (this.headFailure) throw this.headFailure;
      const key = command.input.Key;
      const value = key === undefined ? undefined : this.objects.get(key);
      if (!value) throw failure('NotFound', 'not found', 404);
      return {
        ContentLength: value.chunks.reduce(
          (total, chunk) => total + chunk.byteLength,
          0,
        ),
        ContentType: value.contentType,
        Metadata: value.metadata,
        ServerSideEncryption: value.serverSideEncryption,
      };
    }
    if (command instanceof GetObjectTaggingCommand) {
      const key = command.input.Key;
      const value = key === undefined ? undefined : this.objects.get(key);
      if (!value) throw failure('NoSuchKey', 'not found', 404);
      return { TagSet: value.tagSet ?? [] };
    }
    if (command instanceof GetObjectCommand) {
      if (options?.abortSignal?.aborted) {
        throw failure('AbortError', 'aborted recovery signal');
      }
      if (this.getFailure) throw this.getFailure;
      const key = command.input.Key;
      const value = key === undefined ? undefined : this.objects.get(key);
      if (!value) throw failure('NoSuchKey', 'not found', 404);
      const isFinalKey = typeof key === 'string' && key.includes('/sha256/');
      const chunks = isFinalKey
        ? (this.finalReadbackChunks ?? value.chunks)
        : value.chunks;
      return {
        ContentLength:
          (isFinalKey ? this.finalReadbackContentLength : null) ??
          chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        ContentType: value.contentType,
        Metadata:
          (isFinalKey ? this.finalReadbackMetadata : null) ?? value.metadata,
        ServerSideEncryption: value.serverSideEncryption,
        Body: (async function* () {
          for (const chunk of chunks) yield Uint8Array.from(chunk);
        })(),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      if (typeof command.input.Key === 'string') {
        this.objects.delete(command.input.Key);
      }
      return {};
    }
    if (command instanceof GetBucketVersioningCommand) {
      if (this.readinessFailure) throw this.readinessFailure;
      return { Status: 'Enabled' };
    }
    if (command instanceof GetBucketEncryptionCommand) {
      if (this.readinessFailure) throw this.readinessFailure;
      return {
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      };
    }
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      if (this.readinessFailure) throw this.readinessFailure;
      return {
        Rules: [
          {
            Expiration: { Days: 1, ExpiredObjectAllVersions: true },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ID: 'generic-operation-artifact-staging-ttl',
            Status: 'Enabled',
            Filter: { Prefix: 'generic-operation-results/v1/staging/' },
          },
          {
            Expiration: { Days: 30, ExpiredObjectAllVersions: true },
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            ID: 'generic-operation-artifact-public-organization-ttl',
            Status: 'Enabled',
            Filter: {
              Tag: {
                Key: 'artifact-privacy',
                Value: 'PUBLIC_ORGANIZATION',
              },
            },
          },
          {
            Expiration: { Days: 7, ExpiredObjectAllVersions: true },
            NoncurrentVersionExpiration: { NoncurrentDays: 7 },
            ID: 'generic-operation-artifact-confidential-tenant-ttl',
            Status: 'Enabled',
            Filter: {
              Tag: {
                Key: 'artifact-privacy',
                Value: 'CONFIDENTIAL_TENANT',
              },
            },
          },
          {
            Expiration: { Days: 1, ExpiredObjectAllVersions: true },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ID: 'generic-operation-artifact-personal-data-ttl',
            Status: 'Enabled',
            Filter: {
              Tag: { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
            },
          },
          {
            Expiration: { ExpiredObjectDeleteMarker: true },
            ID: 'generic-operation-artifact-staging-delete-markers',
            Status: 'Enabled',
            Filter: { Prefix: 'generic-operation-results/v1/staging/' },
          },
          {
            Expiration: { ExpiredObjectDeleteMarker: true },
            ID: 'generic-operation-artifact-final-delete-markers',
            Status: 'Enabled',
            Filter: { Prefix: 'generic-operation-results/v1/sha256/' },
          },
          {
            Expiration: { ExpiredObjectDeleteMarker: true },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ID: 'generic-operation-artifact-readiness-cleanup',
            Status: 'Enabled',
            Filter: { Prefix: 'generic-operation-results/v1/readiness/' },
          },
        ],
      };
    }
    if (command instanceof ListObjectVersionsCommand) {
      return { Versions: [], DeleteMarkers: [] };
    }
    throw new Error(`unsupported test command: ${command.constructor.name}`);
  }
}
export function store(client = new MemoryS3Client()): {
  readonly client: MemoryS3Client;
  readonly store: S3GenericOperationArtifactStore;
} {
  return {
    client,
    store: new S3GenericOperationArtifactStore({ bucket: BUCKET, client }),
  };
}
export function source(
  chunks: readonly Uint8Array[],
  overrides: Readonly<{
    body?: AsyncIterable<Uint8Array>;
    mediaType?: string;
    sourceDigest?: string;
  }> = {},
) {
  return {
    body:
      overrides.body ??
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    mediaType: overrides.mediaType ?? 'application/octet-stream',
    ...(overrides.sourceDigest === undefined
      ? {}
      : { sourceDigest: overrides.sourceDigest }),
  };
}
export async function stage(
  target: S3GenericOperationArtifactStore,
  chunks: readonly Uint8Array[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StagedArtifact> {
  return target.stage({
    artifactId: ARTIFACT_ID,
    source: source(chunks),
    maxBytes,
    resultSchema: RESULT_SCHEMA,
    privacyClass: 'CONFIDENTIAL_TENANT',
    signal,
  });
}
export function expectStorageCode(
  promise: Promise<unknown>,
  code:
    | 'GENERIC_OPERATION_ARTIFACT_ABORTED'
    | 'GENERIC_OPERATION_ARTIFACT_INVALID'
    | 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN'
    | 'GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED'
    | 'GENERIC_OPERATION_ARTIFACT_SOURCE_FAILED'
    | 'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN'
    | 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'ArtifactStorageError',
    code,
    message: code,
  });
}
