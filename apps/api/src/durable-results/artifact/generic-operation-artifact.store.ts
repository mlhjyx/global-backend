import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  parseArtifactObjectScope,
  resolveArtifactObjectKey,
  stagingObjectKey,
  type ArtifactObjectScope,
} from './artifact-key';
import {
  assertArtifactMediaType,
  assertArtifactPrivacyClass,
  assertArtifactResultSchema,
  parseStagedArtifactSnapshot,
} from './generic-operation-artifact.staging-contract';
import {
  checkGenericOperationArtifactStorageReadiness,
  type ArtifactStorageReadiness,
} from './generic-operation-artifact.readiness';
import { uploadGenericOperationArtifactStaging } from './generic-operation-artifact.multipart-upload';
import {
  GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
  isCanonicalArtifactObjectVersionId,
  objectMetadata,
  parseLifecycleExpiration,
  parseStoredArtifactContract,
  sameArtifact,
  sameObjectContract,
} from './generic-operation-artifact.object-contract';
import {
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
  type ArtifactPrivacyClass,
  type ArtifactSource,
} from './artifact.types';

export { GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA };

export type ArtifactStorageErrorCode =
  | 'GENERIC_OPERATION_ARTIFACT_ABORTED'
  | 'GENERIC_OPERATION_ARTIFACT_INVALID'
  /** The digest-derived final object is not in the bucket any more. */
  | 'GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING'
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

/**
 * A reuse kept the verified object but could not move its lifecycle age
 * forward; the manifest may outlive the object (fail open, logged).
 */
export type ArtifactStoreWarningCode =
  'GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED';

export interface ArtifactStoreLogger {
  warn(code: ArtifactStoreWarningCode): void;
}

export interface PromoteArtifactOptions {
  /**
   * The manifest expiry the object must stay readable until (canonical UTC
   * millisecond ISO-8601). When the current version's bucket lifecycle expiry
   * is earlier, or unknown, promote refreshes the version in place.
   */
  readonly retainUntil?: string;
  /** Scope binding required when promoting PERSONAL_DATA artifacts. */
  readonly scope?: ArtifactObjectScope;
}

export interface ArtifactObjectReadOptions {
  readonly scope?: ArtifactObjectScope;
  /** Explicit validated object key (e.g., for reading legacy PERSONAL_DATA rows). */
  readonly objectKey?: string;
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
  /** Exact immutable object version, internal only. */
  readonly versionId: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
}

export type { ArtifactStorageReadiness };

export interface GenericOperationArtifactStore {
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  promote(
    input: StagedArtifact,
    options?: PromoteArtifactOptions,
  ): Promise<StoredArtifact>;
  inspect(
    sha256: string,
    privacyClass: ArtifactPrivacyClass,
    signal?: AbortSignal,
    options?: ArtifactObjectReadOptions,
  ): Promise<StoredArtifact | null>;
  read(
    sha256: string,
    privacyClass: ArtifactPrivacyClass,
    signal?: AbortSignal,
    options?: ArtifactObjectReadOptions,
  ): Promise<AsyncIterable<Uint8Array>>;
  deleteStaging(artifactId: string): Promise<void>;
  checkReadiness(): Promise<ArtifactStorageReadiness>;
}

export interface S3GenericOperationArtifactStoreOptions {
  readonly bucket: string;
  readonly client: ArtifactS3Client;
  readonly logger?: ArtifactStoreLogger;
}

interface InspectedArtifact {
  readonly stored: StoredArtifact;
  /** When the bucket lifecycle will delete the current version; null if it says nothing. */
  readonly lifecycleExpiresAt: Date | null;
}

const DEFAULT_LOGGER = new Logger('S3GenericOperationArtifactStore');

function storageError(code: ArtifactStorageErrorCode): ArtifactStorageError {
  return new ArtifactStorageError(code);
}

/** The retention bound of a promote, validated before any storage call. */
function parseRetainUntil(options: PromoteArtifactOptions | undefined): number | null {
  if (options === undefined) return null;
  if (typeof options !== 'object' || options === null) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
  const value = options.retainUntil;
  if (value === undefined) return null;
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
  }
  return time;
}

function invalidArtifact(): never {
  throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
}

function parseScopeOption(
  scope: ArtifactObjectScope | undefined,
): ArtifactObjectScope | undefined {
  try {
    return parseArtifactObjectScope(scope);
  } catch {
    invalidArtifact();
  }
}

function resolveStorageObjectKey(
  sha256: string,
  privacyClass: ArtifactPrivacyClass,
  options?: ArtifactObjectReadOptions,
): string {
  try {
    return resolveArtifactObjectKey(sha256, privacyClass, options);
  } catch {
    invalidArtifact();
  }
}

/** S3 CopySource: bucket and key with every path segment percent-encoded. */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw storageError('GENERIC_OPERATION_ARTIFACT_ABORTED');
  }
}

function assertResultSchema(value: unknown): asserts value is string {
  assertArtifactResultSchema(value, invalidArtifact);
}

function assertPrivacyClass(
  value: unknown,
): asserts value is ArtifactPrivacyClass {
  assertArtifactPrivacyClass(value, invalidArtifact);
}

function assertMediaType(value: unknown): asserts value is string {
  assertArtifactMediaType(value, invalidArtifact);
}

function isAsyncByteIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
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
    invalidArtifact();
  }
  assertResultSchema(input.resultSchema);
  assertPrivacyClass(input.privacyClass);
  assertMediaType(input.source.mediaType);
  if (
    input.source.sourceDigest !== undefined &&
    !isCanonicalArtifactSha256(input.source.sourceDigest)
  ) {
    invalidArtifact();
  }
}

function snapshotStagedArtifact(value: StagedArtifact): StagedArtifact {
  return parseStagedArtifactSnapshot(value, invalidArtifact);
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

function commandOptions(
  signal?: AbortSignal,
): Readonly<{ abortSignal?: AbortSignal }> | undefined {
  return signal ? { abortSignal: signal } : undefined;
}

function readableBody(
  body: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Readable {
  const stream = Readable.from(body);
  stream.on('error', () => undefined);
  return stream;
}

export class S3GenericOperationArtifactStore implements GenericOperationArtifactStore {
  private readonly bucket: string;
  private readonly client: ArtifactS3Client;
  private readonly logger: ArtifactStoreLogger;

  constructor(options: S3GenericOperationArtifactStoreOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.bucket !== 'string' ||
      options.bucket.length < 1 ||
      options.bucket.length > 255 ||
      typeof options.client?.send !== 'function' ||
      (options.logger !== undefined && typeof options.logger?.warn !== 'function')
    ) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    this.bucket = options.bucket;
    this.client = options.client;
    this.logger = options.logger ?? {
      warn: (code) => DEFAULT_LOGGER.warn(code),
    };
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
      await uploadGenericOperationArtifactStaging({
        bucket: this.bucket,
        key: stagingObjectKey(input.artifactId),
        body: boundedBody,
        mediaType: input.source.mediaType,
        client: this.client,
        unavailable: () =>
          storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE'),
        signal: input.signal,
      });
    } catch (error) {
      if (completed) {
        return this.recoverStaging(stagedArtifact());
      }
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(input.signal);
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
    if (!completed) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }

    return stagedArtifact();
  }

  async promote(
    input: StagedArtifact,
    options?: PromoteArtifactOptions,
  ): Promise<StoredArtifact> {
    const staged = snapshotStagedArtifact(input);
    const retainUntil = parseRetainUntil(options);
    const scope = parseScopeOption(options?.scope);
    const objectKey = resolveStorageObjectKey(
      staged.sha256,
      staged.privacyClass,
      { scope },
    );
    const existing = await this.inspectCurrent(
      staged.sha256,
      staged.privacyClass,
      undefined,
      { scope },
    );
    if (existing) {
      if (!sameArtifact(existing.stored, staged)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      await this.verifyFinalBody(staged, scope);
      if (
        retainUntil === null ||
        (existing.lifecycleExpiresAt !== null &&
          existing.lifecycleExpiresAt.getTime() >= retainUntil)
      ) {
        return existing.stored;
      }
      return this.refreshRetention(existing.stored, scope);
    }
    let body: AsyncIterable<Uint8Array>;
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: staged.stagingKey,
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
    const verifiedBody = this.verifiedStagingBody(body, staged, () => {
      verified = true;
    });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: readableBody(verifiedBody),
          ContentLength: Number(staged.sizeBytes),
          ContentType: staged.mediaType,
          Metadata: objectMetadata(staged),
          Tagging: `artifact-privacy=${encodeURIComponent(staged.privacyClass)}`,
          ServerSideEncryption: 'AES256',
          IfNoneMatch: '*',
        }),
      );
      if (!verified) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
      }
      return this.recoverPromote(staged, scope);
    } catch (error) {
      if (
        error instanceof ArtifactStorageError &&
        error.code === 'GENERIC_OPERATION_ARTIFACT_INVALID'
      ) {
        throw error;
      }
      // 不区分是否 412：只要 inspect 看不到对象（含并发赢家尚未可见的窗口）就是
      // ACK 未知，让持久层按「结果未知」保守记账（契约不符在 stored 分支已单独判 INVALID）。
      return this.recoverPromote(staged, scope);
    }
  }

  async inspect(
    sha256: string,
    privacyClass: ArtifactPrivacyClass,
    signal?: AbortSignal,
    options?: ArtifactObjectReadOptions,
  ): Promise<StoredArtifact | null> {
    const inspected = await this.inspectCurrent(
      sha256,
      privacyClass,
      signal,
      options,
    );
    return inspected?.stored ?? null;
  }

  private async inspectCurrent(
    sha256: string,
    privacyClass: ArtifactPrivacyClass,
    signal?: AbortSignal,
    options?: ArtifactObjectReadOptions,
  ): Promise<InspectedArtifact | null> {
    if (!isCanonicalArtifactSha256(sha256)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    assertPrivacyClass(privacyClass);
    assertNotAborted(signal);
    const key = resolveStorageObjectKey(sha256, privacyClass, options);
    const contractOptions = {
      scope: parseScopeOption(options?.scope),
      objectKey: key,
    };
    try {
      const [output, tags] = await Promise.all([
        this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
          commandOptions(signal),
        ),
        this.client.send(
          new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }),
          commandOptions(signal),
        ),
      ]);
      const stored = parseStoredArtifactContract(
        sha256,
        output,
        tags,
        contractOptions,
      );
      if (!stored) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      return Object.freeze({
        stored,
        lifecycleExpiresAt: parseLifecycleExpiration(
          asRecord(output)?.Expiration,
        ),
      });
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      assertNotAborted(signal);
      if (isNotFound(error)) return null;
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }
  }

  /**
   * Copies the verified current version onto itself with the object's own
   * contract metadata, content type, tag and encryption, all taken from the
   * existing object: the object keeps the first writer's contract (#644), and
   * a reusing manifest whose result schema or media type differs carries its
   * own in the manifest, never on the object. S3 and MinIO record the copy as
   * a new current version with a fresh LastModified, which is the age the
   * bucket lifecycle expires by; the superseded version is noncurrent and
   * expires on its own lifecycle rule. The copied version is what the caller
   * records, so a concurrent refresh landing afterwards never hides it from
   * erasure. A failed copy keeps the verified object (fail open) and leaves
   * one bounded warning: the manifest may then outlive the object by at most
   * one lifecycle day.
   */
  private async refreshRetention(
    existing: StoredArtifact,
    scope?: ArtifactObjectScope,
  ): Promise<StoredArtifact> {
    let copiedVersionId: string | null;
    try {
      const result = asRecord(
        await this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: existing.objectKey,
            CopySource: copySource(this.bucket, existing.objectKey),
            MetadataDirective: 'REPLACE',
            Metadata: objectMetadata(existing),
            ContentType: existing.mediaType,
            TaggingDirective: 'REPLACE',
            Tagging: `artifact-privacy=${encodeURIComponent(existing.privacyClass)}`,
            ServerSideEncryption: 'AES256',
          }),
        ),
      );
      copiedVersionId = isCanonicalArtifactObjectVersionId(result?.VersionId)
        ? result.VersionId
        : null;
    } catch {
      this.logger.warn('GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED');
      return existing;
    }
    const refreshed = await this.inspect(
      existing.sha256,
      existing.privacyClass,
      undefined,
      { scope, objectKey: existing.objectKey },
    );
    if (!refreshed || !sameObjectContract(refreshed, existing)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    return copiedVersionId === null
      ? refreshed
      : Object.freeze({ ...refreshed, versionId: copiedVersionId });
  }

  async read(
    sha256: string,
    privacyClass: ArtifactPrivacyClass,
    signal?: AbortSignal,
    options?: ArtifactObjectReadOptions,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (!isCanonicalArtifactSha256(sha256)) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
    assertPrivacyClass(privacyClass);
    assertNotAborted(signal);
    const key = resolveStorageObjectKey(sha256, privacyClass, options);
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
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
        throw storageError('GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING');
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
    return checkGenericOperationArtifactStorageReadiness(
      this.bucket,
      this.client,
    );
  }

  private async recoverPromote(
    input: StagedArtifact,
    scope?: ArtifactObjectScope,
  ): Promise<StoredArtifact> {
    try {
      const stored = await this.inspect(
        input.sha256,
        input.privacyClass,
        undefined,
        { scope },
      );
      if (stored && sameArtifact(stored, input)) {
        await this.verifyFinalBody(input, scope);
        return stored;
      }
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
    // Inspect did not see the object even though our own IfNoneMatch PUT lost the
    // race: that is this writer's own concurrent create, not a contract mismatch
    // (契约不符在上面的 `stored` 分支已被判 INVALID)。报告 ACK 未知，让持久层
    // 按「结果未知」保守记账，而不是把并发风暴升级成 INVALID。
    throw storageError('GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN');
  }

  private async recoverStaging(input: StagedArtifact): Promise<StagedArtifact> {
    try {
      const result = asRecord(
        await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: stagingObjectKey(input.artifactId),
          }),
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
        // Drain the recovery stream so digest and size are actually verified.
      }
      if (!verified) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      return input;
    } catch (error) {
      if (
        error instanceof ArtifactStorageError &&
        error.code === 'GENERIC_OPERATION_ARTIFACT_INVALID'
      ) {
        throw error;
      }
      throw storageError('GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN');
    }
  }

  private async verifyFinalBody(
    staged: StagedArtifact,
    scope?: ArtifactObjectScope,
  ): Promise<void> {
    let body: AsyncIterable<Uint8Array>;
    const key = resolveStorageObjectKey(staged.sha256, staged.privacyClass, {
      scope,
    });
    try {
      const [rawResult, tags] = await Promise.all([
        this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
          }),
        ),
        this.client.send(
          new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }),
        ),
      ]);
      const result = asRecord(rawResult);
      const stored = parseStoredArtifactContract(staged.sha256, result, tags, {
        scope,
        objectKey: key,
      });
      if (!stored || !sameArtifact(stored, staged)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      if (!isAsyncByteIterable(result?.Body)) {
        throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
      }
      body = result.Body;
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      throw storageError('GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE');
    }

    let verified = false;
    for await (const _chunk of this.verifiedStagingBody(body, staged, () => {
      verified = true;
    })) {
      // Verification is streaming; never aggregate the final object in memory.
    }
    if (!verified) {
      throw storageError('GENERIC_OPERATION_ARTIFACT_INVALID');
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
          throw storageError('GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED');
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
