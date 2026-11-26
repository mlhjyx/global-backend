import 'reflect-metadata';
import { PassThrough, Readable } from 'node:stream';
import {
  ConflictException,
  Module,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import type { RequestContext } from '../auth/request-context';
import { ROLES_TO_SCOPES_POLICY, type AuthorizationScope } from '../auth/scopes';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import {
  SellerCompanyDocumentsController,
  SellerDocumentsController,
} from './seller-documents.controller';
import { SellerDocumentsService } from './seller-documents.service';

const DOC_ID = '40000000-0000-4000-8000-000000000004';
const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read'],
};

const verifier: TokenVerifier = {
  async verify(token: string): Promise<RequestContext> {
    if (token === 'valid-token') return CTX;
    throw new UnauthorizedException({ error: { code: 'TOKEN_INVALID', message: 'invalid' } });
  },
};
const policy = {
  resolve: (): AuthorizationScope[] => ['acquisition:read'],
};

Reflect.defineMetadata('design:paramtypes', [SellerDocumentsService], SellerDocumentsController);
Reflect.defineMetadata('design:paramtypes', [SellerDocumentsService], SellerCompanyDocumentsController);
Reflect.defineMetadata('design:paramtypes', [TokenVerifier, Object], AuthGuard);
Reflect.defineMetadata('design:paramtypes', [Reflector], ScopesGuard);

describe('SellerDocumentsController · GET /api/v1/seller-documents/:documentId/content (HTTP)', () => {
  async function boot(openContentStream: ReturnType<typeof vi.fn>) {
    @Module({
      controllers: [SellerDocumentsController],
      providers: [
        { provide: SellerDocumentsService, useValue: { openContentStream } },
        { provide: TokenVerifier, useValue: verifier },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
        { provide: AuthGuard, useValue: new AuthGuard(verifier, policy) },
        { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
      ],
    })
    class TestModule {}

    const app = await NestFactory.create<NestExpressApplication>(TestModule, {
      logger: false,
      abortOnError: false,
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    return app;
  }

  const AUTH = { Authorization: 'Bearer valid-token' };

  it('streams bytes with Content-Type, sanitized Content-Disposition, Content-Length, no-store, and nosniff', async () => {
    const payload = Buffer.from('%PDF-1.7\nhello world\n');
    const openContentStream = vi.fn(async () => ({
      stream: Readable.from([payload.subarray(0, 8), payload.subarray(8)]),
      mime: 'application/pdf',
      filename: '产品目录-2026.pdf',
      contentLength: payload.length,
    }));
    const app = await boot(openContentStream);
    try {
      const res = await fetch(`${await app.getUrl()}/api/v1/seller-documents/${DOC_ID}/content`, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/pdf');
      expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('产品目录-2026.pdf')}`);
      expect(res.headers.get('content-length')).toBe(String(payload.length));
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body).toEqual(payload);
    } finally {
      await app.close();
    }
  });

  it('returns 400 VALIDATION_ERROR for non-UUID documentId without calling service', async () => {
    const openContentStream = vi.fn();
    const app = await boot(openContentStream);
    try {
      const res = await fetch(`${await app.getUrl()}/api/v1/seller-documents/not-a-uuid/content`, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(openContentStream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 404 and 409 JSON errors without setting download headers', async () => {
    const openContentStream = vi
      .fn()
      .mockRejectedValueOnce(new NotFoundException({ error: { code: 'NOT_FOUND', message: 'document not found' } }))
      .mockRejectedValueOnce(new ConflictException({ error: { code: 'SELLER_DOCUMENT_NOT_READY', message: 'not ready' } }));
    const app = await boot(openContentStream);
    try {
      const res404 = await fetch(`${await app.getUrl()}/api/v1/seller-documents/${DOC_ID}/content`, { headers: AUTH });
      expect(res404.status).toBe(404);
      expect(res404.headers.get('content-disposition')).toBeNull();
      expect(res404.headers.get('content-length')).not.toBe('0');
      expect(await res404.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

      const res409 = await fetch(`${await app.getUrl()}/api/v1/seller-documents/${DOC_ID}/content`, { headers: AUTH });
      expect(res409.status).toBe(409);
      expect(res409.headers.get('content-disposition')).toBeNull();
      expect(await res409.json()).toMatchObject({ error: { code: 'SELLER_DOCUMENT_NOT_READY' } });
    } finally {
      await app.close();
    }
  });

  it('destroys stream cleanly on mid-stream error without crashing the process', async () => {
    const stream = new PassThrough();
    const openContentStream = vi.fn(async () => ({
      stream,
      mime: 'application/pdf',
      filename: 'broken.pdf',
      contentLength: 100,
    }));
    const app = await boot(openContentStream);
    try {
      const fetchPromise = fetch(`${await app.getUrl()}/api/v1/seller-documents/${DOC_ID}/content`, { headers: AUTH })
        .then(async (r) => {
          await r.arrayBuffer();
        })
        .catch((err: unknown) => err);

      await new Promise((r) => setTimeout(r, 30));
      stream.write(Buffer.from('partial'));
      stream.destroy(new Error('s3 socket reset'));

      const outcome = await fetchPromise;
      expect(stream.destroyed).toBe(true);
      expect(outcome).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

describe('SellerCompanyDocumentsController · S3 Multipart 分片上传路由', () => {
  const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
  const WRITE_CTX: RequestContext = {
    ...CTX,
    scopes: ['acquisition:read', 'acquisition:write'],
  };

  it('initMultipart / uploadPart / completeMultipart 正确委派服务并返回标准信封', async () => {
    const svc = {
      initMultipartUpload: vi.fn(async () => ({
        documentId: DOC_ID,
        uploadId: 'up-999',
        partSizeBytes: 5 * 1024 * 1024,
      })),
      uploadMultipartPart: vi.fn(async () => ({
        partNumber: 2,
        etag: '"etag-2"',
      })),
      completeMultipartUpload: vi.fn(async () => ({
        id: DOC_ID,
        companyId: COMPANY_ID,
        filename: 'big.pdf',
        mime: 'application/pdf',
        sizeBytes: 12_000_000n,
        kind: 'pdf',
        status: 'pending_upload',
        processingErrorCode: null,
        chunkCount: 0,
        parsedMeta: null,
        factsExtractedAt: null,
        createdAt: new Date('2026-11-26T12:00:00Z'),
      })),
    };
    const controller = new SellerCompanyDocumentsController(svc as unknown as SellerDocumentsService);

    const init = await controller.initMultipart(WRITE_CTX, COMPANY_ID, DOC_ID);
    expect(init.data).toEqual({
      documentId: DOC_ID,
      uploadId: 'up-999',
      partSizeBytes: 5 * 1024 * 1024,
    });

    const part = await controller.uploadPart(WRITE_CTX, COMPANY_ID, DOC_ID, '2', 'up-999', {
      body: Buffer.from('part-bytes'),
    });
    expect(part.data).toEqual({ partNumber: 2, etag: '"etag-2"' });
    expect(svc.uploadMultipartPart).toHaveBeenCalledWith(
      WRITE_CTX,
      COMPANY_ID,
      DOC_ID,
      'up-999',
      2,
      Buffer.from('part-bytes'),
    );

    const completed = await controller.completeMultipart(WRITE_CTX, COMPANY_ID, DOC_ID, {
      uploadId: 'up-999',
      parts: [{ partNumber: 1, etag: '"etag-1"' }, { partNumber: 2, etag: '"etag-2"' }],
    });
    expect(completed.data.id).toBe(DOC_ID);
  });
});
