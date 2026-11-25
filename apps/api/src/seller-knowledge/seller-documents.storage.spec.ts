import { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { SellerDocumentsStorage, isS3NotFoundError } from './seller-documents.storage';

describe('SellerDocumentsStorage（presign 公网端点与内网端点解耦）', () => {
  it('配置 S3_PUBLIC_ENDPOINT 时 presignPut / presignGet 使用外部可达域名签名', async () => {
    const storage = new SellerDocumentsStorage({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_PUBLIC_ENDPOINT: 'https://files.example.test',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY: 'test-access-key',
      S3_SECRET_KEY: 'test-secret-key',
    });

    const put = await storage.presignPut('ws/w1/seller-documents/staging/d1', 'application/pdf');
    const get = await storage.presignGet('ws/w1/companies/c1/seller-documents/d1/abc.pdf');

    expect(new URL(put.url).origin).toBe('https://files.example.test');
    expect(new URL(get).origin).toBe('https://files.example.test');
  });

  it('未配置 S3_PUBLIC_ENDPOINT 时回落到 S3_ENDPOINT', async () => {
    const storage = new SellerDocumentsStorage({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY: 'test-access-key',
      S3_SECRET_KEY: 'test-secret-key',
    });

    const get = await storage.presignGet('ws/w1/companies/c1/seller-documents/d1/abc.pdf');
    expect(new URL(get).origin).toBe('http://127.0.0.1:9000');
  });

  it('getObjectStream 返回 Readable 流与元数据而不缓冲字节，Body 缺失时抛错', async () => {
    const storage = new SellerDocumentsStorage({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY: 'test-access-key',
      S3_SECRET_KEY: 'test-secret-key',
    });
    const stream = Readable.from([Buffer.from('abc')]);
    const send = vi.fn(async (cmd: unknown) => {
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      return { Body: stream, ContentLength: 3, ContentType: 'application/pdf' };
    });
    (storage as unknown as { client: { send: typeof send } }).client = { send };

    const result = await storage.getObjectStream('ws/w1/doc.pdf');
    expect(result.stream).toBe(stream);
    expect(result.contentLength).toBe(3);
    expect(result.contentType).toBe('application/pdf');

    send.mockResolvedValueOnce({ Body: undefined, ContentLength: 0, ContentType: undefined });
    await expect(storage.getObjectStream('ws/w1/empty.pdf')).rejects.toThrow('empty object body');
  });

  it('isS3NotFoundError 识别 404 状态码与 NoSuchKey/NotFound', () => {
    expect(isS3NotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isS3NotFoundError({ name: 'NoSuchKey' })).toBe(true);
    expect(isS3NotFoundError({ name: 'NotFound' })).toBe(true);
    expect(isS3NotFoundError({ $metadata: { httpStatusCode: 503 }, name: 'ServiceUnavailable' })).toBe(false);
    expect(isS3NotFoundError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isS3NotFoundError(null)).toBe(false);
  });
});
