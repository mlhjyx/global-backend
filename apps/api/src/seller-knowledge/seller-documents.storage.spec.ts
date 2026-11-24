import { describe, expect, it } from 'vitest';
import { SellerDocumentsStorage } from './seller-documents.storage';

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
});
