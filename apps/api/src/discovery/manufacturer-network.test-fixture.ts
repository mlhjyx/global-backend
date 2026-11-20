import type { ManufacturerNetworkEvidence } from "./manufacturer-network-evidence";
import type {
  ManufacturerNetworkSources,
  ManufacturerSourcePolicy,
} from "./manufacturer-network-sources";
export const WS = "11111111-1111-4111-8111-111111111111";
export const COMPANY = "22222222-2222-4222-8222-222222222222";
export const AUTHORITY = "33333333-3333-4333-8333-333333333333";
export const ACCOUNT = "44444444-4444-4444-8444-444444444444";
export const ARTIFACT = "55555555-5555-4555-8555-555555555555";
export const FETCH = "66666666-6666-4666-8666-666666666666";
export const SEARCH = "77777777-7777-4777-8777-777777777777";
export const POLICY = "88888888-8888-4888-8888-888888888888";
export const RUN = "99999999-9999-4999-8999-999999999999";
export const NOW = new Date("2026-11-20T10:00:00.000Z");
export const PAGE_URL =
  "https://manufacturer.example/en/locations/europe/de/acme";
export const SPAN =
  "Acme Pumps GmbH is an authorized AESSEAL distributor for industrial customers.";
export const COMPANY_INPUT = {
  id: COMPANY,
  name: "Acme Pumps GmbH",
  domain: "acme.example",
  country: "DE",
  industry: "pumps",
  attributes: {
    website_profile: { trade_role: "distributor", own_manufacturing: false },
  },
};
export const CONFIG: ManufacturerNetworkSources = {
  schemaVersion: "manufacturer-network-sources/v1",
  sources: [
    {
      publisherId: "manufacturer",
      legalName: "Manufacturer Ltd",
      domain: "manufacturer.example",
      knownCorporateDomains: ["manufacturer.example"],
      detailPathPrefixes: ["/en/locations/europe/de"],
      templateId: "aesseal-distributor/v1",
      allowedPurposes: ["enrichment"],
      allowedActions: ["display", "match"],
      licenseLabel: "Reviewed source-specific terms",
      reviewRef: "review:source",
      reviewedAt: "2026-11-19T00:00:00.000Z",
      expiresAt: "2026-12-19T00:00:00.000Z",
    },
  ],
  independenceAttestations: [
    {
      workspaceId: WS,
      companyId: COMPANY,
      targetDomain: "acme.example",
      publisherId: "manufacturer",
      independenceBasisRefs: ["audit:corporate-control"],
      actor: "agent",
      reviewRef: "review:independence",
      reviewedAt: "2026-11-19T00:00:00.000Z",
      expiresAt: "2026-12-19T00:00:00.000Z",
    },
  ],
};
export const POLICY_ROW: ManufacturerSourcePolicy = {
  id: POLICY,
  domain: "manufacturer.example",
  sourceType: "official_website",
  reviewStatus: "APPROVED",
  termsStatus: "REVIEWED_OK",
  allowedPurpose: ["enrichment"],
  allowedPaths: ["/en/locations/europe/de"],
  disallowedPaths: null,
  retentionDays: 30,
};
export const TEXT = `# Acme Pumps GmbH\n\nCountry: Germany\n\n[Website](https://acme.example/)\n\n${SPAN}`;
export const EVIDENCE: ManufacturerNetworkEvidence = {
  schemaVersion: "manufacturer-network-evidence/v1",
  workspaceId: WS,
  companyId: COMPANY,
  publisherId: "manufacturer",
  targetDomain: "acme.example",
  targetName: "Acme Pumps GmbH",
  country: "DE",
  sourceUrl: PAGE_URL,
  fetchedAt: NOW.toISOString(),
  expiresAt: "2026-11-21T10:00:00.000Z",
  relationship: "authorized_distributor",
  spans: [SPAN],
  artifactId: ARTIFACT,
  operationId: FETCH,
  resultDigest: "a".repeat(64),
  contentHash: "b".repeat(24),
  sourcePolicyId: POLICY,
  licenseLabel: "Reviewed source-specific terms",
  allowedActions: ["display", "match"],
  sourceReviewRef: "review:source",
  independenceReviewRef: "review:independence",
};
