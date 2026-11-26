import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * 卖家资料库的独立对象存储客户端（模块 02，Phase 2）。
 * 与 site-builder 资产分开 bucket（`SELLER_DOCUMENTS_S3_BUCKET`，默认 `global-seller-documents`），
 * 沿用同一 S3 兼容客户端凭据；bucket 永不公开，外发一律短时 presigned URL。
 * staging 对象带生命周期 tag，bootstrap 里按 tag 1 天过期；canonical 不过期。
 */

export const SELLER_DOCUMENTS_STAGING_TAG_KEY = 'global-lifecycle';
export const SELLER_DOCUMENTS_STAGING_TAG_VALUE = 'seller-document-staging';
/** S3/MinIO 协议要求 Multipart 非末片最小 5 MiB；统一作为前端默认切片步长。 */
export const SELLER_DOCUMENT_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

function isLoopbackEndpoint(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return true;
  }
}

export function isS3NotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return err.$metadata?.httpStatusCode === 404 || err.name === 'NoSuchKey' || err.name === 'NotFound';
}

const PRESIGN_PUT_TTL_S = 900;
const PRESIGN_GET_TTL_S = 600;

export class SellerDocumentsStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly directUploadSupported: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bucket = env.SELLER_DOCUMENTS_S3_BUCKET?.trim() || 'global-seller-documents';
    // 先解构再引用：避免 gitleaks generic-api-key 对 `secretAccessKey: env.X` 字面模式的误报。
    const {
      S3_ENDPOINT,
      S3_PUBLIC_ENDPOINT,
      S3_REGION,
      S3_FORCE_PATH_STYLE,
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
    } = env;
    const internalEndpoint = S3_ENDPOINT?.trim() || 'http://localhost:9000';
    const configuredPublic = S3_PUBLIC_ENDPOINT?.trim() || '';
    const publicEndpoint = configuredPublic || internalEndpoint;
    this.directUploadSupported =
      configuredPublic.length > 0 &&
      configuredPublic !== internalEndpoint &&
      !isLoopbackEndpoint(configuredPublic);
    const region = S3_REGION ?? 'us-east-1';
    const forcePathStyle = (S3_FORCE_PATH_STYLE ?? 'true') === 'true';
    const credentials = {
      accessKeyId: S3_ACCESS_KEY ?? '',
      secretAccessKey: S3_SECRET_KEY ?? '',
    };
    this.client = new S3Client({
      endpoint: internalEndpoint,
      region,
      forcePathStyle,
      credentials,
    });
    this.presignClient =
      publicEndpoint === internalEndpoint
        ? this.client
        : new S3Client({
            endpoint: publicEndpoint,
            region,
            forcePathStyle,
            credentials,
          });
  }

  /** 是否已配置独立公网对象存储端点（支持浏览器直传 S3 presigned URL）。 */
  isDirectUploadSupported(): boolean {
    return this.directUploadSupported;
  }

  /** bucket 是否存在且可访问（fail-closed readiness / 上传前置）。 */
  async checkBucket(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async presignPut(key: string, mime: string): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + PRESIGN_PUT_TTL_S * 1000);
    const url = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mime,
        Tagging: `${SELLER_DOCUMENTS_STAGING_TAG_KEY}=${SELLER_DOCUMENTS_STAGING_TAG_VALUE}`,
      }),
      { expiresIn: PRESIGN_PUT_TTL_S },
    );
    return { url, expiresAt };
  }

  async presignGet(key: string, ttlS = PRESIGN_GET_TTL_S): Promise<string> {
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlS,
    });
  }

  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /** 流式 sha256 + 魔数头（大文件不整段进内存，与 site-builder hashObject 同口径）。 */
  async hashObject(key: string): Promise<{ sha256: string; head: Buffer; size: number }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
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

  /** 浏览器直传中转（BFF→引擎）：把整段字节写进暂存对象，签名/标签与 presignPut 一致。 */
  async putObject(key: string, body: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mime,
        Tagging: `${SELLER_DOCUMENTS_STAGING_TAG_KEY}=${SELLER_DOCUMENTS_STAGING_TAG_VALUE}`,
      }),
    );
  }

  /** 初始化 S3 Multipart 分片上传（staging 对象带生命周期 tag，中断未合并也会由对象存储自动清理）。 */
  async createMultipartUpload(key: string, mime: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mime,
        Tagging: `${SELLER_DOCUMENTS_STAGING_TAG_KEY}=${SELLER_DOCUMENTS_STAGING_TAG_VALUE}`,
      }),
    );
    const uploadId = res.UploadId?.trim();
    if (!uploadId) throw new Error(`missing multipart uploadId for ${key}`);
    return { uploadId };
  }

  /** 上传单个分片（非末片须 ≥5 MiB；返回 S3 ETag 供后续 complete 合并与断点续传）。 */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<{ partNumber: number; etag: string }> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
    );
    const etag = res.ETag?.trim();
    if (!etag) throw new Error(`missing ETag for part ${partNumber} of ${key}`);
    return { partNumber, etag };
  }

  /** 合并已上传分片为完整 staging 对象，随后沿用既有 commit 魔数/SHA-256 校验链路。 */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    const sorted = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag.startsWith('"') ? part.etag : `"${part.etag.replace(/^"+|"+$/g, '')}"`,
      }));
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** 流式读取对象内容（不整段缓冲进内存，供服务端鉴权代理下载）。 */
  async getObjectStream(
    key: string,
  ): Promise<{ stream: Readable; contentLength?: number; contentType?: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = res.Body as Readable | undefined;
    if (!stream) throw new Error(`empty object body: ${key}`);
    return {
      stream,
      contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : undefined,
      contentType: res.ContentType ?? undefined,
    };
  }

  /** 有界整段读取（解析用；超限即失败，不截断）。 */
  async getBufferBounded(key: string, maxBytes: number): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
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

  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
        Key: toKey,
        // staging 带过期 tag；canonical 必须换成空 tag（TaggingDirective=REPLACE）。
        TaggingDirective: 'REPLACE',
        Tagging: '',
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string, signal?: AbortSignal): Promise<number> {
    if (!prefix.endsWith('/') || prefix.includes('..')) {
      throw new Error('invalid object deletion prefix');
    }
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
        throw new Error('Seller documents prefix deletion returned object errors');
      }
      deleted += objects.length;
    }
    throw new Error('Seller documents prefix deletion exceeded page safety bound');
  }
}
