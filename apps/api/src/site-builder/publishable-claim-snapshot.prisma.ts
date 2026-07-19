import { Prisma } from '@prisma/client';
import { hasValidClaimApprovalAudit } from '../claim/claim-verification';
import { isCertificationClaim } from './claim-classification';
import type {
  CurrentPublishableClaimState,
  PublishableClaimCandidate,
  PublishableClaimSnapshot,
  PublishableClaimSnapshotItem,
} from './publishable-claim-snapshot';
import type { PublishableClaimSnapshotRepository } from './publishable-claim-snapshot.service';

type SnapshotTx = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'site'
  | 'brandProfileClaimBridge'
  | 'sitePublishableClaimSnapshot'
>;

type StoredItem = {
  claimId: string;
  claimVersion: number;
  factKey: string;
  claimType: string;
  statement: string;
  validUntil: Date | null;
  approvedBy: string;
  approvedAt: Date;
  bridgeId: string;
  brandProfileId: string;
  evidenceRefId: string;
  evidenceId: string;
  sourceSnapshotId: string;
  sourceContentHash: string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  quotePrefix: string | null;
  quoteSuffix: string | null;
  certAssetId: string | null;
};

function storedItem(item: StoredItem): PublishableClaimSnapshotItem {
  return {
    claimId: item.claimId,
    claimVersion: item.claimVersion,
    factKey: item.factKey,
    claimType: item.claimType,
    statement: item.statement,
    validUntil: item.validUntil?.toISOString() ?? null,
    approvedBy: item.approvedBy,
    approvedAt: item.approvedAt.toISOString(),
    bridgeId: item.bridgeId,
    brandProfileId: item.brandProfileId,
    evidenceRefId: item.evidenceRefId,
    evidenceId: item.evidenceId,
    sourceSnapshotId: item.sourceSnapshotId,
    sourceContentHash: item.sourceContentHash,
    quote: item.quote,
    selector: {
      start: item.quoteStart,
      end: item.quoteEnd,
      ...(item.quotePrefix ? { prefix: item.quotePrefix } : {}),
      ...(item.quoteSuffix ? { suffix: item.quoteSuffix } : {}),
    },
    ...(item.certAssetId ? { certAssetId: item.certAssetId } : {}),
  };
}

export class PrismaPublishableClaimSnapshotRepository implements PublishableClaimSnapshotRepository {
  constructor(private readonly tx: SnapshotTx) {}

  async findByBuildRun(
    workspaceId: string,
    buildRunId: string,
  ): Promise<PublishableClaimSnapshot | null> {
    // Serializes capture for this BuildRun before the unique snapshot insert.
    await this.tx.$queryRaw(Prisma.sql`
      SELECT id
        FROM site_build_run
       WHERE id = ${buildRunId}::uuid
         AND workspace_id = ${workspaceId}::uuid
       FOR UPDATE
    `);
    const row = await this.tx.sitePublishableClaimSnapshot.findFirst({
      where: { workspaceId, buildRunId },
      select: {
        workspaceId: true,
        siteId: true,
        companyProfileId: true,
        buildRunId: true,
        schemaVersion: true,
        capturedAt: true,
        snapshotDigest: true,
        items: {
          orderBy: { ordinal: 'asc' },
          select: {
            claimId: true,
            claimVersion: true,
            factKey: true,
            claimType: true,
            statement: true,
            validUntil: true,
            approvedBy: true,
            approvedAt: true,
            bridgeId: true,
            brandProfileId: true,
            evidenceRefId: true,
            evidenceId: true,
            sourceSnapshotId: true,
            sourceContentHash: true,
            quote: true,
            quoteStart: true,
            quoteEnd: true,
            quotePrefix: true,
            quoteSuffix: true,
            certAssetId: true,
          },
        },
      },
    });
    if (!row) return null;
    return {
      schemaVersion:
        row.schemaVersion as PublishableClaimSnapshot['schemaVersion'],
      workspaceId: row.workspaceId,
      siteId: row.siteId,
      companyProfileId: row.companyProfileId,
      buildRunId: row.buildRunId,
      capturedAt: row.capturedAt.toISOString(),
      digest: row.snapshotDigest,
      items: row.items.map(storedItem),
    };
  }

  async getSiteCompanyProfileId(
    workspaceId: string,
    siteId: string,
  ): Promise<string | null> {
    const site = await this.tx.site.findFirst({
      where: { id: siteId, workspaceId },
      select: { companyProfileId: true },
    });
    return site?.companyProfileId ?? null;
  }

  async listCandidates(
    workspaceId: string,
    siteId: string,
    companyProfileId: string,
    capturedAt: Date,
  ): Promise<PublishableClaimCandidate[]> {
    const rows = await this.tx.brandProfileClaimBridge.findMany({
      where: {
        workspaceId,
        siteId,
        companyProfileId,
        claim: {
          status: 'APPROVED',
          OR: [{ validUntil: null }, { validUntil: { gt: capturedAt } }],
        },
      },
      orderBy: [
        { claimId: 'asc' },
        { brandProfile: { version: 'desc' } },
        { id: 'asc' },
      ],
      select: {
        id: true,
        brandProfileId: true,
        evidenceRefId: true,
        evidenceId: true,
        certAssetId: true,
        claim: {
          select: {
            id: true,
            workspaceId: true,
            companyId: true,
            sourceId: true,
            originKey: true,
            factKey: true,
            type: true,
            statement: true,
            status: true,
            version: true,
            validUntil: true,
            verifiedBy: true,
            verifiedAt: true,
            verificationMethod: true,
            verificationProof: true,
          },
        },
        evidenceRef: {
          select: {
            sourceSnapshotId: true,
            sourceContentHash: true,
            quote: true,
            quoteStart: true,
            quoteEnd: true,
            quotePrefix: true,
            quoteSuffix: true,
          },
        },
        certAsset: {
          select: { kind: true, processingStatus: true, deletedAt: true },
        },
      },
    });

    const seen = new Set<string>();
    const candidates: PublishableClaimCandidate[] = [];
    for (const row of rows) {
      const claim = row.claim;
      if (seen.has(claim.id)) continue;
      seen.add(claim.id);
      const factKey = claim.factKey;
      const verifiedBy = claim.verifiedBy;
      const verifiedAt = claim.verifiedAt;
      const verificationMethod = claim.verificationMethod;
      const certification = isCertificationClaim({
        type: claim.type,
        key: factKey ?? undefined,
        value: claim.statement,
      });
      const certificationProofValid =
        row.certAssetId !== null &&
        row.certAsset?.kind === 'cert' &&
        row.certAsset.processingStatus === 'ready' &&
        row.certAsset.deletedAt === null;
      if (
        !factKey ||
        !verifiedBy ||
        !verifiedAt ||
        !verificationMethod ||
        !hasValidClaimApprovalAudit({
          id: claim.id,
          workspaceId: claim.workspaceId,
          companyId: claim.companyId,
          sourceId: claim.sourceId,
          originKey: claim.originKey,
          factKey,
          type: claim.type,
          statement: claim.statement,
          validUntil: claim.validUntil,
          version: claim.version,
          verifiedBy,
          verifiedAt,
          verificationMethod,
          verificationProof: claim.verificationProof,
        }) ||
        (certification && !certificationProofValid)
      ) {
        continue;
      }
      candidates.push({
        claimId: claim.id,
        workspaceId: claim.workspaceId,
        companyProfileId: claim.companyId,
        sourceId: claim.sourceId,
        originKey: claim.originKey,
        claimVersion: claim.version,
        factKey,
        claimType: claim.type,
        statement: claim.statement,
        status: claim.status,
        validUntil: claim.validUntil,
        verifiedBy,
        verifiedAt,
        verificationMethod,
        verificationProof: claim.verificationProof,
        bridgeId: row.id,
        brandProfileId: row.brandProfileId,
        evidenceRefId: row.evidenceRefId,
        evidenceId: row.evidenceId,
        sourceSnapshotId: row.evidenceRef.sourceSnapshotId,
        sourceContentHash: row.evidenceRef.sourceContentHash,
        quote: row.evidenceRef.quote,
        quoteStart: row.evidenceRef.quoteStart,
        quoteEnd: row.evidenceRef.quoteEnd,
        quotePrefix: row.evidenceRef.quotePrefix,
        quoteSuffix: row.evidenceRef.quoteSuffix,
        certAssetId: row.certAssetId,
        certificationProofValid,
      });
    }
    return candidates;
  }

  async persist(
    snapshot: PublishableClaimSnapshot,
  ): Promise<PublishableClaimSnapshot> {
    await this.tx.sitePublishableClaimSnapshot.create({
      data: {
        workspaceId: snapshot.workspaceId,
        siteId: snapshot.siteId,
        companyProfileId: snapshot.companyProfileId,
        buildRunId: snapshot.buildRunId,
        schemaVersion: snapshot.schemaVersion,
        capturedAt: new Date(snapshot.capturedAt),
        snapshotDigest: snapshot.digest,
        items: {
          create: snapshot.items.map((item, ordinal) => ({
            workspaceId: snapshot.workspaceId,
            siteId: snapshot.siteId,
            companyProfileId: snapshot.companyProfileId,
            ordinal,
            claimId: item.claimId,
            claimVersion: item.claimVersion,
            factKey: item.factKey,
            claimType: item.claimType,
            statement: item.statement,
            validUntil: item.validUntil ? new Date(item.validUntil) : null,
            approvedBy: item.approvedBy,
            approvedAt: new Date(item.approvedAt),
            bridgeId: item.bridgeId,
            brandProfileId: item.brandProfileId,
            evidenceRefId: item.evidenceRefId,
            evidenceId: item.evidenceId,
            sourceSnapshotId: item.sourceSnapshotId,
            sourceContentHash: item.sourceContentHash,
            quote: item.quote,
            quoteStart: item.selector.start,
            quoteEnd: item.selector.end,
            quotePrefix: item.selector.prefix,
            quoteSuffix: item.selector.suffix,
            certAssetId: item.certAssetId,
          })),
        },
      },
      select: { id: true },
    });
    return snapshot;
  }

  async listCurrentStates(
    workspaceId: string,
    siteId: string,
    snapshot: PublishableClaimSnapshot,
  ): Promise<CurrentPublishableClaimState[]> {
    await this.tx.$queryRaw(Prisma.sql`
      SELECT c.id
        FROM claim c
        JOIN brand_profile_claim_bridge b ON b.claim_id = c.id
       WHERE b.workspace_id = ${workspaceId}::uuid
         AND b.site_id = ${siteId}::uuid
         AND b.company_profile_id = ${snapshot.companyProfileId}::uuid
       ORDER BY c.id
       FOR UPDATE OF c
    `);
    const candidates = await this.listCandidates(
      workspaceId,
      siteId,
      snapshot.companyProfileId,
      new Date(),
    );
    return candidates.map((candidate) => ({
      claimId: candidate.claimId,
      claimVersion: candidate.claimVersion,
      status: candidate.status,
      validUntil: candidate.validUntil,
      bridgeId: candidate.bridgeId,
      certificationProofValid: candidate.certificationProofValid,
    }));
  }
}
