import 'reflect-metadata';
import {
  ConflictException,
  GoneException,
  Module,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import type { RequestContext } from '../auth/request-context';
import { ROLES_TO_SCOPES_POLICY, type AuthorizationScope } from '../auth/scopes';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import type { PrismaService } from '../prisma/prisma.service';
import type { TemporalClient } from '../temporal/temporal.client';
import { DataExportsController } from './data-exports.controller';
import {
  buildWorkspaceExportPayload,
  DataExportTooLargeError,
} from './data-exports.formatter';
import { DataExportsService } from './data-exports.service';
import type { DataExportStorage } from './data-exports.storage';
import type { DataExportJobRecord } from './data-exports.types';
import { buildZipArchive } from './zip-writer';

const WS_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000002';
const EXPORT_ID = '30000000-0000-4000-8000-000000000003';

function makeJob(overrides: Partial<DataExportJobRecord> = {}): DataExportJobRecord {
  const now = new Date('2026-11-26T00:00:00.000Z');
  return {
    id: EXPORT_ID,
    workspaceId: WS_ID,
    requestedBy: USER_ID,
    scope: 'leads',
    format: 'csv',
    status: 'pending',
    objectKey: null,
    contentType: null,
    filename: null,
    byteSize: null,
    rowCount: null,
    errorCode: null,
    expiresAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

Reflect.defineMetadata('design:paramtypes', [DataExportsService], DataExportsController);
Reflect.defineMetadata('design:paramtypes', [TokenVerifier, Object], AuthGuard);
Reflect.defineMetadata('design:paramtypes', [Reflector], ScopesGuard);

describe('buildZipArchive (zero-dependency node:zlib PKZIP)', () => {
  it('writes valid PKZIP local/central headers that round-trip via inflateRawSync', () => {
    const zip = buildZipArchive(
      [
        { name: 'leads.csv', data: '\uFEFFid,name\r\n1,Acme\r\n' },
        { name: 'manifest.json', data: '{"ok":true}' },
      ],
      new Date('2026-11-26T01:02:04.000Z'),
    );
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    // Find EOCD at end (22 bytes)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(2); // 2 entries

    const nameLen = zip.readUInt16LE(26);
    const compSize = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('leads.csv');
    const inflated = inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + compSize));
    expect(inflated.toString('utf8')).toBe('\uFEFFid,name\r\n1,Acme\r\n');
  });
});

describe('DataExportsController (HTTP)', () => {
  function boot(
    service: Partial<DataExportsService>,
    scopes: AuthorizationScope[] = ['acquisition:read', 'acquisition:export'],
  ) {
    const verifier: TokenVerifier = {
      async verify(token: string): Promise<RequestContext> {
        if (token === 'valid-token') {
          return { workspaceId: WS_ID, userId: USER_ID, roles: ['ADMIN'], scopes };
        }
        throw new UnauthorizedException({ error: { code: 'TOKEN_INVALID', message: 'invalid' } });
      },
    };
    const policy = { resolve: () => scopes };

    @Module({
      controllers: [DataExportsController],
      providers: [
        { provide: DataExportsService, useValue: service },
        { provide: TokenVerifier, useValue: verifier },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
        { provide: AuthGuard, useValue: new AuthGuard(verifier, policy) },
        { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
      ],
    })
    class TestModule {}

    return NestFactory.create<NestExpressApplication>(TestModule, {
      logger: false,
      abortOnError: false,
    }).then(async (app) => {
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      app.useGlobalFilters(new GlobalHttpExceptionFilter());
      await app.listen(0, '127.0.0.1');
      return app;
    });
  }

  const AUTH = { Authorization: 'Bearer valid-token' };

  it('rejects callers missing acquisition:export scope with 403', async () => {
    const app = await boot({ createExport: vi.fn() }, ['acquisition:read']);
    try {
      const res = await fetch(`${await app.getUrl()}/api/v1/data-exports`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'leads', format: 'csv' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('handles create (202), list pagination, get, and download streaming + 409/410 errors', async () => {
    const csvPayload = Buffer.from('\uFEFFid,name\r\n1,Acme\r\n', 'utf8');
    const createExport = vi.fn(async () => makeJob());
    const listExports = vi.fn(async () => ({
      data: [makeJob({ status: 'ready', byteSize: BigInt(csvPayload.length), rowCount: 1 })],
      nextCursor: null,
      hasMore: false,
    }));
    const getExport = vi.fn(async () => makeJob({ status: 'ready' }));
    const openDownloadStream = vi
      .fn()
      .mockResolvedValueOnce({
        stream: Readable.from([csvPayload]),
        contentType: 'text/csv; charset=utf-8',
        filename: '导出=leads.csv',
        contentLength: csvPayload.length,
      })
      .mockRejectedValueOnce(new ConflictException({ error: { code: 'DATA_EXPORT_NOT_READY', message: 'not ready' } }))
      .mockRejectedValueOnce(new GoneException({ error: { code: 'DATA_EXPORT_EXPIRED', message: 'expired' } }));

    const app = await boot({ createExport, listExports, getExport, openDownloadStream });
    try {
      const base = await app.getUrl();
      const createRes = await fetch(`${base}/api/v1/data-exports`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'leads', format: 'csv' }),
      });
      expect(createRes.status).toBe(202);
      expect((await createRes.json()).data).toMatchObject({ id: EXPORT_ID, status: 'pending' });

      const badCreate = await fetch(`${base}/api/v1/data-exports`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'invalid', format: 'csv' }),
      });
      expect(badCreate.status).toBe(400);

      const listRes = await fetch(`${base}/api/v1/data-exports?limit=10`, { headers: AUTH });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.page).toEqual({ next_cursor: null, has_more: false });
      expect(listJson.data[0].byteSize).toBe(csvPayload.length);

      const dlRes = await fetch(`${base}/api/v1/data-exports/${EXPORT_ID}/download`, { headers: AUTH });
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get('cache-control')).toBe('no-store');
      expect(dlRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(dlRes.headers.get('content-disposition')).toContain("filename*=UTF-8''");
      expect(Buffer.from(await dlRes.arrayBuffer())).toEqual(csvPayload);

      const res409 = await fetch(`${base}/api/v1/data-exports/${EXPORT_ID}/download`, { headers: AUTH });
      expect(res409.status).toBe(409);

      const res410 = await fetch(`${base}/api/v1/data-exports/${EXPORT_ID}/download`, { headers: AUTH });
      expect(res410.status).toBe(410);
    } finally {
      await app.close();
    }
  });
});

describe('DataExportsService bounds & formatter CWE-1236 protection', () => {
  it('enforces max 2 active exports (409) and max 10 per 24h (429)', async () => {
    let activeCount = 2;
    let recentCount = 0;
    const prisma = {
      withWorkspace: async (_wid: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async () => 0,
          dataExportJob: {
            count: async (args: { where: { status?: unknown } }) =>
              args.where.status ? activeCount : recentCount,
            create: async () => makeJob(),
          },
        }),
    } as unknown as PrismaService;
    const svc = new DataExportsService(
      prisma,
      {} as DataExportStorage,
      { client: { workflow: { start: vi.fn() } } } as unknown as TemporalClient,
    );
    const ctx: RequestContext = {
      workspaceId: WS_ID,
      userId: USER_ID,
      roles: ['ADMIN'],
      scopes: ['acquisition:read', 'acquisition:export'],
    };

    await expect(svc.createExport(ctx, { scope: 'leads', format: 'csv' })).rejects.toMatchObject({
      status: 409,
    });

    activeCount = 0;
    recentCount = 10;
    await expect(svc.createExport(ctx, { scope: 'leads', format: 'csv' })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('neutralizes CSV formula injection (CWE-1236) and rejects oversized domain reads', async () => {
    const contactTx = {
      canonicalContact: {
        findMany: async () => [
          {
            id: 'c1',
            companyId: 'co1',
            fullName: '=CMD("calc")',
            title: '+1+1',
            seniority: 'vp',
            department: '@sales',
            createdAt: new Date('2026-11-26T00:00:00Z'),
            company: { name: '-Danger Co', domain: 'danger.test' },
            contactPoints: [
              {
                id: 'cp1',
                type: 'email',
                value: 'alice@danger.test',
                status: 'VALID',
                verificationState: 'VALID',
                emailType: 'personal',
                sourceType: 'contact_page',
                sourceUrl: null,
                legalBasis: 'legitimate_interest',
                verifiedAt: null,
                createdAt: new Date('2026-11-26T00:00:00Z'),
              },
            ],
          },
        ],
      },
    };
    const csvOut = await buildWorkspaceExportPayload(contactTx as never, {
      workspaceId: WS_ID,
      exportId: EXPORT_ID,
      scope: 'contacts',
      format: 'csv',
    });
    const text = csvOut.body.toString('utf8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain("'-Danger Co");
    expect(text).toContain(`"'=CMD(""calc"")"`);
    expect(text).toContain("'+1+1");
    expect(text).toContain("'@sales");
    expect(csvOut.rowCount).toBe(1);

    const oversizedTx = {
      sellerDocument: {
        findMany: async () =>
          Array.from({ length: 500 }, (_, i) => ({
            id: `doc-${i}`,
            companyId: 'co1',
            filename: 'a.pdf',
            mime: 'application/pdf',
            sizeBytes: 100n,
            kind: 'pdf',
            status: 'ready',
            contentHash: null,
            parseRevision: 1,
            chunkCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
      },
      lead: { findMany: async () => [] },
      canonicalCompany: { findMany: async () => [] },
      companyProfile: { findMany: async () => [] },
      canonicalContact: { findMany: async () => [] },
      leadOutreachDraft: { findMany: async () => [] },
      suppressionRecord: { findMany: async () => [] },
      suppressionDecision: { findMany: async () => [] },
      discoveryRun: { findMany: async () => [] },
      icpDefinition: { findMany: async () => [] },
    };
    await expect(
      buildWorkspaceExportPayload(oversizedTx as never, {
        workspaceId: WS_ID,
        exportId: EXPORT_ID,
        scope: 'full_archive',
        format: 'jsonl',
      }),
    ).rejects.toBeInstanceOf(DataExportTooLargeError);
  });
});
