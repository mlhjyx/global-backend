import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { RuntimeReadinessContributorRegistry } from '../runtime/runtime-readiness-registry';

const PRESIGN_PUT_TTL_S = 900; // 15min 完成直传
const PRESIGN_GET_TTL_S = 300;
const VARIANT_ATTEMPT_LIFECYCLE_RULE_ID = 'global-variant-attempt-ttl';
const VARIANT_ATTEMPT_LIFECYCLE_TAG = 'global-lifecycle';
const VARIANT_ATTEMPT_LIFECYCLE_VALUE = 'variant-attempt';

export type StorageReadinessFailureCode =
  | 'OBJECT_STORAGE_CREDENTIALS_REQUIRED'
  | 'OBJECT_STORAGE_LIFECYCLE_INVALID'
  | 'OBJECT_STORAGE_VALIDATION_UNAVAILABLE';

export type StorageReadiness =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'not_ready';
      code: StorageReadinessFailureCode;
    }>;

class StorageLifecycleContractError extends Error {}

/**
 * 对象存储薄封装（MinIO/S3 兼容，02 §2）。owner 凭证只在后端，
 * 外部一律短时 presigned URL；bucket 永不公开。
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readiness: StorageReadiness = Object.freeze({
    status: 'not_ready',
    code: 'OBJECT_STORAGE_CREDENTIALS_REQUIRED',
  });
  private readonly unregisterReadiness?: () => void;
  readonly bucket: string;

  constructor(
    @Optional()
    readinessRegistry?: RuntimeReadinessContributorRegistry,
  ) {
    this.bucket = process.env.S3_BUCKET ?? 'global-site-builder';
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
    this.unregisterReadiness = readinessRegistry?.register('storage', () => {
      const readiness = this.getReadiness();
      return readiness.status === 'ready'
        ? { status: 'ok' as const }
        : { status: 'failed' as const, code: readiness.code };
    });
  }

  onModuleDestroy(): void {
    this.unregisterReadiness?.();
  }

  /**
   * Product replicas validate infrastructure but never provision it. Failure keeps the
   * process diagnostic surface alive while capability readiness remains fail-closed.
   */
  async onModuleInit(): Promise<void> {
    if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
      this.failReadiness('OBJECT_STORAGE_CREDENTIALS_REQUIRED');
      return;
    }
    try {
      await this.ensureVariantAttemptLifecycle();
      this.readiness = Object.freeze({ status: 'ready' });
    } catch (error) {
      this.failReadiness(
        error instanceof StorageLifecycleContractError
          ? 'OBJECT_STORAGE_LIFECYCLE_INVALID'
          : 'OBJECT_STORAGE_VALIDATION_UNAVAILABLE',
      );
      this.log.error(
        `object storage validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getReadiness(): StorageReadiness {
    return this.readiness;
  }

  assertReady(): void {
    if (this.readiness.status !== 'ready') {
      throw new Error(this.readiness.code);
    }
  }

  private failReadiness(code: StorageReadinessFailureCode): void {
    this.readiness = Object.freeze({ status: 'not_ready', code });
    this.log.error(`object storage is not ready: ${code}`);
  }

  /**
   * Attempt objects are never public/canonical. A one-day tagged lifecycle is the last-resort
   * convergence path for a producer that resumes after its frozen cleanup command has settled.
   * Every product replica is validate-only so replicas never race a full-bucket lifecycle PUT.
   * A single deployment owner/IaC must provision the bucket and lifecycle contract.
   */
  private async ensureVariantAttemptLifecycle(): Promise<void> {
    let rules: LifecycleRule[] = [];
    try {
      const current = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
      );
      rules = current.Rules ?? [];
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name !== 'NoSuchLifecycleConfiguration' && name !== 'NoSuchLifecycle') throw error;
    }
    const expected = {
      ID: VARIANT_ATTEMPT_LIFECYCLE_RULE_ID,
      Status: 'Enabled' as const,
      Filter: {
        Tag: {
          Key: VARIANT_ATTEMPT_LIFECYCLE_TAG,
          Value: VARIANT_ATTEMPT_LIFECYCLE_VALUE,
        },
      },
      Expiration: { Days: 1 },
    };
    const current = rules.find((rule) => rule.ID === VARIANT_ATTEMPT_LIFECYCLE_RULE_ID);
    if (
      current?.Status === expected.Status &&
      current.Expiration?.Days === expected.Expiration.Days &&
      current.Filter?.Tag?.Key === expected.Filter.Tag.Key &&
      current.Filter?.Tag?.Value === expected.Filter.Tag.Value
    ) return;
    throw new StorageLifecycleContractError(
      'required variant-attempt lifecycle is missing; configure it through the single deployment owner',
    );
  }

  async presignPut(
    key: string,
    contentType: string,
    ttlS = PRESIGN_PUT_TTL_S,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.assertReady();
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlS },
    );
    return { url, expiresAt: new Date(Date.now() + ttlS * 1000) };
  }

  async presignGet(key: string, ttlS = PRESIGN_GET_TTL_S): Promise<string> {
    this.assertReady();
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlS,
    });
  }

  /** 对象元信息；不存在返回 null（fail-safe 判断，调用方决定 409/422）。 */
  async head(key: string, signal?: AbortSignal): Promise<{ size: number; contentType: string | null } | null> {
    this.assertReady();
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotFound' || name === 'NoSuchKey' || name === '404') return null;
      throw err;
    }
  }

  async getBuffer(key: string, signal?: AbortSignal): Promise<Buffer> {
    this.assertReady();
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`empty object body: ${key}`);
    return Buffer.from(bytes);
  }

  /** Read a small trusted class of object with a hard byte ceiling (image pipeline input). */
  async getBufferBounded(key: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be positive');
    this.assertReady();
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
    const stream = res.Body as Readable | undefined;
    if (!stream) throw new Error(`empty object body: ${key}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > maxBytes) {
        stream.destroy();
        throw new Error(`object exceeds ${maxBytes} bytes: ${key}`);
      }
      chunks.push(buf);
    }
    if (size === 0) throw new Error(`empty object body: ${key}`);
    return Buffer.concat(chunks, size);
  }

  /** 流式 sha256 + 魔数头（Codex P2：500MB 视频整段进 Buffer 会打爆内存）。 */
  async hashObject(key: string, signal?: AbortSignal): Promise<{ sha256: string; head: Buffer; size: number }> {
    this.assertReady();
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
    const stream = res.Body as Readable | undefined;
    if (!stream) throw new Error(`empty object body: ${key}`);
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    let size = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(buf);
      size += buf.length;
      if (head.length < 16) head = Buffer.concat([head, buf]).subarray(0, 16);
    }
    return { sha256: hash.digest('hex'), head, size };
  }

  async putBuffer(
    key: string,
    data: Buffer,
    contentType: string,
    signal?: AbortSignal,
    options?: { lifecycle?: 'variant-attempt' },
  ): Promise<void> {
    this.assertReady();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ...(options?.lifecycle === 'variant-attempt'
          ? { Tagging: `${VARIANT_ATTEMPT_LIFECYCLE_TAG}=${VARIANT_ATTEMPT_LIFECYCLE_VALUE}` }
          : {}),
      }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  /**
   * Create one producer-isolated Release object exactly once. A 412 means a prior
   * attempt may have committed despite a lost acknowledgement; callers must hash
   * the existing object before accepting it.
   */
  async putBufferImmutable(
    key: string,
    data: Buffer,
    contentType: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<'created' | 'exists'> {
    this.assertReady();
    const actual = createHash('sha256').update(data).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(sha256) || actual !== sha256) {
      throw new Error(`immutable object sha256 mismatch: ${key}`);
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          Metadata: { sha256 },
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      return 'created';
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && '$metadata' in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      const name = error instanceof Error ? error.name : '';
      if (status === 412 || name === 'PreconditionFailed') return 'exists';
      throw error;
    }
  }

  async copy(fromKey: string, toKey: string, signal?: AbortSignal): Promise<void> {
    this.assertReady();
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
        Key: toKey,
        // Attempt sources carry an expiry tag. Canonical objects must never inherit it.
        TaggingDirective: 'REPLACE',
        Tagging: '',
      }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    this.assertReady();
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  async deletePrefix(prefix: string, signal?: AbortSignal): Promise<number> {
    if (!prefix.endsWith('/') || prefix.includes('..')) {
      throw new Error('invalid object deletion prefix');
    }
    this.assertReady();
    let deleted = 0;
    for (let page = 0; page < 10_000; page += 1) {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      const objects = (listed.Contents ?? [])
        .map(({ Key }) => Key)
        .filter((key): key is string => Boolean(key));
      if (objects.length === 0) return deleted;
      if (objects.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: objects.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
          signal ? { abortSignal: signal } : undefined,
        );
        if ((result.Errors?.length ?? 0) > 0) {
          throw new Error('Release prefix deletion returned object errors');
        }
        deleted += objects.length;
      }
    }
    throw new Error('Release prefix deletion exceeded page safety bound');
  }
}
