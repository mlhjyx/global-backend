/** Manufacturer relationship business projection. Transport producers remain crawl4ai-fetch/v1 and searxng-search/v1. */
export const MANUFACTURER_NETWORK_EVIDENCE_SCHEMA =
  "manufacturer-network-evidence/v1" as const;

export interface ManufacturerNetworkEvidence {
  schemaVersion: "manufacturer-network-evidence/v1";
  workspaceId: string;
  companyId: string;
  publisherId: string;
  targetDomain: string;
  targetName: string;
  country: "DE";
  sourceUrl: string;
  fetchedAt: string;
  expiresAt: string;
  relationship: "authorized_distributor";
  spans: string[];
  artifactId: string;
  operationId: string;
  resultDigest: string;
  contentHash: string;
  sourcePolicyId: string;
  licenseLabel: string;
  allowedActions: ["display", "match"];
  sourceReviewRef: string;
  independenceReviewRef: string;
}
