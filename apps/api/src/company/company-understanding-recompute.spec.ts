import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import type { SellerDocumentClaimsService } from '../seller-knowledge/seller-document-claims.service';
import { CompanyController } from './company.controller';
import { CompanyUnderstandingRecomputeService } from './company-understanding-recompute.service';
import { RecomputeUnderstandingDto } from './dto/recompute-understanding.dto';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const DOC_1 = '40000000-0000-4000-8000-000000000001';
const DOC_2 = '40000000-0000-4000-8000-000000000002';

function makeWorld(opts: {
  company?: {
    id: string;
    status: string;
    deletedAt: Date | null;
    industry: string | null;
    targetMarkets: string[];
  } | null;
  documents?: Array<{ id: string; factsExtractedAt: Date | null }>;
  offerings?: Array<{ name: string; attributes: unknown }>;
  draftsPerDoc?: Record<string, Array<{ replayed: boolean }>>;
} = {}) {
  const company =
    opts.company === undefined
      ? {
          id: COMPANY_ID,
          status: 'ACTIVE',
          deletedAt: null,
          industry: 'Industrial Machinery',
          targetMarkets: ['DE', 'US'],
        }
      : opts.company;

  const docs = opts.documents ?? [{ id: DOC_1, factsExtractedAt: null }];
  const stampedIds: string[] = [];
  const docFindMany = vi.fn(async (args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    const idFilter = (where.id as { in?: string[] } | undefined)?.in;
    const requireUnextracted = where.factsExtractedAt === null;
    return docs.filter((d) => {
      if (idFilter && !idFilter.includes(d.id)) return false;
      if (requireUnextracted && d.factsExtractedAt !== null) return false;
      return true;
    });
  });
  const docUpdateMany = vi.fn(async (args: { where: { id: string } }) => {
    stampedIds.push(args.where.id);
    return { count: 1 };
  });

  const tx = {
    $queryRaw: vi.fn(async () => (company && !company.deletedAt ? [{ id: company.id }] : [])),
    companyProfile: {
      findUnique: vi.fn(async () => company),
    },
    sellerDocument: {
      findMany: docFindMany,
      updateMany: docUpdateMany,
    },
    offering: {
      findMany: vi.fn(
        async () =>
          opts.offerings ?? [
            { name: 'CNC Valve', attributes: { selectedByUser: true } },
            { name: 'Deselected Item', attributes: { selectedByUser: false } },
          ],
      ),
    },
    claim: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { type: string } }) => ({
        id: `claim-${data.type}`,
      })),
    },
    evidence: {
      create: vi.fn(async () => ({ id: 'evidence-1' })),
    },
    knowledgeSource: {
      findFirst: vi.fn(async () => ({ id: 'source-1' })),
      create: vi.fn(async () => ({ id: 'source-new' })),
    },
  };

  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, cb: (client: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;

  const createAssistedDrafts = vi.fn(
    async (_ctx: RequestContext, _companyId: string, docId: string) => ({
      documentId: docId,
      parseRevision: 1,
      scannedChunks: 2,
      droppedModelSuggestions: 0,
      drafts: opts.draftsPerDoc?.[docId] ?? [
        { replayed: false },
        { replayed: true },
      ],
    }),
  );
  const documentClaims = {
    createAssistedDrafts,
  } as unknown as SellerDocumentClaimsService;

  return {
    tx,
    stampedIds,
    docFindMany,
    createAssistedDrafts,
    service: new CompanyUnderstandingRecomputeService(prisma, documentClaims),
  };
}

describe('CompanyUnderstandingRecomputeService', () => {
  it('throws 404 when company does not exist or is soft-deleted', async () => {
    const missing = makeWorld({ company: null });
    await expect(missing.service.recompute(CTX, COMPANY_ID, {})).rejects.toThrow(
      NotFoundException,
    );

    const deleted = makeWorld({
      company: {
        id: COMPANY_ID,
        status: 'DRAFT',
        deletedAt: new Date(),
        industry: null,
        targetMarkets: [],
      },
    });
    await expect(deleted.service.recompute(CTX, COMPANY_ID, {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 409 UNDERSTANDING_IN_PROGRESS when company is ENRICHING', async () => {
    const enriching = makeWorld({
      company: {
        id: COMPANY_ID,
        status: 'ENRICHING',
        deletedAt: null,
        industry: null,
        targetMarkets: [],
      },
    });
    await expect(
      enriching.service.recompute(CTX, COMPANY_ID, {}),
    ).rejects.toThrow(ConflictException);
    expect(enriching.createAssistedDrafts).not.toHaveBeenCalled();
  });

  it('extracts NEEDS_REVIEW claims from unextracted ready documents and profile facts without downgrading ACTIVE status', async () => {
    const world = makeWorld({
      documents: [
        { id: DOC_1, factsExtractedAt: null },
        { id: DOC_2, factsExtractedAt: new Date('2026-11-20T00:00:00Z') },
      ],
      draftsPerDoc: {
        [DOC_1]: [{ replayed: false }, { replayed: false }, { replayed: true }],
      },
    });

    const result = await world.service.recompute(CTX, COMPANY_ID, {});

    expect(world.createAssistedDrafts).toHaveBeenCalledTimes(1);
    expect(world.createAssistedDrafts).toHaveBeenCalledWith(CTX, COMPANY_ID, DOC_1);
    expect(world.stampedIds).toEqual([DOC_1]);
    expect(result).toEqual({
      companyId: COMPANY_ID,
      status: 'ACTIVE',
      documentsScanned: 1,
      draftsCreated: 2,
      profileDraftsCreated: 3, // CNC Valve + Industrial Machinery + DE/US (deselected excluded)
    });
  });

  it('scans previously extracted documents when force=true and filters by documentIds when provided', async () => {
    const world = makeWorld({
      documents: [
        { id: DOC_1, factsExtractedAt: new Date('2026-11-20T00:00:00Z') },
        { id: DOC_2, factsExtractedAt: new Date('2026-11-20T00:00:00Z') },
      ],
      draftsPerDoc: {
        [DOC_2]: [{ replayed: false }],
      },
    });

    const result = await world.service.recompute(CTX, COMPANY_ID, {
      documentIds: [DOC_2],
      force: true,
    });

    expect(world.createAssistedDrafts).toHaveBeenCalledTimes(1);
    expect(world.createAssistedDrafts).toHaveBeenCalledWith(CTX, COMPANY_ID, DOC_2);
    expect(world.stampedIds).toEqual([DOC_2]);
    expect(result.documentsScanned).toBe(1);
    expect(result.draftsCreated).toBe(1);

    const emptyFilter = await world.service.recompute(CTX, COMPANY_ID, {
      documentIds: [],
    });
    expect(emptyFilter.documentsScanned).toBe(0);
    expect(emptyFilter.draftsCreated).toBe(0);
  });

  it('rejects explicit null body fields with 400 VALIDATION_ERROR', async () => {
    const world = makeWorld();
    await expect(
      world.service.recompute(CTX, COMPANY_ID, {
        documentIds: null as unknown as string[],
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      world.service.recompute(CTX, COMPANY_ID, {
        force: null as unknown as boolean,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('decorates CompanyController.recomputeUnderstanding with acquisition:write + 200 OK and validates RecomputeUnderstandingDto', async () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_SCOPES_METADATA,
        CompanyController.prototype.recomputeUnderstanding,
      ),
    ).toEqual(['acquisition:write']);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        CompanyController.prototype.recomputeUnderstanding,
      ),
    ).toBe(200);

    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const meta = { type: 'body' as const, metatype: RecomputeUnderstandingDto };

    const valid = await pipe.transform(
      { documentIds: [DOC_1], force: true },
      meta,
    );
    expect(valid).toEqual({ documentIds: [DOC_1], force: true });

    await expect(
      pipe.transform({ documentIds: ['not-a-uuid'] }, meta),
    ).rejects.toThrow();
  });
});
