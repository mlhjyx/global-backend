type JsonRecord = Record<string, unknown>;

import { worldBankBusinessEvidenceMatches } from "../src/discovery/providers/world-bank-keyword-match";
import { isValidCnpjIdentifier } from "../src/discovery/organization-identity-v2";

export const SUPPORTED_PERSISTENT_ACQUISITION_CANARIES = [
  "world_bank",
  "france",
  "usaspending",
  "nppes",
  "ror",
  "sec_edgar",
  "mexico_denue",
  "wikidata",
  "uk_fts",
  "uk_contracts_finder",
  "brazil_pncp",
  "singapore_gebiz",
  "eu_ecolabel",
] as const;

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function providerQualityRows(
  rows: readonly unknown[],
  providerKey: string,
): unknown[] {
  return rows.filter((row) => object(row).providerKey === providerKey);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function boundedCanaryDiagnostic(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= 2_000) return normalized;
  return `${normalized.slice(0, 400)} ...[diagnostic truncated]... ${normalized.slice(-1_550)}`;
}

export function readRorCanaryEvidence(payload: unknown) {
  const record = object(payload);
  const ror = object(object(record.attributes).ror);
  return {
    name: text(record.name),
    country: text(record.country),
    topLevelDomain: text(record.domain),
    rorId: text(ror.ror_id),
    status: text(ror.status),
    organizationTypes: Array.isArray(ror.organization_types)
      ? ror.organization_types
          .map(text)
          .filter((value): value is string => Boolean(value))
      : [],
    reportedDomainCandidates: Array.isArray(ror.reported_domain_candidates)
      ? ror.reported_domain_candidates
          .map(text)
          .filter((value): value is string => Boolean(value))
      : [],
    domainIdentityStatus: text(ror.domain_identity_status),
    identifiers: Array.isArray(record.identifiers) ? record.identifiers : [],
  };
}

export function readSecEdgarCanaryEvidence(payload: unknown) {
  const record = object(payload);
  const sec = object(object(record.attributes).sec_edgar);
  return {
    name: text(record.name),
    country: text(record.country),
    topLevelDomain: text(record.domain),
    cik: text(sec.cik),
    ticker: text(sec.ticker),
    exchange: text(sec.exchange),
    identityScope: text(sec.identity_scope),
    disclaimer: text(sec.disclaimer),
    identifiers: Array.isArray(record.identifiers) ? record.identifiers : [],
  };
}

export function readMexicoDenueCanaryEvidence(payload: unknown) {
  const record = object(payload);
  const denue = object(object(record.attributes).mexico_denue);
  return {
    externalId: text(record.externalId),
    name: text(record.name),
    country: text(record.country),
    topLevelDomain: text(record.domain),
    identifiers: Array.isArray(record.identifiers) ? record.identifiers : [],
    clee: text(denue.clee),
    denueId: text(denue.denue_id),
    tradeName: text(denue.trade_name),
    legalName: text(denue.legal_name),
    reportedWebsiteCandidate: text(denue.reported_website_candidate),
    identityStatus: text(denue.identity_status),
  };
}

export function readEuEcolabelCanaryEvidence(payload: unknown) {
  const record = object(payload);
  const ecolabel = object(object(record.attributes).eu_ecolabel);
  return {
    externalId: text(record.externalId),
    name: text(record.name),
    country: text(record.country),
    topLevelDomain: text(record.domain),
    identifiers: Array.isArray(record.identifiers) ? record.identifiers : [],
    licenceNumber: text(ecolabel.licence_number),
    itemId: text(ecolabel.item_id),
    productName: text(ecolabel.product_name),
    certificationScope: text(ecolabel.certification_scope),
    rightsNotice: text(ecolabel.rights_notice),
  };
}

export async function runCanaryCleanup(steps: {
  restoreProvider: () => Promise<void>;
  finalizeRun: () => Promise<void>;
  releaseToggleLock: () => Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [
    steps.restoreProvider,
    steps.finalizeRun,
    steps.releaseToggleLock,
  ]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      failures
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; "),
    );
  }
}

export type AcquisitionReplayCountSnapshot = {
  canonicalCompanies: number;
  leads: number;
  fieldEvidence: number;
  authorityIdentifiers: number;
  identityLinks: number;
};

type AcquisitionReplayInput = {
  honestTerminal: boolean;
  providerKey: string;
  acceptedRawIds: readonly string[];
  resolvedLinks: readonly { rawRecordId: string; rootCompanyId: string }[];
  baselineRootCompanyIds: readonly string[];
  beforeCounts: AcquisitionReplayCountSnapshot;
  afterCounts: AcquisitionReplayCountSnapshot;
  identityQuality: unknown;
};

function identityQualityCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

/**
 * Produce auditable facts for reprocessing the same accepted Raw rows through
 * canonicalization. This is deliberately not a second provider fetch: a new
 * run creates new Raw observations and therefore is not an identity replay.
 */
export function acquisitionReplayEvidence(input: AcquisitionReplayInput) {
  const acceptedRawIds = new Set(input.acceptedRawIds);
  const baselineRoots = new Set(input.baselineRootCompanyIds);
  const linksByRaw = new Map<string, string[]>();
  for (const link of input.resolvedLinks) {
    const roots = linksByRaw.get(link.rawRecordId) ?? [];
    roots.push(link.rootCompanyId);
    linksByRaw.set(link.rawRecordId, roots);
  }
  const acceptedRawResolvedToBaselineRoots =
    acceptedRawIds.size > 0 &&
    acceptedRawIds.size === input.acceptedRawIds.length &&
    [...acceptedRawIds].every((rawRecordId) => {
      const roots = linksByRaw.get(rawRecordId) ?? [];
      return roots.length === 1 && baselineRoots.has(roots[0]!);
    });
  const addedCounts: AcquisitionReplayCountSnapshot = {
    canonicalCompanies:
      input.afterCounts.canonicalCompanies -
      input.beforeCounts.canonicalCompanies,
    leads: input.afterCounts.leads - input.beforeCounts.leads,
    fieldEvidence:
      input.afterCounts.fieldEvidence - input.beforeCounts.fieldEvidence,
    authorityIdentifiers:
      input.afterCounts.authorityIdentifiers -
      input.beforeCounts.authorityIdentifiers,
    identityLinks:
      input.afterCounts.identityLinks - input.beforeCounts.identityLinks,
  };
  const noEntityGrowth = Object.values(addedCounts).every(
    (count) => count === 0,
  );
  const providerQuality = object(input.identityQuality)[input.providerKey];
  const quality = object(providerQuality);
  const identityQuality = {
    acceptedRows: identityQualityCount(quality.acceptedRows),
    boundRows: identityQualityCount(quality.boundRows),
    conflictRows: identityQualityCount(quality.conflictRows),
    suppressedRows: identityQualityCount(quality.suppressedRows),
    replayedRows: identityQualityCount(quality.replayedRows),
  };
  const identityQualityAccurate =
    identityQuality.acceptedRows === acceptedRawIds.size &&
    identityQuality.boundRows === acceptedRawIds.size &&
    identityQuality.conflictRows === 0 &&
    identityQuality.suppressedRows === 0 &&
    identityQuality.replayedRows === acceptedRawIds.size;
  return {
    honestTerminal: input.honestTerminal,
    acceptedRawCount: acceptedRawIds.size,
    baselineRootCompanyCount: baselineRoots.size,
    acceptedRawResolvedToBaselineRoots,
    beforeCounts: input.beforeCounts,
    afterCounts: input.afterCounts,
    addedCounts,
    noEntityGrowth,
    identityQuality,
    identityQualityAccurate,
    proved:
      input.honestTerminal &&
      acceptedRawResolvedToBaselineRoots &&
      noEntityGrowth &&
      identityQualityAccurate,
  };
}

export function canaryTextOverride(
  value: string | undefined,
  fallback: string,
): string {
  return value?.trim() || fallback;
}

export function canaryKeywordOverride(
  env: Record<string, string | undefined>,
  fallback: string,
): string {
  return canaryTextOverride(
    env.ACQUISITION_CANARY_KEYWORD ?? env.KEYWORD,
    fallback,
  );
}

export function contractsFinderCanaryOverrides(
  env: Record<string, string | undefined>,
) {
  return {
    region: canaryTextOverride(env.ACQUISITION_CANARY_REGION, "England"),
    keyword: canaryKeywordOverride(env, "maintenance"),
  };
}

export type ContractsFinderCanaryExpectation = "nonzero" | "zero";

export function contractsFinderCanaryExpectation(
  value: string | undefined,
): ContractsFinderCanaryExpectation {
  const normalized = value?.trim().toLocaleLowerCase("en-US") || "nonzero";
  if (normalized === "nonzero" || normalized === "zero") return normalized;
  throw new Error("ACQUISITION_CANARY_EXPECT must be nonzero or zero");
}

export type ContractsFinderMatrixCase = {
  id: string;
  region: "Wales" | "England" | "Northern Ireland";
  keyword: string;
  expect: ContractsFinderCanaryExpectation;
  claim: "current_buyer_sample" | "zero_result_control";
};

export function contractsFinderCanaryMatrix(): ContractsFinderMatrixCase[] {
  return [
    {
      id: "wales-maintenance-current-buyer",
      region: "Wales",
      keyword: "maintenance",
      expect: "nonzero",
      claim: "current_buyer_sample",
    },
    {
      id: "england-construction-current-buyer",
      region: "England",
      keyword: "construction",
      expect: "nonzero",
      claim: "current_buyer_sample",
    },
    {
      id: "northern-ireland-barrier-current-buyer",
      region: "Northern Ireland",
      keyword: "automated height restriction barrier",
      expect: "nonzero",
      claim: "current_buyer_sample",
    },
    {
      id: "wales-deterministic-zero-control",
      region: "Wales",
      keyword: "codex-canary-no-match-9f4c6b30",
      expect: "zero",
      claim: "zero_result_control",
    },
  ];
}

export function contractsFinderPaginationEvidence(
  sourceUrls: readonly unknown[],
  runStats: unknown,
) {
  const acceptedFromContinuation = sourceUrls.some((value) => {
    if (typeof value !== "string") return false;
    try {
      return new URL(value).searchParams.has("cursor");
    } catch {
      return false;
    }
  });
  const stats = object(runStats);
  const perSource = object(stats.perSource);
  const publicIntelligence = object(perSource.public_intelligence);
  const maxPagesExhausted = publicIntelligence.paginationTruncated === true;
  return {
    acceptedFromContinuation,
    maxPagesExhausted,
    proved: acceptedFromContinuation || maxPagesExhausted,
  };
}

export function contractsFinderMatrixHasPaginationProof(
  results: readonly unknown[],
): boolean {
  return results.some((value) => {
    const result = object(value);
    if (result.status !== "PASS") return false;
    const evidence = object(result.evidence);
    const pagination = object(evidence.paginationEvidence);
    return pagination.proved === true;
  });
}

export function contractsFinderMatrixVerdict(
  results: readonly unknown[],
  expectedCases: number,
) {
  const allCasesPassed =
    results.length === expectedCases &&
    results.every((value) => object(value).status === "PASS");
  const paginationProved = contractsFinderMatrixHasPaginationProof(results);
  return {
    allCasesPassed,
    paginationProved,
    verdict:
      allCasesPassed && paginationProved
        ? ("PASS" as const)
        : ("FAIL" as const),
  };
}

export type UsaSpendingCanaryExpectation = "nonzero" | "zero";

export type UsaSpendingMatrixCase = {
  id: string;
  keyword: string;
  sinceDays: number;
  limit: number;
  expect: UsaSpendingCanaryExpectation;
  claim: "historical_federal_buyer_sample" | "zero_result_control";
};

const DEFAULT_USASPENDING_MATRIX: readonly UsaSpendingMatrixCase[] = [
  {
    id: "construction-page-two-historical-buyers",
    keyword: "construction",
    sinceDays: 730,
    limit: 6,
    expect: "nonzero",
    claim: "historical_federal_buyer_sample",
  },
  {
    id: "maintenance-historical-buyer",
    keyword: "maintenance",
    sinceDays: 730,
    limit: 1,
    expect: "nonzero",
    claim: "historical_federal_buyer_sample",
  },
  {
    id: "usaspending-deterministic-zero-control",
    keyword: "codex-canary-no-match-usaspending-9f4c6b30",
    sinceDays: 730,
    limit: 1,
    expect: "zero",
    claim: "zero_result_control",
  },
];

export function usaSpendingCanaryExpectation(
  value: string | undefined,
): UsaSpendingCanaryExpectation {
  const normalized = value?.trim().toLocaleLowerCase("en-US") || "nonzero";
  if (normalized === "nonzero" || normalized === "zero") return normalized;
  throw new Error("ACQUISITION_CANARY_EXPECT must be nonzero or zero");
}

export function usaSpendingCanaryOverrides(
  env: Record<string, string | undefined>,
) {
  return {
    keyword: canaryKeywordOverride(env, "construction"),
    sinceDays: boundedUsaSpendingInteger(
      env.ACQUISITION_CANARY_SINCE_DAYS,
      730,
      1,
      3_650,
      "since days",
    ),
    limit: boundedUsaSpendingInteger(
      env.ACQUISITION_CANARY_LIMIT,
      6,
      1,
      25,
      "business limit",
    ),
  };
}

export function usaSpendingCanaryMatrix(
  env: Record<string, string | undefined>,
): UsaSpendingMatrixCase[] {
  const configured = env.ACQUISITION_USASPENDING_MATRIX_CASES?.trim();
  let source: unknown = DEFAULT_USASPENDING_MATRIX;
  if (configured) {
    try {
      source = JSON.parse(configured);
    } catch {
      throw new Error(
        "ACQUISITION_USASPENDING_MATRIX_CASES must be valid JSON",
      );
    }
  }
  if (!Array.isArray(source) || source.length < 3 || source.length > 8) {
    throw new Error("USAspending matrix must contain between 3 and 8 cases");
  }
  const cases = source.map((value, index): UsaSpendingMatrixCase => {
    const row = object(value);
    const id = boundedUsaSpendingText(row.id, `case ${index + 1} id`, 64);
    const keyword = boundedUsaSpendingText(
      row.keyword,
      `case ${index + 1} keyword`,
      160,
    );
    const sinceDays = boundedUsaSpendingInteger(
      row.sinceDays,
      730,
      1,
      3_650,
      "since days",
    );
    const limit = boundedUsaSpendingInteger(
      row.limit,
      1,
      1,
      25,
      "business limit",
    );
    const expect = usaSpendingCanaryExpectation(text(row.expect));
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(
        `USAspending matrix case id must be lower-kebab-case: ${id}`,
      );
    }
    return {
      id,
      keyword,
      sinceDays,
      limit,
      expect,
      claim:
        expect === "zero"
          ? "zero_result_control"
          : "historical_federal_buyer_sample",
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("USAspending matrix case ids must be unique");
  }
  const positives = cases.filter((item) => item.expect === "nonzero");
  const zeros = cases.filter((item) => item.expect === "zero");
  if (
    positives.length < 2 ||
    new Set(positives.map((item) => item.keyword.toLocaleLowerCase("en-US")))
      .size < 2
  ) {
    throw new Error(
      "USAspending matrix requires at least two distinct positive keywords",
    );
  }
  if (!positives.some((item) => item.limit > 1)) {
    throw new Error(
      "USAspending matrix requires one positive case capable of proving continuation",
    );
  }
  if (
    zeros.length !== 1 ||
    !/^codex-canary-no-match-usaspending-[a-f0-9]{8,64}$/u.test(
      zeros[0]?.keyword.toLocaleLowerCase("en-US") ?? "",
    )
  ) {
    throw new Error(
      "USAspending matrix requires exactly one deterministic zero control",
    );
  }
  return cases;
}

function boundedUsaSpendingText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  const normalized = text(value);
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (!normalized || normalized.length > maximumLength || hasControlCharacter) {
    throw new Error(
      `USAspending matrix ${label} must be 1-${maximumLength} printable characters`,
    );
  }
  return normalized;
}

function boundedUsaSpendingInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim();
  if (!/^\d{1,4}$/u.test(normalized)) {
    throw new Error(
      `USAspending ${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `USAspending ${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

export function readUsaSpendingCanaryEvidence(
  payload: unknown,
  keywords: readonly string[],
) {
  const record = object(payload);
  const attributes = object(record.attributes);
  const procurement = object(attributes.procurement);
  const companyName = text(record.name);
  const parentAgency = text(procurement.awarding_agency);
  const subAgency = text(procurement.awarding_sub_agency);
  const sourcePage = Number(procurement.source_page);
  const queryKeywords = Array.isArray(procurement.query_keywords)
    ? procurement.query_keywords
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  const allowedMatchBasis = new Set([
    "description",
    "awarding_agency",
    "awarding_sub_agency",
  ]);
  const matchBasis = Array.isArray(procurement.match_basis)
    ? procurement.match_basis
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  const matchBasisValid =
    matchBasis.length > 0 &&
    matchBasis.length <= allowedMatchBasis.size &&
    new Set(matchBasis).size === matchBasis.length &&
    matchBasis.every((basis) => allowedMatchBasis.has(basis));
  const queryMatch = procurement.query_match === true;
  const normalizedQueryKeywords = new Set(
    queryKeywords.map((keyword) => keyword.toLocaleLowerCase("en-US")),
  );
  const requestedKeywords = keywords
    .map((keyword) => keyword.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  const recipientRetained = Object.hasOwn(procurement, "recipient_name");
  const descriptionRetained = Object.hasOwn(procurement, "description");
  const startDate = text(procurement.start_date);
  const endDate = text(procurement.end_date);
  const queryStartDate = text(procurement.query_start_date);
  const queryEndDate = text(procurement.query_end_date);
  return {
    companyName,
    country: text(record.country),
    sourceRole: attributes.source_role,
    signalStage: attributes.signal_stage,
    awardId: text(procurement.award_id),
    parentAgency,
    subAgency,
    queryMatch,
    matchBasis,
    matchBasisValid,
    descriptionRetained,
    startDate,
    endDate,
    startDateValid: startDate ? validIsoDateOnly(startDate) : true,
    endDateValid: endDate ? validIsoDateOnly(endDate) : true,
    sourcePage: Number.isSafeInteger(sourcePage) ? sourcePage : undefined,
    queryStartDate,
    queryEndDate,
    queryStartDateValid: Boolean(
      queryStartDate && validIsoDateOnly(queryStartDate),
    ),
    queryEndDateValid: Boolean(queryEndDate && validIsoDateOnly(queryEndDate)),
    queryKeywords,
    queryFingerprint: text(procurement.query_fingerprint),
    recipientRetained,
    rawDomain: text(record.domain),
    rawIdentifier: text(record.identifier),
    rawIdentifiers: Array.isArray(record.identifiers)
      ? record.identifiers
      : undefined,
    parentSubagencyNameMatches: Boolean(
      companyName &&
      parentAgency &&
      subAgency &&
      companyName === `${parentAgency} / ${subAgency}`,
    ),
    positiveKeywordMatch:
      queryMatch &&
      matchBasisValid &&
      requestedKeywords.length > 0 &&
      requestedKeywords.every((keyword) =>
        normalizedQueryKeywords.has(keyword),
      ) &&
      !descriptionRetained &&
      !recipientRetained,
  };
}

function validIsoDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function usaSpendingPositiveQualityCanPass(
  rows: readonly unknown[],
  acceptedRawCount: number,
): boolean {
  return worldBankPositiveQualityCanPass(
    rows,
    "usaspending_awards",
    acceptedRawCount,
  );
}

export function usaSpendingPaginationEvidence(rows: readonly unknown[]) {
  const evidence = rows.map(object);
  const acceptedPageOne = evidence.some((row) => row.sourcePage === 1);
  const acceptedPageTwo = evidence.some(
    (row) => Number.isSafeInteger(row.sourcePage) && Number(row.sourcePage) > 1,
  );
  const fingerprints = new Set(
    evidence.map((row) => text(row.queryFingerprint)).filter(Boolean),
  );
  const frozenQueryFingerprint = evidence.length > 0 && fingerprints.size === 1;
  return {
    acceptedPageOne,
    acceptedPageTwo,
    frozenQueryFingerprint,
    proved: acceptedPageOne && acceptedPageTwo && frozenQueryFingerprint,
  };
}

export function usaSpendingMatrixVerdict(
  results: readonly unknown[],
  expectedCases: number,
) {
  const allCasesPassed =
    results.length === expectedCases &&
    results.every((value) => object(value).status === "PASS");
  const paginationProved = results.some((value) => {
    const result = object(value);
    return (
      result.status === "PASS" &&
      object(object(result.evidence).paginationEvidence).proved === true
    );
  });
  const positives = results.flatMap((value) => {
    const result = object(value);
    const evidence = object(result.evidence);
    if (result.status !== "PASS" || evidence.expectation !== "nonzero")
      return [];
    const rows = Array.isArray(evidence.procurementEvidence)
      ? evidence.procurementEvidence.map(object)
      : [];
    return [
      {
        keyword: text(evidence.requestedKeyword),
        awardIds: rows
          .map((row) => text(row.awardId))
          .filter((item): item is string => Boolean(item)),
        companyNames: rows
          .map((row) => text(row.companyName))
          .filter((item): item is string => Boolean(item)),
      },
    ];
  });
  const positiveDiversityProved =
    positives.length >= 2 &&
    positives.every(
      (item) =>
        item.keyword &&
        item.awardIds.length > 0 &&
        item.companyNames.length > 0,
    ) &&
    new Set(positives.map((item) => item.keyword?.toLocaleLowerCase("en-US")))
      .size >= 2 &&
    new Set(positives.flatMap((item) => item.awardIds)).size >= 2 &&
    new Set(positives.flatMap((item) => item.companyNames)).size >= 2 &&
    positives.every((item, index) =>
      item.companyNames.some((companyName) =>
        positives.every(
          (other, otherIndex) =>
            otherIndex === index || !other.companyNames.includes(companyName),
        ),
      ),
    );
  return {
    allCasesPassed,
    paginationProved,
    positiveDiversityProved,
    verdict:
      allCasesPassed && paginationProved && positiveDiversityProved
        ? ("PASS" as const)
        : ("FAIL" as const),
  };
}

export type WorldBankCanaryExpectation = "nonzero" | "zero";

/**
 * World Bank procurement notices are research evidence. They do not prove
 * that the underlying infrastructure project or buying window is still active.
 */
export function worldBankCanaryTriggerSignals(): string[] {
  return [
    "published procurement notice research",
    "historical procurement buyer evidence",
  ];
}

export type WorldBankMatrixCase = {
  id: string;
  country: string;
  keyword: string;
  /** Business records requested from the bounded three-page run, not wire rows per page. */
  limit: number;
  expect: WorldBankCanaryExpectation;
  claim: "buyer_or_implementing_agency_sample" | "zero_result_control";
};

const DEFAULT_WORLD_BANK_MATRIX: readonly WorldBankMatrixCase[] = [
  {
    id: "kenya-water-buyer-sample",
    country: "Kenya",
    keyword: "water pump",
    // Historical evidence yields nine admitted buyers on page one and at
    // least one on a continuation page, preserving matrix pagination proof.
    limit: 10,
    expect: "nonzero",
    claim: "buyer_or_implementing_agency_sample",
  },
  {
    id: "bangladesh-solar-buyer-sample",
    country: "Bangladesh",
    keyword: "solar",
    // The bounded first page has admitted buyer evidence; one record is a
    // sufficient second-country positive without weakening DONE or ledger gates.
    limit: 1,
    expect: "nonzero",
    claim: "buyer_or_implementing_agency_sample",
  },
  {
    id: "kenya-deterministic-zero-control",
    country: "Codex-Nowhere-World-Bank-9f4c6b30",
    keyword: "codex-canary-no-match-world-bank-9f4c6b30",
    limit: 1,
    expect: "zero",
    claim: "zero_result_control",
  },
];

export function worldBankCanaryOverrides(
  env: Record<string, string | undefined>,
) {
  return {
    country: canaryTextOverride(env.ACQUISITION_CANARY_COUNTRY, "Kenya"),
    keyword: canaryKeywordOverride(env, "water pump"),
    limit: boundedWorldBankBusinessLimit(env.ACQUISITION_CANARY_LIMIT, 25),
  };
}

export function worldBankCanaryExpectation(
  value: string | undefined,
): WorldBankCanaryExpectation {
  const normalized = value?.trim().toLocaleLowerCase("en-US") || "nonzero";
  if (normalized === "nonzero" || normalized === "zero") return normalized;
  throw new Error("ACQUISITION_CANARY_EXPECT must be nonzero or zero");
}

/**
 * Live World Bank inventory changes independently of this repository. The
 * defaults are bounded discovery probes, not fixtures or a promise that those
 * notices still exist. Operators may freeze a currently observed matrix in one
 * JSON environment variable without weakening the two-country/zero controls.
 */
export function worldBankCanaryMatrix(
  env: Record<string, string | undefined>,
): WorldBankMatrixCase[] {
  const configured = env.ACQUISITION_WORLD_BANK_MATRIX_CASES?.trim();
  const source: unknown = configured
    ? parseWorldBankMatrixJson(configured)
    : DEFAULT_WORLD_BANK_MATRIX;
  if (!Array.isArray(source) || source.length < 3 || source.length > 8) {
    throw new Error("World Bank matrix must contain between 3 and 8 cases");
  }

  const cases = source.map((value, index): WorldBankMatrixCase => {
    const row = object(value);
    const id = boundedMatrixText(row.id, `case ${index + 1} id`, 64);
    const country = boundedMatrixText(
      row.country,
      `case ${index + 1} country`,
      80,
    );
    const keyword = boundedMatrixText(
      row.keyword,
      `case ${index + 1} keyword`,
      160,
    );
    const limit = boundedWorldBankBusinessLimit(row.limit, 1);
    const expect = worldBankCanaryExpectation(text(row.expect));
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(
        `World Bank matrix case id must be lower-kebab-case: ${id}`,
      );
    }
    return {
      id,
      country,
      keyword,
      limit,
      expect,
      claim:
        expect === "zero"
          ? "zero_result_control"
          : "buyer_or_implementing_agency_sample",
    };
  });

  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("World Bank matrix case ids must be unique");
  }
  const positives = cases.filter((item) => item.expect === "nonzero");
  const zeroControls = cases.filter((item) => item.expect === "zero");
  if (positives.length < 2)
    throw new Error("World Bank matrix requires at least two positive cases");
  if (
    new Set(positives.map((item) => item.country.toLocaleLowerCase("en-US")))
      .size < 2
  ) {
    throw new Error(
      "World Bank positive cases must cover at least two distinct countries",
    );
  }
  if (
    new Set(positives.map((item) => item.keyword.toLocaleLowerCase("en-US")))
      .size < 2
  ) {
    throw new Error(
      "World Bank positive cases must use at least two distinct keywords",
    );
  }
  if (
    zeroControls.length !== 1 ||
    !zeroControls[0]?.keyword
      .toLocaleLowerCase("en-US")
      .startsWith("codex-canary-no-match-") ||
    !zeroControls[0]?.country
      .toLocaleLowerCase("en-US")
      .startsWith("codex-nowhere-")
  ) {
    throw new Error(
      "World Bank matrix requires exactly one deterministic zero control",
    );
  }
  return cases;
}

function boundedWorldBankBusinessLimit(
  value: unknown,
  fallback: number,
): number {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim();
  if (!/^\d{1,2}$/u.test(normalized)) {
    throw new Error(
      "World Bank business limit must be an integer between 1 and 25",
    );
  }
  const limit = Number(normalized);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error(
      "World Bank business limit must be an integer between 1 and 25",
    );
  }
  return limit;
}

function parseWorldBankMatrixJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("ACQUISITION_WORLD_BANK_MATRIX_CASES must be valid JSON");
  }
}

function boundedMatrixText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  const normalized = text(value);
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (!normalized || normalized.length > maximumLength || hasControlCharacter) {
    throw new Error(
      `World Bank matrix ${label} must be 1-${maximumLength} printable characters`,
    );
  }
  return normalized;
}

export function readWorldBankCanaryEvidence(
  payload: unknown,
  keywords: readonly string[],
) {
  const record = object(payload);
  const attributes = object(record.attributes);
  const procurement = object(attributes.procurement);
  const companyName = text(record.name);
  const title = text(procurement.title);
  const projectName = text(procurement.project_name);
  const projectCountry = text(procurement.project_country);
  return {
    companyName,
    country: text(record.country),
    sourceRole: attributes.source_role,
    signalStage: attributes.signal_stage,
    noticeId: text(procurement.notice_id),
    title,
    projectId: text(procurement.project_id),
    projectName,
    projectCountry,
    method: text(procurement.method),
    deadline: text(procurement.deadline),
    positiveKeywordMatch: worldBankBusinessEvidenceMatches(
      {
        organizationName: companyName,
        title,
        projectName,
      },
      keywords,
    ),
    projectNameWasPromoted: Boolean(
      companyName && projectName && companyName === projectName,
    ),
  };
}

function publicIntelligenceStats(runStats: unknown): JsonRecord {
  return object(object(object(runStats).perSource).public_intelligence);
}

export function worldBankPaginationEvidence(
  sourceUrls: readonly unknown[],
  runStats: unknown,
) {
  const acceptedContinuation = sourceUrls.some((value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      const offset = Number(url.searchParams.get("os"));
      return (
        url.protocol === "https:" &&
        url.hostname === "search.worldbank.org" &&
        url.pathname === "/api/v2/procnotices" &&
        Number.isInteger(offset) &&
        offset > 0
      );
    } catch {
      return false;
    }
  });
  const paginationTruncated =
    publicIntelligenceStats(runStats).paginationTruncated === true;
  return {
    acceptedContinuation,
    paginationTruncated,
    // A truncation flag proves only that a bound was hit. It does not prove
    // that an official continuation page produced accepted business records.
    proved: acceptedContinuation,
  };
}

export function worldBankRunStatusIsTruthful(
  status: unknown,
  runStats: unknown,
): boolean {
  const truncated =
    publicIntelligenceStats(runStats).paginationTruncated === true;
  return (
    !truncated ||
    (status === "PARTIAL" && object(runStats).dataQualityBlocked === true)
  );
}

export function worldBankPositiveRunCanPass(
  status: unknown,
  runStats: unknown,
): boolean {
  return status === "DONE" && worldBankRunStatusIsTruthful(status, runStats);
}

export function worldBankPositiveQualityCanPass(
  rows: readonly unknown[],
  providerKey: string,
  acceptedRawCount: number,
): boolean {
  if (
    rows.length !== 1 ||
    !Number.isInteger(acceptedRawCount) ||
    acceptedRawCount <= 0
  )
    return false;
  const row = object(rows[0]);
  return (
    row.providerKey === providerKey &&
    row.terminalStatus === "DONE" &&
    row.attemptedCount === 1 &&
    row.successCount === 1 &&
    row.zeroResultCount === 0 &&
    row.failureCount === 0 &&
    row.rawCount === acceptedRawCount &&
    row.acceptedCount === acceptedRawCount &&
    row.boundCount === acceptedRawCount &&
    (row.conflictCount ?? 0) === 0
  );
}

export function secEdgarQualityCanPass(rows: readonly unknown[]): boolean {
  const expectedKeys = new Set([
    "sec_edgar",
    "gleif",
    "wikidata",
    "digital_footprint",
  ]);
  if (rows.length !== expectedKeys.size) return false;
  const byKey = new Map(
    rows.map((value) => {
      const row = object(value);
      return [row.providerKey, row] as const;
    }),
  );
  if (
    byKey.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !byKey.has(key))
  )
    return false;
  const sec = byKey.get("sec_edgar")!;
  if (!(
    sec.terminalStatus === "DONE" &&
    sec.attemptedCount === 2 &&
    sec.successCount === 2 &&
    sec.zeroResultCount === 0 &&
    sec.failureCount === 0 &&
    sec.failedRunCount === 0 &&
    sec.processedCount === 2 &&
    sec.rawCount === 2 &&
    sec.acceptedCount === 2 &&
    sec.boundCount === 2 &&
    sec.domainCount === 0 &&
    sec.authorityCount === 2 &&
    (sec.conflictCount ?? 0) === 0 &&
    sec.duplicateCount === 0
  ))
    return false;
  return [...expectedKeys]
    .filter((key) => key !== "sec_edgar")
    .every((key) => {
      const row = byKey.get(key)!;
      return (
        row.terminalStatus === "DONE" &&
        row.attemptedCount === 1 &&
        row.successCount === 1 &&
        row.zeroResultCount === 1 &&
        row.failureCount === 0 &&
        row.failedRunCount === 0 &&
        row.processedCount === 0 &&
        row.rawCount === 0 &&
        (row.acceptedCount ?? 0) === 0 &&
        (row.boundCount ?? 0) === 0 &&
        (row.domainCount ?? 0) === 0 &&
        (row.authorityCount ?? 0) === 0 &&
        (row.conflictCount ?? 0) === 0 &&
        row.duplicateCount === 0
      );
    });
}

export function zeroResultQualityCanPass(
  rows: readonly unknown[],
  providerKey: string,
): boolean {
  if (rows.length !== 1) return false;
  const row = object(rows[0]);
  return (
    row.providerKey === providerKey &&
    row.terminalStatus === "DONE" &&
    row.attemptedCount === 1 &&
    row.successCount === 1 &&
    row.zeroResultCount === 1 &&
    row.failureCount === 0 &&
    row.rawCount === 0 &&
    (row.acceptedCount ?? 0) === 0 &&
    (row.boundCount ?? 0) === 0 &&
    (row.conflictCount ?? 0) === 0
  );
}

export function worldBankMatrixVerdict(
  results: readonly unknown[],
  expectedCases: number,
) {
  const allCasesPassed =
    results.length === expectedCases &&
    results.every((value) => object(value).status === "PASS");
  const paginationProved = results.some((value) => {
    const result = object(value);
    const evidence = object(result.evidence);
    return (
      result.status === "PASS" &&
      object(evidence.paginationEvidence).proved === true
    );
  });
  const positiveEvidence = results.flatMap((value) => {
    const result = object(value);
    const evidence = object(result.evidence);
    if (result.status !== "PASS" || evidence.expectation !== "nonzero")
      return [];
    const procurementEvidence = Array.isArray(evidence.procurementEvidence)
      ? evidence.procurementEvidence.map(object)
      : [];
    return [
      {
        country: text(evidence.requestedCountry),
        keyword: text(evidence.requestedKeyword),
        noticeIds: procurementEvidence
          .map((item) => text(item.noticeId))
          .filter((item): item is string => Boolean(item)),
      },
    ];
  });
  const positiveDiversityProved =
    positiveEvidence.length >= 2 &&
    positiveEvidence.every(
      (item) => item.country && item.keyword && item.noticeIds.length > 0,
    ) &&
    new Set(
      positiveEvidence.map((item) => item.country?.toLocaleLowerCase("en-US")),
    ).size >= 2 &&
    new Set(
      positiveEvidence.map((item) => item.keyword?.toLocaleLowerCase("en-US")),
    ).size >= 2 &&
    new Set(positiveEvidence.flatMap((item) => item.noticeIds)).size >= 2;
  return {
    allCasesPassed,
    paginationProved,
    positiveDiversityProved,
    verdict:
      allCasesPassed && paginationProved && positiveDiversityProved
        ? ("PASS" as const)
        : ("FAIL" as const),
  };
}

export function readUkProcurementCanaryEvidence(
  payload: unknown,
  keywords: readonly string[],
  observedAt?: Date,
) {
  const record = object(payload);
  const attributes = object(record.attributes);
  const procurement = object(attributes.procurement);
  const companyName = text(record.name);
  const title = text(procurement.title);
  const deadline = text(procurement.deadline);
  const deadlineAt = deadline ? Date.parse(deadline) : Number.NaN;
  const searchableBusinessFacts =
    `${companyName ?? ""} ${title ?? ""}`.toLocaleLowerCase("en-US");

  return {
    companyName,
    country: text(record.country),
    region: text(record.region),
    title,
    positiveKeywordMatch: keywords.some((keyword) => {
      const normalized = keyword.trim().toLocaleLowerCase("en-US");
      return (
        Boolean(normalized) && searchableBusinessFacts.includes(normalized)
      );
    }),
    sourceRole: attributes.source_role,
    signalStage: attributes.signal_stage,
    status: procurement.status,
    noticeUrl: procurement.notice_url,
    deadline,
    deadlineIsCurrent: observedAt
      ? Number.isFinite(deadlineAt) && deadlineAt > observedAt.getTime()
      : undefined,
    cpvCodes: procurement.cpv_codes,
  };
}

export function matchesContractsFinderLocation(
  company: { country: string | null; region: string | null },
  targetRegion: string,
): boolean {
  return (
    company.country === "United Kingdom" && company.region === targetRegion
  );
}

export function readBrazilPncpCanaryEvidence(
  payload: unknown,
  keyword: string,
  observedAt: Date,
) {
  const record = object(payload);
  const attributes = object(record.attributes);
  const procurement = object(attributes.procurement);
  const matchedQueryTerms = Array.isArray(procurement.matched_query_terms)
    ? procurement.matched_query_terms
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  const deadline = text(procurement.deadline);
  const normalizedKeyword = keyword
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("pt-BR");
  const title = text(procurement.title);
  const normalizedTitle =
    title?.normalize("NFKC").toLocaleLowerCase("pt-BR") ?? "";
  const queryKeywords = Array.isArray(procurement.query_keywords)
    ? procurement.query_keywords
        .map(text)
        .filter((value): value is string => Boolean(value))
    : [];
  const sourcePage = Number(procurement.source_page);
  const deadlineAt = parseBrazilPncpDeadline(deadline);

  return {
    companyName: text(record.name),
    country: text(record.country),
    region: text(record.region),
    title,
    controlNumber: text(procurement.control_number),
    matchedQueryTerms,
    positiveTitleKeywordMatch:
      Boolean(normalizedKeyword) &&
      normalizedTitle.includes(normalizedKeyword) &&
      matchedQueryTerms.includes(normalizedKeyword),
    sourceRole: attributes.source_role,
    signalStage: attributes.signal_stage,
    deadline,
    deadlineAt: deadlineAt?.toISOString(),
    deadlineIsCurrent: Boolean(
      deadlineAt && deadlineAt.getTime() > observedAt.getTime(),
    ),
    cnpjClaim: text(procurement.cnpj_claim),
    cnpjIdentityStatus: procurement.cnpj_identity_status,
    sourcePage: Number.isSafeInteger(sourcePage) ? sourcePage : undefined,
    queryDateFinal: text(procurement.query_date_final),
    queryState: text(procurement.query_state),
    queryKeywords,
    queryFingerprint: text(procurement.query_fingerprint),
    rawDomain: text(record.domain),
    rawIdentifier: text(record.identifier),
    rawIdentifiers: Array.isArray(record.identifiers)
      ? record.identifiers
      : undefined,
  };
}

export function brazilPncpAuthorityEvidenceIsConsistent(
  raw: {
    rawRecordId: string;
    canonicalCompanyId?: string;
    controlNumber?: string;
    cnpjClaim?: string;
    cnpjIdentityStatus?: unknown;
    rawIdentifiers?: unknown[];
  },
  persistedIdentifiers: readonly {
    rawRecordId: string | null;
    companyId: string;
    scheme: string;
    jurisdiction: string;
    normalizedValue: string;
    authorityProviderKey: string | null;
    status: string;
    validatorVersion: string;
  }[],
  providerKey: string,
): boolean {
  const rawCnpjIdentifiers = (raw.rawIdentifiers ?? [])
    .map(object)
    .filter((identifier) => text(identifier.scheme) === "br-cnpj");
  const persistedRawCnpjIdentifiers = persistedIdentifiers.filter(
    (identifier) =>
      identifier.rawRecordId === raw.rawRecordId &&
      identifier.scheme === "br-cnpj",
  );

  if (!raw.cnpjClaim) {
    return (
      raw.cnpjIdentityStatus == null &&
      rawCnpjIdentifiers.length === 0 &&
      persistedRawCnpjIdentifiers.length === 0
    );
  }

  const matchingAuthorityIdentifiers = persistedIdentifiers.filter(
    (identifier) =>
      Boolean(raw.canonicalCompanyId) &&
      identifier.companyId === raw.canonicalCompanyId &&
      identifier.scheme === "br-cnpj" &&
      identifier.jurisdiction === "BR" &&
      identifier.normalizedValue === raw.cnpjClaim &&
      identifier.authorityProviderKey === providerKey &&
      identifier.status === "ACTIVE" &&
      identifier.validatorVersion === "cnpj-v1",
  );
  const controlPrefix = /^(\d{14})-/u.exec(
    raw.controlNumber?.normalize("NFKC") ?? "",
  )?.[1];
  return (
    isValidCnpjIdentifier(raw.cnpjClaim) &&
    controlPrefix === raw.cnpjClaim &&
    raw.cnpjIdentityStatus === "validated_authority" &&
    rawCnpjIdentifiers.length === 1 &&
    text(rawCnpjIdentifiers[0]?.jurisdiction) === "BR" &&
    text(rawCnpjIdentifiers[0]?.value) === raw.cnpjClaim &&
    matchingAuthorityIdentifiers.length === 1
  );
}

export type BrazilPncpCanaryExpectation = "nonzero" | "zero";

export type BrazilPncpMatrixCase = {
  id: string;
  keyword: string;
  state?: string;
  limit: number;
  expect: BrazilPncpCanaryExpectation;
  claim: "current_buyer_sample" | "scoped_zero_result_control";
};

export function brazilPncpMatrixCaseEvidenceIsValid(
  value: unknown,
  expected: BrazilPncpMatrixCase,
): boolean {
  const evidence = object(value);
  const counts = object(evidence.counts);
  const expectedVerdict = expected.expect === "zero" ? "CONTROL_PASS" : "PASS";
  const sourceUrls = Array.isArray(evidence.sourceUrls)
    ? evidence.sourceUrls
        .map(text)
        .filter((item): item is string => Boolean(item))
    : [];
  const procurementEvidence = Array.isArray(evidence.procurementEvidence)
    ? evidence.procurementEvidence
    : [];
  const acceptedRaw = Number(counts.acceptedRaw);
  const expectedResultShape =
    expected.expect === "zero"
      ? acceptedRaw === 0 &&
        procurementEvidence.length === 0 &&
        evidence.positiveChannelProved === false
      : Number.isSafeInteger(acceptedRaw) &&
        acceptedRaw > 0 &&
        procurementEvidence.length === acceptedRaw &&
        evidence.positiveChannelProved === true &&
        sourceUrls.length > 0;
  return (
    evidence.verdict === expectedVerdict &&
    evidence.canaryKey === "brazil_pncp" &&
    evidence.canaryCaseId === expected.id &&
    evidence.expectation === expected.expect &&
    evidence.requestedCountry === "BR" &&
    evidence.requestedState === expected.state &&
    evidence.requestedKeyword === expected.keyword &&
    evidence.requestedLimit === expected.limit &&
    evidence.sourceDataMode === "live-official-http" &&
    evidence.modelMode === "stub" &&
    evidence.modelScoringProved === false &&
    expectedResultShape &&
    sourceUrls.every((url) =>
      url.startsWith(
        "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta",
      ),
    )
  );
}

const DEFAULT_BRAZIL_PNCP_MATRIX: readonly BrazilPncpMatrixCase[] = [
  {
    id: "maintenance-pagination-current-buyers",
    keyword: "manutenção",
    limit: 25,
    expect: "nonzero",
    claim: "current_buyer_sample",
  },
  {
    id: "equipment-current-buyer",
    keyword: "equipamento",
    limit: 1,
    expect: "nonzero",
    claim: "current_buyer_sample",
  },
  {
    id: "roraima-scoped-zero-control",
    keyword: "codex-canary-no-match-pncp-9f4c6b30",
    state: "RR",
    limit: 1,
    expect: "zero",
    claim: "scoped_zero_result_control",
  },
];

export function brazilPncpCanaryExpectation(
  value: string | undefined,
): BrazilPncpCanaryExpectation {
  const normalized = value?.trim().toLocaleLowerCase("en-US") || "nonzero";
  if (normalized === "nonzero" || normalized === "zero") return normalized;
  throw new Error("ACQUISITION_CANARY_EXPECT must be nonzero or zero");
}

export function brazilPncpCanaryOverrides(
  env: Record<string, string | undefined>,
) {
  const rawState =
    env.ACQUISITION_CANARY_STATE?.trim().toLocaleUpperCase("pt-BR");
  if (rawState && !/^[A-Z]{2}$/u.test(rawState))
    throw new Error("PNCP canary state must be a two-letter UF");
  return {
    keyword: canaryKeywordOverride(env, "manutenção"),
    state: rawState || undefined,
    limit: boundedUsaSpendingInteger(
      env.ACQUISITION_CANARY_LIMIT,
      25,
      1,
      25,
      "business limit",
    ),
  };
}

export function brazilPncpCanaryMatrix(
  env: Record<string, string | undefined>,
): BrazilPncpMatrixCase[] {
  const configured = env.ACQUISITION_BRAZIL_PNCP_MATRIX_CASES?.trim();
  let source: unknown = DEFAULT_BRAZIL_PNCP_MATRIX;
  if (configured) {
    try {
      source = JSON.parse(configured);
    } catch {
      throw new Error(
        "ACQUISITION_BRAZIL_PNCP_MATRIX_CASES must be valid JSON",
      );
    }
  }
  if (!Array.isArray(source) || source.length < 3 || source.length > 8) {
    throw new Error("PNCP matrix must contain between 3 and 8 cases");
  }
  const cases = source.map((value, index): BrazilPncpMatrixCase => {
    const row = object(value);
    const id = boundedUsaSpendingText(row.id, `case ${index + 1} id`, 64);
    const keyword = boundedUsaSpendingText(
      row.keyword,
      `case ${index + 1} keyword`,
      160,
    );
    const state = text(row.state)?.toLocaleUpperCase("pt-BR");
    if (state && !/^[A-Z]{2}$/u.test(state))
      throw new Error(`PNCP matrix case ${id} state must be a two-letter UF`);
    const limit = boundedUsaSpendingInteger(
      row.limit,
      1,
      1,
      25,
      "business limit",
    );
    const expect = brazilPncpCanaryExpectation(text(row.expect));
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id))
      throw new Error(`PNCP matrix case id must be lower-kebab-case: ${id}`);
    return {
      id,
      keyword,
      state,
      limit,
      expect,
      claim:
        expect === "zero"
          ? "scoped_zero_result_control"
          : "current_buyer_sample",
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("PNCP matrix case ids must be unique");
  const positives = cases.filter((item) => item.expect === "nonzero");
  const zeros = cases.filter((item) => item.expect === "zero");
  if (
    positives.length < 2 ||
    new Set(
      positives.map((item) =>
        item.keyword.normalize("NFKC").toLocaleLowerCase("pt-BR"),
      ),
    ).size < 2
  ) {
    throw new Error(
      "PNCP matrix requires at least two distinct positive keywords",
    );
  }
  if (!positives.some((item) => item.limit > 1))
    throw new Error(
      "PNCP matrix requires one positive case capable of proving continuation",
    );
  if (
    zeros.length !== 1 ||
    !zeros[0]?.state ||
    !/^codex-canary-no-match-pncp-[a-f0-9]{8,64}$/u.test(
      zeros[0].keyword.toLocaleLowerCase("en-US"),
    )
  ) {
    throw new Error(
      "PNCP matrix requires exactly one state-scoped deterministic zero control",
    );
  }
  return cases;
}

export function brazilPncpPaginationEvidence(rows: readonly unknown[]) {
  const evidence = rows.map(object);
  const acceptedPageOne = evidence.some((row) => row.sourcePage === 1);
  const acceptedPageTwo = evidence.some(
    (row) => Number.isSafeInteger(row.sourcePage) && Number(row.sourcePage) > 1,
  );
  const fingerprints = new Set(
    evidence.map((row) => text(row.queryFingerprint)).filter(Boolean),
  );
  const dates = new Set(
    evidence.map((row) => text(row.queryDateFinal)).filter(Boolean),
  );
  const frozenQuery =
    evidence.length > 0 && fingerprints.size === 1 && dates.size === 1;
  return {
    acceptedPageOne,
    acceptedPageTwo,
    frozenQuery,
    proved: acceptedPageOne && acceptedPageTwo && frozenQuery,
  };
}

export function brazilPncpMatrixVerdict(
  results: readonly unknown[],
  expectedCases: number,
) {
  const allCasesPassed =
    results.length === expectedCases &&
    results.every((value) => object(value).status === "PASS");
  const paginationProved = results.some((value) => {
    const result = object(value);
    return (
      result.status === "PASS" &&
      object(object(result.evidence).paginationEvidence).proved === true
    );
  });
  const positives = results.flatMap((value) => {
    const result = object(value);
    const evidence = object(result.evidence);
    if (result.status !== "PASS" || evidence.expectation !== "nonzero")
      return [];
    const rows = Array.isArray(evidence.procurementEvidence)
      ? evidence.procurementEvidence.map(object)
      : [];
    const identifiers = Array.isArray(evidence.identifiers)
      ? evidence.identifiers.map((value) => {
          const identifier = object(value);
          return {
            rawRecordId: text(identifier.rawRecordId) ?? null,
            companyId: text(identifier.companyId) ?? "",
            scheme: text(identifier.scheme) ?? "",
            jurisdiction: text(identifier.jurisdiction) ?? "",
            normalizedValue: text(identifier.normalizedValue) ?? "",
            authorityProviderKey: text(identifier.authorityProviderKey) ?? null,
            status: text(identifier.status) ?? "",
            validatorVersion: text(identifier.validatorVersion) ?? "",
          };
        })
      : [];
    return [
      {
        keyword: text(evidence.requestedKeyword),
        controls: rows
          .map((row) => text(row.controlNumber))
          .filter((item): item is string => Boolean(item)),
        companies: rows
          .map((row) => text(row.companyName))
          .filter((item): item is string => Boolean(item)),
        authorityIdentityProved: rows.some((row) => {
          const rawRecordId = text(row.rawRecordId);
          const cnpjClaim = text(row.cnpjClaim);
          const canonicalCompanyId = text(row.canonicalCompanyId);
          if (!rawRecordId || !canonicalCompanyId || !cnpjClaim) return false;
          const exactRawAuthorityIdentifiers = identifiers.filter(
            (identifier) =>
              identifier.rawRecordId === rawRecordId &&
              identifier.companyId === canonicalCompanyId &&
              identifier.scheme === "br-cnpj" &&
              identifier.jurisdiction === "BR" &&
              identifier.normalizedValue === cnpjClaim &&
              identifier.authorityProviderKey === "brazil_pncp" &&
              identifier.status === "ACTIVE" &&
              identifier.validatorVersion === "cnpj-v1",
          );
          if (exactRawAuthorityIdentifiers.length !== 1) return false;
          return brazilPncpAuthorityEvidenceIsConsistent(
            {
              rawRecordId,
              canonicalCompanyId,
              controlNumber: text(row.controlNumber),
              cnpjClaim,
              cnpjIdentityStatus: row.cnpjIdentityStatus,
              rawIdentifiers: Array.isArray(row.rawIdentifiers)
                ? row.rawIdentifiers
                : undefined,
            },
            identifiers,
            "brazil_pncp",
          );
        }),
      },
    ];
  });
  const positiveDiversityProved =
    positives.length >= 2 &&
    positives.every(
      (item) =>
        item.keyword && item.controls.length > 0 && item.companies.length > 0,
    ) &&
    new Set(positives.flatMap((item) => item.controls)).size >= 2 &&
    positives.every((item, index) =>
      item.companies.some((company) =>
        positives.every(
          (other, otherIndex) =>
            otherIndex === index || !other.companies.includes(company),
        ),
      ),
    );
  const authorityIdentityProved = positives.some(
    (item) => item.authorityIdentityProved,
  );
  return {
    allCasesPassed,
    paginationProved,
    positiveDiversityProved,
    authorityIdentityProved,
    verdict:
      allCasesPassed &&
      paginationProved &&
      positiveDiversityProved &&
      authorityIdentityProved
        ? ("PASS" as const)
        : ("FAIL" as const),
  };
}

function parseBrazilPncpDeadline(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/u.exec(
      value,
    );
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  // PNCP commonly emits local civil timestamps without an offset. Interpret
  // those in Brasilia time; explicit offsets/Z remain authoritative.
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)
    ? value
    : `${value}-03:00`;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : undefined;
}
