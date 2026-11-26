import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { SELLER_DOCUMENT_QUOTA } from '../seller-knowledge/seller-documents.service';
import type {
  UpdateWorkspaceDto,
  WorkspaceUsageSummaryDto,
} from './dto/workspace.dto';

type ArtifactSummaryRow = {
  total_count: bigint | number | null;
  total_bytes: bigint | number | null;
  personal_count: bigint | number | null;
  personal_bytes: bigint | number | null;
};

const RUNNING_DISCOVERY_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'QUICK',
  'DEEP',
  'FINALIZING',
]);
const COMPLETED_DISCOVERY_STATUSES = new Set(['DONE', 'PARTIAL']);
const FAILED_DISCOVERY_STATUSES = new Set(['FAILED', 'CANCELLED']);
const PROCESSING_DOC_STATUSES = new Set(['committing', 'queued', 'processing']);
const FAILED_DOC_STATUSES = new Set(['failed_terminal', 'rejected']);

function summarizeCompanies(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
) {
  const result = { total: 0, draft: 0, enriching: 0, review: 0, active: 0 };
  for (const row of rows) {
    const count = row._count._all;
    result.total += count;
    if (row.status === 'DRAFT') result.draft += count;
    else if (row.status === 'ENRICHING') result.enriching += count;
    else if (row.status === 'REVIEW') result.review += count;
    else if (row.status === 'ACTIVE') result.active += count;
  }
  return result;
}

function summarizeSellerDocuments(
  rows: ReadonlyArray<{
    status: string;
    _count: { _all: number };
    _sum: { sizeBytes: bigint | null };
  }>,
) {
  const result = {
    total: 0,
    ready: 0,
    pendingUpload: 0,
    processing: 0,
    failed: 0,
    totalBytes: 0,
    readyBytes: 0,
    pendingUploadBytes: 0,
    quota: {
      maxPerWorkspace: SELLER_DOCUMENT_QUOTA.perWorkspace,
      maxPerCompany: SELLER_DOCUMENT_QUOTA.perCompany,
      maxBytesPerWorkspace: SELLER_DOCUMENT_QUOTA.bytesPerWorkspace,
    },
  };
  for (const row of rows) {
    const count = row._count._all;
    const bytes = Number(row._sum.sizeBytes ?? 0n);
    result.total += count;
    result.totalBytes += bytes;
    if (row.status === 'ready') {
      result.ready += count;
      result.readyBytes += bytes;
    } else if (row.status === 'pending_upload') {
      result.pendingUpload += count;
      result.pendingUploadBytes += bytes;
    } else if (PROCESSING_DOC_STATUSES.has(row.status)) {
      result.processing += count;
    } else if (FAILED_DOC_STATUSES.has(row.status)) {
      result.failed += count;
    }
  }
  return result;
}

function summarizeDiscoveryRuns(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
) {
  const result = { total: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    const count = row._count._all;
    result.total += count;
    if (RUNNING_DISCOVERY_STATUSES.has(row.status)) result.running += count;
    else if (COMPLETED_DISCOVERY_STATUSES.has(row.status)) result.completed += count;
    else if (FAILED_DISCOVERY_STATUSES.has(row.status)) result.failed += count;
  }
  return result;
}

function summarizeCanonicalCompanies(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
) {
  const result = { total: 0, suppressed: 0 };
  for (const row of rows) {
    result.total += row._count._all;
    if (row.status === 'SUPPRESSED') result.suppressed += row._count._all;
  }
  return result;
}

function summarizeSiteReleases(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
) {
  const result = { total: 0, ready: 0 };
  for (const row of rows) {
    result.total += row._count._all;
    if (row.status === 'ready') result.ready += row._count._all;
  }
  return result;
}

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async update(ctx: RequestContext, dto: UpdateWorkspaceDto) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.workspace.upsert({
        where: { id: ctx.workspaceId },
        update: { name: dto.name },
        create: { id: ctx.workspaceId, name: dto.name },
      }),
    );
  }

  async usageSummary(ctx: RequestContext): Promise<WorkspaceUsageSummaryDto> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const [
        companyGroups,
        sellerDocGroups,
        icpsTotal,
        discoveryGroups,
        canonicalCompanyGroups,
        canonicalContactsTotal,
        assetAgg,
        assetVariantAgg,
        siteReleaseGroups,
        artifactSummaryRows,
      ] = await Promise.all([
        tx.companyProfile.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        tx.sellerDocument.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
          _sum: { sizeBytes: true },
        }),
        tx.icpDefinition.count(),
        tx.discoveryRun.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        tx.canonicalCompany.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        tx.canonicalContact.count(),
        tx.asset.aggregate({
          where: { deletedAt: null },
          _count: { _all: true },
          _sum: { sizeBytes: true },
        }),
        tx.assetVariant.aggregate({
          _count: { _all: true },
          _sum: { sizeBytes: true },
        }),
        tx.siteRelease.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        tx.$queryRaw<ArtifactSummaryRow[]>(Prisma.sql`
          SELECT total_count, total_bytes, personal_count, personal_bytes
          FROM public.summarize_workspace_generic_operation_artifacts_v1()
        `),
      ]);

      const artifactRow = artifactSummaryRows[0];
      return {
        workspaceId: ctx.workspaceId,
        companies: summarizeCompanies(companyGroups),
        sellerDocuments: summarizeSellerDocuments(sellerDocGroups),
        icps: { total: icpsTotal },
        discoveryRuns: summarizeDiscoveryRuns(discoveryGroups),
        canonicalCompanies: summarizeCanonicalCompanies(canonicalCompanyGroups),
        canonicalContacts: { total: canonicalContactsTotal },
        siteAssets: {
          total: assetAgg._count._all,
          totalBytes: Number(assetAgg._sum.sizeBytes ?? 0),
          variants: assetVariantAgg._count._all,
          variantBytes: Number(assetVariantAgg._sum.sizeBytes ?? 0),
        },
        siteReleases: summarizeSiteReleases(siteReleaseGroups),
        operationArtifacts: {
          total: Number(artifactRow?.total_count ?? 0n),
          totalBytes: Number(artifactRow?.total_bytes ?? 0n),
          personalDataCount: Number(artifactRow?.personal_count ?? 0n),
          personalDataBytes: Number(artifactRow?.personal_bytes ?? 0n),
        },
      };
    });
  }
}
