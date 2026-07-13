import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

const PRESIGN_PUT_TTL_S = 900; // 15min 完成直传
const PRESIGN_GET_TTL_S = 300;

/**
 * 对象存储薄封装（MinIO/S3 兼容，02 §2）。owner 凭证只在后端，
 * 外部一律短时 presigned URL；bucket 永不公开。
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
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
  }

  /** dev 幂等建桶；失败只告警（真正用到时再报错，不挡无关模块启动）。 */
  async onModuleInit(): Promise<void> {
    if (!process.env.S3_ACCESS_KEY) {
      this.log.warn('S3_ACCESS_KEY not set — object storage unavailable until configured');
      return;
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.log.log(`bucket ${this.bucket} created`);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
        this.log.warn(`ensure bucket failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async presignPut(
    key: string,
    contentType: string,
    ttlS = PRESIGN_PUT_TTL_S,
  ): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlS },
    );
    return { url, expiresAt: new Date(Date.now() + ttlS * 1000) };
  }

  async presignGet(key: string, ttlS = PRESIGN_GET_TTL_S): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlS,
    });
  }

  /** 对象元信息；不存在返回 null（fail-safe 判断，调用方决定 409/422）。 */
  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotFound' || name === 'NoSuchKey' || name === '404') return null;
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`empty object body: ${key}`);
    return Buffer.from(bytes);
  }

  /** 流式 sha256 + 魔数头（Codex P2：500MB 视频整段进 Buffer 会打爆内存）。 */
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

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
        Key: toKey,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
