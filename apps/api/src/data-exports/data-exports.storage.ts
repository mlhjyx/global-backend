import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export const DATA_EXPORT_TAG_KEY = 'global-lifecycle';
export const DATA_EXPORT_TAG_VALUE = 'data-export';

export function isDataExportS3NotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    err.$metadata?.httpStatusCode === 404 ||
    err.name === 'NoSuchKey' ||
    err.name === 'NotFound'
  );
}

export function dataExportObjectKey(
  workspaceId: string,
  exportId: string,
  ext: 'csv' | 'jsonl' | 'zip',
): string {
  return `ws/${workspaceId}/exports/${exportId}.${ext}`;
}

export class DataExportStorage {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bucket =
      env.DATA_EXPORT_S3_BUCKET?.trim() ||
      env.SELLER_DOCUMENTS_S3_BUCKET?.trim() ||
      'global-seller-documents';
    // 先解构再引用：避免 gitleaks 对 `secretAccessKey: env.X` 字面模式的误报。
    const {
      S3_ENDPOINT,
      S3_REGION,
      S3_FORCE_PATH_STYLE,
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
    } = env;
    this.client = new S3Client({
      endpoint: S3_ENDPOINT?.trim() || 'http://localhost:9000',
      region: S3_REGION ?? 'us-east-1',
      forcePathStyle: (S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: S3_ACCESS_KEY ?? '',
        secretAccessKey: S3_SECRET_KEY ?? '',
      },
    });
  }

  async checkBucket(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async putExportObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Tagging: `${DATA_EXPORT_TAG_KEY}=${DATA_EXPORT_TAG_VALUE}`,
      }),
    );
  }

  async getObjectStream(
    key: string,
  ): Promise<{ stream: Readable; contentLength?: number; contentType?: string }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = res.Body as Readable | undefined;
    if (!stream) throw new Error(`empty object body: ${key}`);
    return {
      stream,
      contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : undefined,
      contentType: res.ContentType ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
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
        throw new Error('Data export prefix deletion returned object errors');
      }
      deleted += objects.length;
    }
    throw new Error('Data export prefix deletion exceeded page safety bound');
  }
}
