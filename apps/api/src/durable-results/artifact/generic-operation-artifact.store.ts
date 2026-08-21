import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { contentAddressedObjectKey, stagingObjectKey } from './artifact-key';
import {
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
  type ArtifactPrivacyClass,
  type ArtifactSource,
} from './artifact.types';

export const GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA =
  'generic-operation-artifact-object/v1' as const;

const RESULT_SCHEMA_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$/;
const PRIVACY_CLASSES = new Set<ArtifactPrivacyClass>([
  'PUBLIC_ORGANIZATION',
  'CONFIDENTIAL_TENANT',
  'PERSONAL_DATA',
]);
const OBJECT_METADATA_KEYS = new Set([
  'privacy-class',
  'result-schema',
  'schema',
  'sha256',
  'size-bytes',
]);

export type ArtifactStorageErrorCode =
  | 'GENERIC_OPERATION_ARTIFACT_ABORTED'
  | 'GENERIC_OPERATION_ARTIFACT_INVALID'
  | 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN'
  | 'GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED'
  | 'GENERIC_OPERATION_ARTIFACT_SOURCE_FAILED'
  | 'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN'
  | 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE';

/** A bounded public error. Transport errors and configuration never escape. */
export class ArtifactStorageError extends Error {
  constructor(public readonly code: ArtifactStorageErrorCode) {
    super(code);
    this.name = 'ArtifactStorageError';
  }
}

export interface ArtifactS3Client {
  send(
    command: object,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

export interface StageArtifactInput {
  readonly artifactId: string;
  readonly source: ArtifactSource;
  readonly maxBytes: number;
  /** Trusted strategy/service metadata, never provider- or user-selected. */
  readonly resultSchema: string;
  /** Trusted strategy/service metadata, never provider- or user-selected. */
  readonly privacyClass: ArtifactPrivacyClass;
  readonly signal?: AbortSignal;
}

export interface StagedArtifact {
  readonly artifactId: string;
  readonly stagingKey: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly sourceDigest: string | null;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
}

export interface StoredArtifact {
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
}

export type ArtifactStorageReadiness =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'not_ready';
      code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE';
    }>;

export interface GenericOperationArtifactStore {
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  promote(input: StagedArtifact): Promise<StoredArtifact>;
  inspect(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<StoredArtifact | null>;
  read(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  deleteStaging(artifactId: string): Promise<void>;
  checkReadiness(): Promise<ArtifactStorageReadiness>;
}

export interface S3GenericOperationArtifactStoreOptions {
  readonly bucket: string;
  readonly client: ArtifactS3Client;
}

function storageError(code: ArtifactStorageErrorCode): ArtifactStorageError {
  return new ArtifactStorageError(code);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_ABORTED');
  }
}

function assertResultSchema(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    !RESULT_SCHEMA_PATTERN.test(value)
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
}

function assertPrivacyClass(
  value: unknown,
): asserts value is ArtifactPrivacyClass {
  if (!PRIVACY_CLASSES.has(value as ArtifactPrivacyClass)) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
}

function assertMediaType(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function assertStageInput(input: StageArtifactInput): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !isCanonicalArtifactUuid(input.artifactId) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0 ||
    typeof input.source !== 'object' ||
    input.source === null ||
    !isAsyncByteIterable(input.source.body)
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
  assertResultSchema(input.resultSchema);
  assertPrivacyClass(input.privacyClass);
  assertMediaType(input.source.mediaType);
  if (
    input.source.sourceDigest !== undefined &&
    !isCanonicalArtifactSha256(input.source.sourceDigest)
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
}

function assertStagedArtifact(value: StagedArtifact): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !isCanonicalArtifactUuid(value.artifactId) ||
    value.stagingKey !== stagingObjectKey(value.artifactId) ||
    !isCanonicalArtifactSha256(value.sha256) ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.sizeBytes) ||
    !Number.isSafeInteger(Number(value.sizeBytes)) ||
    (value.sourceDigest !== null &&
      !isCanonicalArtifactSha256(value.sourceDigest))
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
  assertMediaType(value.mediaType);
  assertResultSchema(value.resultSchema);
  assertPrivacyClass(value.privacyClass);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const metadata = asRecord(record?.$metadata);
  return typeof metadata?.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined;
}

function isNotFound(error: unknown): boolean {
  const name = errorName(error);
  const status = errorStatus(error);
  return (
    status === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === '404'
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return errorStatus(error) === 412 || errorName(error) === 'PreconditionFailed';
}

function asMetadata(value: unknown): Readonly<Record<string, string>> | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length !== OBJECT_METADATA_KEYS.size) {
    return null;
  }
  for (const [key, item] of Object.entries(record)) {
    if (!OBJECT_METADATA_KEYS.has(key) || typeof item !== 'string') return null;
  }
  return record as Readonly<Record<string, string>>;
}

function parseStoredArtifact(
  sha256: string,
  headOutput: unknown,
): StoredArtifact {
  const head = asRecord(headOutput);
  const metadata = asMetadata(head?.Metadata);
  const contentLength = head?.ContentLength;
  const contentType = head?.ContentType;
  if (
    !head ||
    !metadata ||
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    metadata.schema !== GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA ||
    metadata.sha256 !== sha256 ||
    metadata['size-bytes'] !== String(contentLength)
  ) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
  assertMediaType(contentType);
  assertResultSchema(metadata['result-schema']);
  assertPrivacyClass(metadata['privacy-class']);

  return Object.freeze({
    objectKey: contentAddressedObjectKey(sha256),
    sha256,
    sizeBytes: metadata['size-bytes'],
    mediaType: contentType,
    resultSchema: metadata['result-schema'],
    privacyClass: metadata['privacy-class'],
  });
}

function sameStoredArtifact(
  stored: StoredArtifact,
  staged: StagedArtifact,
): boolean {
  return (
    stored.sha256 === staged.sha256 &&
    stored.sizeBytes === staged.sizeBytes &&
    stored.mediaType === staged.mediaType &&
    stored.resultSchema === staged.resultSchema &&
    stored.privacyClass === staged.privacyClass
  );
}

function objectMetadata(
  staged: StagedArtifact,
): Readonly<Record<string, string>> {
  return Object.freeze({
    sha256: staged.sha256,
    'size-bytes': staged.sizeBytes,
    schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
    'result-schema': staged.resultSchema,
    'privacy-class': staged.privacyClass,
  });
}

function commandOptions(
  signal?: AbortSignal,
): Readonly<{ abortSignal?: AbortSignal }> | undefined {
  return signal ? { abortSignal: signal } : undefined;
}

export class S3GenericOperationArtifactStore
  implements GenericOperationArtifactStore
{
  private readonly bucket: string;
  private readonly client: ArtifactS3Client;

  constructor(options: S3GenericOperationArtifactStoreOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.bucket !== 'string' ||
      options.bucket.length < 1 ||
      options.bucket.length > 255 ||
      typeof options.client?.send !== 'function'
    ) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    this.bucket = options.bucket;
    this.client = options.client;
  }

  async stage(input: StageArtifactInput): Promise<StagedArtifact> {
    assertStageInput(input);
    assertNotAborted(input.signal);

    const hash = createHash('sha256');
    let sizeBytes = 0;
    let completed = false;
    const boundedBody = this.boundedSourceBody(
      input.source.body,
      input.maxBytes,
      hash,
      (size) => {
        sizeBytes = size;
      },
      () => {
        completed = true;
      },
      input.signal,
    );

    const stagedArtifact = (): StagedArtifact =>
      Object.freeze({
        artifactId: input.artifactId,
        stagingKey: stagingObjectKey(input.artifactId),
        sha256: hash.digest('hex'),
        sizeBytes: String(sizeBytes),
        mediaType: input.source.mediaType,
        sourceDigest: input.source.sourceDigest ?? null,
        resultSchema: input.resultSchema,
        privacyClass: input.privacyClass,
      });

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: stagingObjectKey(input.artifactId),
          Body: Readable.from(boundedBody),
          ContentType: input.source.mediaType,
        }),
        commandOptions(input.signal),
      );
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(input.signal);
      if (completed) {
        return this.recoverStaging(stagedArtifact(), input.signal);
      }
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
    if (!completed) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }

    return stagedArtifact();
  }

  async promote(input: StagedArtifact): Promise<StoredArtifact> {
    assertStagedArtifact(input);
    const objectKey = contentAddressedObjectKey(input.sha256);
    let body: AsyncIterable<Uint8Array>;
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.stagingKey,
          }),
        ),
      );
      if (!isAsyncByteIterable(result?.Body)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      body = result.Body;
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }

    let verified = false;
    const verifiedBody = this.verifiedStagingBody(body, input, () => {
      verified = true;
    });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: Readable.from(verifiedBody),
          ContentLength: Number(input.sizeBytes),
          ContentType: input.mediaType,
          Metadata: objectMetadata(input),
          IfNoneMatch: '*',
        }),
      );
      if (!verified) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
      }
      const stored = await this.inspect(input.sha256);
      if (!stored || !sameStoredArtifact(stored, input)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      return stored;
    } catch (error) {
      if (
        error instanceof ArtifactStorageError &&
        error.code === 'GENERIC_OPERATION_ARTIFACT_INVALID'
      ) {
        throw error;
      }
      return this.recoverPromote(input, isPreconditionFailed(error));
    }
  }

  async inspect(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<StoredArtifact | null> {
    if (!isCanonicalArtifactSha256(sha256)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    assertNotAborted(signal);
    try {
      const output = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: contentAddressedObjectKey(sha256),
        }),
        commandOptions(signal),
      );
      return parseStoredArtifact(sha256, output);
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(signal);
      if (isNotFound(error)) return null;
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
  }

  async read(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (!isCanonicalArtifactSha256(sha256)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    assertNotAborted(signal);
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: contentAddressedObjectKey(sha256),
          }),
          commandOptions(signal),
        ),
      );
      if (!isAsyncByteIterable(result?.Body)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      return this.redactedReadBody(result.Body, signal);
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(signal);
      if (isNotFound(error)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
  }

  async deleteStaging(artifactId: string): Promise<void> {
    if (!isCanonicalArtifactUuid(artifactId)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: stagingObjectKey(artifactId),
        }),
      );
    } catch {
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
  }

  async checkReadiness(): Promise<ArtifactStorageReadiness> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return Object.freeze({ status: 'ready' });
    } catch {
      return Object.freeze({
        status: 'not_ready',
        code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
      });
    }
  }

  private async recoverPromote(
    input: StagedArtifact,
    preconditionFailed: boolean,
  ): Promise<StoredArtifact> {
    try {
      const stored = await this.inspect(input.sha256);
      if (stored && sameStoredArtifact(stored, input)) return stored;
      if (stored) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
    } catch (error) {
      if (
        error instanceof ArtifactStorageError &&
        error.code === 'GENERIC_OPERATION_ARTIFACT_INVALID'
      ) {
        throw error;
      }
      throw storageError('GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN');
    }
    throw storageError(
      preconditionFailed
        ? 'GENERIC_OPERATION_ARTIFACT_INVALID'
        : 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN',
    );
  }

  private async recoverStaging(
    input: StagedArtifact,
    signal?: AbortSignal,
  ): Promise<StagedArtifact> {
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.stagingKey,
          }),
          commandOptions(signal),
        ),
      );
      if (!isAsyncByteIterable(result?.Body)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      let verified = false;
      for await (const _chunk of this.verifiedStagingBody(
        result.Body,
        input,
        () => {
          verified = true;
        },
      )) {
        assertNotAborted(signal);
      }
      if (!verified) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      return input;
    } catch (error) {
      if (
        error instanceof ArtifactStorageError &&
        (error.code === 'GENERIC_OPERATION_ARTIFACT_ABORTED' ||
          error.code === 'GENERIC_OPERATION_ARTIFACT_INVALID')
      ) {
        throw error;
      }
      throw storageError('GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN');
    }
  }

  private async *boundedSourceBody(
    body: AsyncIterable<Uint8Array>,
    maxBytes: number,
    hash: ReturnType<typeof createHash>,
    recordSize: (size: number) => void,
    recordComplete: () => void,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    let size = 0;
    try {
      for await (const chunk of body) {
        assertNotAborted(signal);
        if (!(chunk instanceof Uint8Array)) {
          throw storageError('GENERIC_OPERATION_ARTIFACT_SOURCE_FAILED');
        }
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size) || size > maxBytes) {
          throw storageError(
            'GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED',
          );
        }
        hash.update(chunk);
        recordSize(size);
        yield chunk;
      }
      assertNotAborted(signal);
      recordComplete();
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(signal);
      throw storageError('GENERIC_OPERATION_ARTIFACT_SOURCE_FAILED');
    }
  }

  private async *verifiedStagingBody(
    body: AsyncIterable<Uint8Array>,
    staged: StagedArtifact,
    recordVerified: () => void,
  ): AsyncIterable<Uint8Array> {
    const expectedSize = Number(staged.sizeBytes);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) {
          throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
        }
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size) || size > expectedSize) {
          throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
        }
        hash.update(chunk);
        yield chunk;
      }
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
    if (size !== expectedSize || hash.digest('hex') !== staged.sha256) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    recordVerified();
  }

  private async *redactedReadBody(
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of body) {
        assertNotAborted(signal);
        if (!(chunk instanceof Uint8Array)) {
          throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
        }
        yield chunk;
      }
      assertNotAborted(signal);
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(signal);
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
  }
}
