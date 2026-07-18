import type { EvidenceFactItem, GapItem } from "./agents/brand-profile";
import { isCertificationClaim } from "./claim-classification";
import {
  isPublishableCertificationAsset,
  type ClaimEvidenceAsset,
} from "./claim-evidence-bridge.service";

interface CertificationAssetReader {
  /** The production repository takes a PostgreSQL row lock before returning. */
  getAsset(assetId: string): Promise<ClaimEvidenceAsset | null>;
}

const HINT_VALUE_MAX = 120;
function boundedValue(value: string): string {
  return value.length > HINT_VALUE_MAX
    ? `${value.slice(0, HINT_VALUE_MAX)}…`
    : value;
}

/**
 * Last storage-side gate. It runs inside the same transaction that appends the
 * BrandProfile, EvidenceRef and Claim bridge, so Asset deletion cannot race a
 * certification fact into durable state.
 */
export async function gateCertificationFactsForPersistence(
  assets: CertificationAssetReader,
  input: {
    workspaceId: string;
    siteId: string;
    facts: readonly EvidenceFactItem[];
  },
): Promise<{ factSheet: EvidenceFactItem[]; gaps: GapItem[] }> {
  const factSheet: EvidenceFactItem[] = [];
  const gaps: GapItem[] = [];
  const certificationFacts = input.facts.filter((fact) =>
    isCertificationClaim({ key: fact.key, value: fact.value }),
  );
  const assetIds = [
    ...new Set(
      certificationFacts.flatMap((fact) =>
        fact.evidence.assetId ? [fact.evidence.assetId] : [],
      ),
    ),
  ].sort();
  const lockedAssets = new Map<string, ClaimEvidenceAsset | null>();
  for (const assetId of assetIds) {
    lockedAssets.set(assetId, await assets.getAsset(assetId));
  }

  for (const fact of input.facts) {
    if (!isCertificationClaim({ key: fact.key, value: fact.value })) {
      factSheet.push(fact);
      continue;
    }
    const asset = fact.evidence.assetId
      ? (lockedAssets.get(fact.evidence.assetId) ?? null)
      : null;
    if (
      !isPublishableCertificationAsset(asset, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
      })
    ) {
      gaps.push({
        field: fact.key,
        reason: "unverified_certification",
        hint: `「${boundedValue(fact.value)}」缺少同站点、ready 的 cert Asset；已降级为待补资料，不创建 Claim`,
      });
      continue;
    }
    factSheet.push(fact);
  }
  return { factSheet, gaps };
}
