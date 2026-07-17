export const EVIDENCE_SOURCE_TYPES = [
  "intake",
  "upload",
  "storefront",
  "web_research",
] as const;

export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const EVIDENCE_SOURCE_ROLES = [
  "fact_candidate",
  "research_hint",
] as const;

export type EvidenceSourceRole = (typeof EVIDENCE_SOURCE_ROLES)[number];

export interface EvidenceTextSelectorV2 {
  /** Unicode code-point offset into the frozen source snapshot. */
  start: number;
  /** Exclusive Unicode code-point offset into the frozen source snapshot. */
  end: number;
  prefix?: string;
  suffix?: string;
}

/**
 * Evidence 2.0 fact-level provenance. This internal contract alone does not
 * make a fact publishable and does not replace Claim review state.
 */
export interface EvidenceRefV2 {
  version: 2;
  evidenceRefId: string;
  sourceId: string;
  sourceType: EvidenceSourceType;
  sourceRole: EvidenceSourceRole;
  hashAlgorithm: "sha256";
  contentHash: string;
  quote: string;
  selector: EvidenceTextSelectorV2;
  assetId?: string;
  url?: string;
  fetchedAt?: string;
}
