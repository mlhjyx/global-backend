import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
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

const PRESIGN_PUT_TTL_S = 900;
const PRESIGN_GET_TTL_S = 600;

export class SellerDocumentsStorage {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bucket = env.SELLER_DOCUMENTS_S3_BUCKET?.trim() || 'global-seller-documents';
    // 先解构再引用：避免 gitleaks generic-api-key 对 `secretAccessKey: env.X` 字面模式的误报。
    const { S3_ENDPOINT, S3_REGION, S3_FORCE_PATH_STYLE, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
    this.client = new S3Client({
      endpoint: S3_ENDPOINT ?? 'http://localhost:9000',
      region: S3_REGION ?? 'us-east-1',
      forcePathStyle: (S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: S3_ACCESS_KEY ?? '',
        secretAccessKey: S3_SECRET_KEY ?? '',
      },
    });
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
      this.client,
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
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
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
}
