import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  ApprovedEffectiveClaim,
  BridgeClaimStatus,
  ClaimEvidenceAsset,
  ClaimEvidenceBridgeRepository,
  ClaimEvidenceFactContext,
  PendingClaimProjectionInput,
  PendingClaimProjectionResult,
} from "./claim-evidence-bridge.service";
import { isCertificationClaim } from "./claim-classification";

type ClaimBridgeTx = Pick<
  Prisma.TransactionClient,
  | "$queryRaw"
  | "site"
  | "brandProfile"
  | "claim"
  | "evidence"
  | "brandProfileClaimBridge"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function claimTypeForBrandFact(key: string, value: string): string {
  const normalized = `${key} ${value}`
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  if (isCertificationClaim({ key, value })) {
    return "certification";
  }
  if (/case|customer|client|project|案例|客户|项目/u.test(normalized)) {
    return "case";
  }
  if (
    /pressure|capacity|frequency|voltage|power|speed|temperature|dimension|weight|性能|参数|压力|产能|频率|电压|功率|转速|温度|尺寸|重量/u.test(
      normalized,
    ) ||
    /\d+(?:[.,]\d+)?\s*(?:%|‰|℃|℉|°\s*[cf]|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|mv|kv|a|ma|w|kw|mw|wh|kwh|mah|nm|um|μm|mm|cm|m|km|in|ft|mg|g|kg|lb|oz|ml|l|m[23²³]|l\s*[/⁄]\s*min|n\s*[.·]\s*m)(?![\p{L}\p{N}])/iu.test(
      normalized,
    )
  ) {
    return "param";
  }
  if (/value[_\s-]?prop|价值主张/u.test(normalized)) return "value_prop";
  return "capability";
}

function verificationProof(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Prisma transaction adapter; callers keep this instance inside one workspace transaction. */
export class PrismaClaimEvidenceBridgeRepository implements ClaimEvidenceBridgeRepository {
  constructor(private readonly tx: ClaimBridgeTx) {}

  async getCompanyProfileIdForSite(
    workspaceId: string,
    siteId: string,
  ): Promise<string | null> {
    const site = await this.tx.site.findFirst({
      where: { id: siteId, workspaceId },
      select: { companyProfileId: true },
    });
    return site?.companyProfileId ?? null;
  }

  async getFactContext(
    workspaceId: string,
    brandProfileId: string,
    factIndex: number,
  ): Promise<ClaimEvidenceFactContext | null> {
    const profile = await this.tx.brandProfile.findFirst({
      where: { id: brandProfileId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        siteId: true,
        factSheet: true,
        site: { select: { companyProfileId: true } },
        evidenceRefs: {
          where: { factIndex },
          take: 2,
          orderBy: { id: "asc" },
          select: {
            id: true,
            factIndex: true,
            factKey: true,
            sourceSnapshotId: true,
            sourceContentHash: true,
            quote: true,
            quoteStart: true,
            quoteEnd: true,
            quotePrefix: true,
            quoteSuffix: true,
            sourceSnapshot: {
              select: { sourceRole: true, provenance: true },
            },
          },
        },
      },
    });
    if (!profile || !Array.isArray(profile.factSheet)) return null;
    const fact = profile.factSheet[factIndex];
    const ref = profile.evidenceRefs[0];
    if (
      profile.evidenceRefs.length !== 1 ||
      !isRecord(fact) ||
      !ref ||
      ref.factIndex !== factIndex ||
      typeof fact.key !== "string" ||
      typeof fact.value !== "string" ||
      typeof fact.claimType !== "string" ||
      !["certification", "case", "param", "value_prop", "capability"].includes(
        fact.claimType,
      ) ||
      fact.key !== ref.factKey ||
      (ref.sourceSnapshot.sourceRole !== "fact_candidate" &&
        ref.sourceSnapshot.sourceRole !== "research_hint")
    ) {
      return null;
    }
    const provenance = isRecord(ref.sourceSnapshot.provenance)
      ? ref.sourceSnapshot.provenance
      : {};
    return {
      workspaceId: profile.workspaceId,
      siteId: profile.siteId,
      companyProfileId: profile.site.companyProfileId,
      brandProfileId: profile.id,
      factIndex,
      factKey: ref.factKey,
      claimType: fact.claimType,
      value: fact.value,
      evidenceRef: {
        evidenceRefId: ref.id,
        sourceSnapshotId: ref.sourceSnapshotId,
        sourceRole: ref.sourceSnapshot.sourceRole,
        sourceContentHash: ref.sourceContentHash,
        quote: ref.quote,
        quoteStart: ref.quoteStart,
        quoteEnd: ref.quoteEnd,
        quotePrefix: ref.quotePrefix ?? undefined,
        quoteSuffix: ref.quoteSuffix ?? undefined,
        assetId: optionalString(provenance.assetId),
      },
    };
  }

  async getAsset(assetId: string): Promise<ClaimEvidenceAsset | null> {
    const rows = await this.tx.$queryRaw<ClaimEvidenceAsset[]>(Prisma.sql`
      SELECT id,
             workspace_id AS "workspaceId",
             site_id AS "siteId",
             kind,
             processing_status AS "processingStatus",
             deleted_at AS "deletedAt"
      FROM asset
      WHERE id = ${assetId}::uuid
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  async projectPendingClaim(
    input: PendingClaimProjectionInput,
  ): Promise<PendingClaimProjectionResult> {
    const claim = await this.tx.claim.upsert({
      where: {
        companyId_originKey: {
          companyId: input.companyProfileId,
          originKey: input.claimOriginKey,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        companyId: input.companyProfileId,
        originKey: input.claimOriginKey,
        type: input.type,
        statement: input.statement,
        status: "NEEDS_REVIEW",
        confidence: 1,
      },
      update: {},
      select: { id: true, status: true },
    });
    const evidence = await this.tx.evidence.upsert({
      where: {
        claimId_originKey: {
          claimId: claim.id,
          originKey: input.evidenceOriginKey,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        claimId: claim.id,
        originKey: input.evidenceOriginKey,
        sourceSnapshotId: input.evidence.sourceSnapshotId,
        sourceContentHash: input.evidence.sourceContentHash,
        snippet: input.evidence.quote,
        quoteStart: input.evidence.quoteStart,
        quoteEnd: input.evidence.quoteEnd,
        quotePrefix: input.evidence.quotePrefix,
        quoteSuffix: input.evidence.quoteSuffix,
        assetId: input.evidence.assetId,
        confidence: 1,
      },
      update: {},
      select: { id: true },
    });
    const inserted = await this.tx.brandProfileClaimBridge.createMany({
      data: [
        {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          companyProfileId: input.companyProfileId,
          brandProfileId: input.brandProfileId,
          evidenceRefId: input.evidence.evidenceRefId,
          factIndex: input.factIndex,
          claimId: claim.id,
          evidenceId: evidence.id,
          certAssetId: isCertificationClaim({
            type: input.type,
            value: input.statement,
          })
            ? input.evidence.assetId
            : undefined,
          bridgeKey: input.bridgeKey,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      const existing = await this.tx.brandProfileClaimBridge.findUnique({
        where: {
          workspaceId_siteId_bridgeKey: {
            workspaceId: input.workspaceId,
            siteId: input.siteId,
            bridgeKey: input.bridgeKey,
          },
        },
        select: {
          workspaceId: true,
          siteId: true,
          companyProfileId: true,
          brandProfileId: true,
          evidenceRefId: true,
          factIndex: true,
          claimId: true,
          evidenceId: true,
          certAssetId: true,
          bridgeKey: true,
        },
      });
      const expected = {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        companyProfileId: input.companyProfileId,
        brandProfileId: input.brandProfileId,
        evidenceRefId: input.evidence.evidenceRefId,
        factIndex: input.factIndex,
        claimId: claim.id,
        evidenceId: evidence.id,
        certAssetId: isCertificationClaim({
          type: input.type,
          value: input.statement,
        })
          ? (input.evidence.assetId ?? null)
          : null,
        bridgeKey: input.bridgeKey,
      };
      if (
        existing === null ||
        Object.entries(expected).some(
          ([key, value]) => existing[key as keyof typeof existing] !== value,
        )
      ) {
        throw new Error("BRIDGE_IDENTITY_CONFLICT");
      }
    }
    return {
      claimId: claim.id,
      evidenceId: evidence.id,
      status: claim.status as BridgeClaimStatus,
      reused: inserted.count === 0,
    };
  }

  async listClaimsForCompany(
    workspaceId: string,
    companyProfileId: string,
  ): Promise<ApprovedEffectiveClaim[]> {
    const claims = await this.tx.claim.findMany({
      where: { workspaceId, companyId: companyProfileId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        workspaceId: true,
        companyId: true,
        sourceId: true,
        originKey: true,
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
    });
    return claims.map((claim) => ({
      id: claim.id,
      workspaceId: claim.workspaceId,
      companyProfileId: claim.companyId,
      sourceId: claim.sourceId,
      originKey: claim.originKey,
      type: claim.type,
      statement: claim.statement,
      status: claim.status as BridgeClaimStatus,
      version: claim.version,
      validUntil: claim.validUntil,
      verifiedBy: claim.verifiedBy,
      verifiedAt: claim.verifiedAt,
      verificationMethod: claim.verificationMethod,
      verificationProof: verificationProof(claim.verificationProof),
    }));
  }
}
