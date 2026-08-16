import { describe, expect, it } from "vitest";
import {
  acquisitionReplayEvidence,
  boundedCanaryDiagnostic,
  brazilPncpAuthorityEvidenceIsConsistent,
  brazilPncpCanaryMatrix,
  brazilPncpCanaryOverrides,
  brazilPncpMatrixCaseEvidenceIsValid,
  brazilPncpMatrixVerdict,
  brazilPncpPaginationEvidence,
  canaryTextOverride,
  canaryKeywordOverride,
  contractsFinderCanaryExpectation,
  contractsFinderCanaryMatrix,
  contractsFinderCanaryOverrides,
  contractsFinderMatrixHasPaginationProof,
  contractsFinderMatrixVerdict,
  contractsFinderPaginationEvidence,
  matchesContractsFinderLocation,
  providerQualityRows,
  readBrazilPncpCanaryEvidence,
  readEuEcolabelCanaryEvidence,
  readMexicoDenueCanaryEvidence,
  readRorCanaryEvidence,
  readSecEdgarCanaryEvidence,
  secEdgarQualityCanPass,
  readUsaSpendingCanaryEvidence,
  readUkProcurementCanaryEvidence,
  readWorldBankCanaryEvidence,
  runCanaryCleanup,
  SUPPORTED_PERSISTENT_ACQUISITION_CANARIES,
  worldBankCanaryExpectation,
  worldBankCanaryMatrix,
  worldBankCanaryOverrides,
  worldBankCanaryTriggerSignals,
  worldBankMatrixVerdict,
  worldBankPaginationEvidence,
  worldBankPositiveQualityCanPass,
  worldBankPositiveRunCanPass,
  worldBankRunStatusIsTruthful,
  usaSpendingCanaryExpectation,
  usaSpendingCanaryMatrix,
  usaSpendingCanaryOverrides,
  usaSpendingMatrixVerdict,
  usaSpendingPaginationEvidence,
  usaSpendingPositiveQualityCanPass,
  zeroResultQualityCanPass,
} from "./verify-world-bank-procurement-persistent-funnel.support";

describe("persistent procurement canary acceptance helpers", () => {
  it("isolates the requested discovery provider from downstream quality rows", () => {
    const rows = [
      { providerKey: "world_bank_procurement", rawCount: 10 },
      { providerKey: "gleif", rawCount: 0 },
      { providerKey: "wikidata", rawCount: 0 },
      { providerKey: "digital_footprint", rawCount: 0 },
    ];

    expect(providerQualityRows(rows, "world_bank_procurement")).toEqual([
      { providerKey: "world_bank_procurement", rawCount: 10 },
    ]);
  });

  it("keeps governed organization canaries in the executable allowlist", () => {
    expect(SUPPORTED_PERSISTENT_ACQUISITION_CANARIES).toContain("ror");
    expect(SUPPORTED_PERSISTENT_ACQUISITION_CANARIES).toContain("sec_edgar");
    expect(SUPPORTED_PERSISTENT_ACQUISITION_CANARIES).toContain("mexico_denue");
    expect(SUPPORTED_PERSISTENT_ACQUISITION_CANARIES).toContain("eu_ecolabel");
  });

  it("reads only bounded EU Ecolabel organization and product-award evidence", () => {
    expect(
      readEuEcolabelCanaryEvidence({
        externalId: "eu-ecolabel:AT%2F004%2F001:124717",
        name: "Hagleitner Hygiene International GmbH",
        country: "AT",
        attributes: {
          eu_ecolabel: {
            licence_number: "AT/004/001",
            item_id: "124717",
            product_name: "multiROLL handTUCH X2.2 L",
            certification_scope: "product_award_not_organization_certification",
            rights_notice: "attribution and change indication required",
          },
        },
      }),
    ).toEqual({
      externalId: "eu-ecolabel:AT%2F004%2F001:124717",
      name: "Hagleitner Hygiene International GmbH",
      country: "AT",
      topLevelDomain: undefined,
      identifiers: [],
      licenceNumber: "AT/004/001",
      itemId: "124717",
      productName: "multiROLL handTUCH X2.2 L",
      certificationScope: "product_award_not_organization_certification",
      rightsNotice: "attribution and change indication required",
    });
  });

  it("reads only the bounded ROR organization and reported-domain evidence", () => {
    expect(
      readRorCanaryEvidence({
        name: "University of Oxford",
        country: "GB",
        identifiers: [{ scheme: "ror-id", value: "https://ror.org/052gg0110" }],
        attributes: {
          ror: {
            ror_id: "https://ror.org/052gg0110",
            status: "active",
            organization_types: ["education"],
            reported_domain_candidates: ["ox.ac.uk"],
            domain_identity_status: "source_reported_evidence_only",
          },
        },
      }),
    ).toMatchObject({
      name: "University of Oxford",
      country: "GB",
      topLevelDomain: undefined,
      rorId: "https://ror.org/052gg0110",
      status: "active",
      organizationTypes: ["education"],
      reportedDomainCandidates: ["ox.ac.uk"],
      domainIdentityStatus: "source_reported_evidence_only",
    });
  });

  it("reads only the bounded SEC exchange-directory filer evidence", () => {
    expect(
      readSecEdgarCanaryEvidence({
        name: "Apple Inc.",
        identifiers: [{ scheme: "cik", value: "0000320193" }],
        attributes: {
          sec_edgar: {
            cik: "0000320193",
            ticker: "AAPL",
            exchange: "Nasdaq",
            identity_scope: "US securities filer namespace",
            disclaimer:
              "A CIK identifies an SEC filer and does not establish US domicile or commercial fit.",
          },
        },
      }),
    ).toMatchObject({
      name: "Apple Inc.",
      country: undefined,
      topLevelDomain: undefined,
      cik: "0000320193",
      ticker: "AAPL",
      exchange: "Nasdaq",
      identityScope: "US securities filer namespace",
    });
  });

  it("reads only the bounded DENUE organization-establishment evidence", () => {
    expect(
      readMexicoDenueCanaryEvidence({
        externalId: "mexico-denue:1234567890",
        name: "NISSAN MEXICANA, S.A. DE C.V.",
        country: "MX",
        attributes: {
          mexico_denue: {
            clee: "25012713120003411000000000U6",
            denue_id: "1234567890",
            trade_name: "NISSAN MEXICANA",
            legal_name: "NISSAN MEXICANA, S.A. DE C.V.",
            reported_website_candidate: "https://www.nissan.com.mx/",
            identity_status: "source_native_establishment_evidence_only",
          },
        },
      }),
    ).toEqual({
      externalId: "mexico-denue:1234567890",
      name: "NISSAN MEXICANA, S.A. DE C.V.",
      country: "MX",
      topLevelDomain: undefined,
      identifiers: [],
      clee: "25012713120003411000000000U6",
      denueId: "1234567890",
      tradeName: "NISSAN MEXICANA",
      legalName: "NISSAN MEXICANA, S.A. DE C.V.",
      reportedWebsiteCandidate: "https://www.nissan.com.mx/",
      identityStatus: "source_native_establishment_evidence_only",
    });
  });

  it("restores a temporary Provider before independent run and lock cleanup even when another step fails", async () => {
    const calls: string[] = [];
    await expect(
      runCanaryCleanup({
        restoreProvider: async () => {
          calls.push("provider");
        },
        finalizeRun: async () => {
          calls.push("run");
          throw new Error("run cleanup failed");
        },
        releaseToggleLock: async () => {
          calls.push("lock");
        },
      }),
    ).rejects.toThrow("run cleanup failed");
    expect(calls).toEqual(["provider", "run", "lock"]);
  });

  it("retains the diagnostic tail where a bounded child error is normally emitted", () => {
    const diagnostic = boundedCanaryDiagnostic(
      `HEAD ${"info ".repeat(500)} FINAL_PROVIDER_ERROR`,
    );
    expect(diagnostic.length).toBeLessThanOrEqual(2_000);
    expect(diagnostic).toContain("HEAD");
    expect(diagnostic).toContain("[diagnostic truncated]");
    expect(diagnostic).toContain("FINAL_PROVIDER_ERROR");
  });

  it("proves replay only when every accepted Raw resolves to a first-run root with no entity growth", () => {
    expect(
      acquisitionReplayEvidence({
        honestTerminal: true,
        providerKey: "world_bank_procurement",
        acceptedRawIds: ["raw-replay-1", "raw-replay-2"],
        resolvedLinks: [
          { rawRecordId: "raw-replay-1", rootCompanyId: "company-root-1" },
          { rawRecordId: "raw-replay-2", rootCompanyId: "company-root-2" },
        ],
        baselineRootCompanyIds: ["company-root-1", "company-root-2"],
        beforeCounts: {
          canonicalCompanies: 2,
          leads: 2,
          fieldEvidence: 8,
          authorityIdentifiers: 0,
          identityLinks: 2,
        },
        afterCounts: {
          canonicalCompanies: 2,
          leads: 2,
          fieldEvidence: 8,
          authorityIdentifiers: 0,
          identityLinks: 2,
        },
        identityQuality: {
          world_bank_procurement: {
            acceptedRows: 2,
            boundRows: 2,
            conflictRows: 0,
            suppressedRows: 0,
            replayedRows: 2,
          },
        },
      }),
    ).toEqual({
      honestTerminal: true,
      acceptedRawCount: 2,
      baselineRootCompanyCount: 2,
      acceptedRawResolvedToBaselineRoots: true,
      beforeCounts: {
        canonicalCompanies: 2,
        leads: 2,
        fieldEvidence: 8,
        authorityIdentifiers: 0,
        identityLinks: 2,
      },
      afterCounts: {
        canonicalCompanies: 2,
        leads: 2,
        fieldEvidence: 8,
        authorityIdentifiers: 0,
        identityLinks: 2,
      },
      addedCounts: {
        canonicalCompanies: 0,
        leads: 0,
        fieldEvidence: 0,
        authorityIdentifiers: 0,
        identityLinks: 0,
      },
      noEntityGrowth: true,
      identityQuality: {
        acceptedRows: 2,
        boundRows: 2,
        conflictRows: 0,
        suppressedRows: 0,
        replayedRows: 2,
      },
      identityQualityAccurate: true,
      proved: true,
    });
  });

  it("keeps replay evidence red when a new Raw creates evidence or resolves outside first-run roots", () => {
    const result = acquisitionReplayEvidence({
      honestTerminal: true,
      providerKey: "world_bank_procurement",
      acceptedRawIds: ["raw-replay-1"],
      resolvedLinks: [
        { rawRecordId: "raw-replay-1", rootCompanyId: "company-new" },
      ],
      baselineRootCompanyIds: ["company-root-1"],
      beforeCounts: {
        canonicalCompanies: 1,
        leads: 1,
        fieldEvidence: 4,
        authorityIdentifiers: 0,
        identityLinks: 1,
      },
      afterCounts: {
        canonicalCompanies: 2,
        leads: 2,
        fieldEvidence: 8,
        authorityIdentifiers: 1,
        identityLinks: 2,
      },
      identityQuality: {
        world_bank_procurement: {
          acceptedRows: 1,
          boundRows: 1,
          conflictRows: 0,
          suppressedRows: 0,
          replayedRows: 0,
        },
      },
    });

    expect(result).toMatchObject({
      acceptedRawResolvedToBaselineRoots: false,
      addedCounts: {
        canonicalCompanies: 1,
        leads: 1,
        fieldEvidence: 4,
        authorityIdentifiers: 1,
        identityLinks: 1,
      },
      noEntityGrowth: false,
      identityQualityAccurate: false,
      proved: false,
    });
  });

  it("does not infer replay success from absent or malformed identity-quality facts", () => {
    const shared = {
      honestTerminal: true,
      providerKey: "world_bank_procurement",
      acceptedRawIds: ["raw-replay-1"],
      resolvedLinks: [
        { rawRecordId: "raw-replay-1", rootCompanyId: "company-root-1" },
      ],
      baselineRootCompanyIds: ["company-root-1"],
      beforeCounts: {
        canonicalCompanies: 1,
        leads: 1,
        fieldEvidence: 4,
        authorityIdentifiers: 0,
        identityLinks: 1,
      },
      afterCounts: {
        canonicalCompanies: 1,
        leads: 1,
        fieldEvidence: 4,
        authorityIdentifiers: 0,
        identityLinks: 1,
      },
    } as const;

    expect(
      acquisitionReplayEvidence({ ...shared, identityQuality: {} }),
    ).toMatchObject({
      identityQuality: {
        acceptedRows: null,
        boundRows: null,
        conflictRows: null,
        suppressedRows: null,
        replayedRows: null,
      },
      identityQualityAccurate: false,
      proved: false,
    });
    expect(
      acquisitionReplayEvidence({
        ...shared,
        identityQuality: {
          world_bank_procurement: {
            acceptedRows: 1,
            boundRows: 1,
            replayedRows: "1",
          },
        },
      }).proved,
    ).toBe(false);
  });

  it("allows trimmed region and keyword overrides with stable fallbacks", () => {
    expect(canaryTextOverride(" Northern Ireland ", "England")).toBe(
      "Northern Ireland",
    );
    expect(canaryTextOverride(" automated barrier ", "maintenance")).toBe(
      "automated barrier",
    );
    expect(canaryTextOverride(undefined, "maintenance")).toBe("maintenance");
    expect(
      contractsFinderCanaryOverrides({
        ACQUISITION_CANARY_REGION: " Wales ",
        KEYWORD: " barrier ",
      }),
    ).toEqual({ region: "Wales", keyword: "barrier" });
    expect(
      contractsFinderCanaryOverrides({
        ACQUISITION_CANARY_KEYWORD: " preferred ",
        KEYWORD: "legacy",
      }).keyword,
    ).toBe("preferred");
    expect(canaryKeywordOverride({ KEYWORD: " serviço " }, "fallback")).toBe(
      "serviço",
    );
    expect(contractsFinderCanaryExpectation(undefined)).toBe("nonzero");
    expect(contractsFinderCanaryExpectation(" ZERO ")).toBe("zero");
    expect(() => contractsFinderCanaryExpectation("maybe")).toThrow(
      /must be nonzero or zero/u,
    );
  });

  it("defines a bounded three-region matrix plus an independent zero-result control", () => {
    const matrix = contractsFinderCanaryMatrix();
    expect(matrix.map((item) => item.region)).toEqual([
      "Wales",
      "England",
      "Northern Ireland",
      "Wales",
    ]);
    expect(matrix.filter((item) => item.expect === "nonzero")).toHaveLength(3);
    expect(matrix.filter((item) => item.expect === "zero")).toEqual([
      expect.objectContaining({ claim: "zero_result_control" }),
    ]);
    expect(matrix.every((item) => !("requirePaginationEvidence" in item))).toBe(
      true,
    );
    expect(new Set(matrix.map((item) => item.keyword)).size).toBe(
      matrix.length,
    );
  });

  it("proves continuation only from an accepted cursor URL or max-page truncation fact", () => {
    expect(
      contractsFinderPaginationEvidence(
        [
          "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?cursor=abc",
        ],
        {},
      ),
    ).toEqual({
      acceptedFromContinuation: true,
      maxPagesExhausted: false,
      proved: true,
    });
    expect(
      contractsFinderPaginationEvidence([], {
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toEqual({
      acceptedFromContinuation: false,
      maxPagesExhausted: true,
      proved: true,
    });
    expect(contractsFinderPaginationEvidence(["not a url"], {})).toEqual({
      acceptedFromContinuation: false,
      maxPagesExhausted: false,
      proved: false,
    });
  });

  it("requires at least one pagination proof across the completed matrix", () => {
    expect(
      contractsFinderMatrixHasPaginationProof([
        { status: "PASS", evidence: { paginationEvidence: { proved: false } } },
        { status: "PASS", evidence: { paginationEvidence: { proved: true } } },
      ]),
    ).toBe(true);
    expect(
      contractsFinderMatrixHasPaginationProof([
        { status: "PASS", evidence: { paginationEvidence: { proved: false } } },
        { status: "PASS", evidence: {} },
      ]),
    ).toBe(false);
    expect(
      contractsFinderMatrixHasPaginationProof([
        { status: "FAIL", evidence: { paginationEvidence: { proved: true } } },
      ]),
    ).toBe(false);
    expect(
      contractsFinderMatrixVerdict(
        [
          {
            status: "PASS",
            evidence: { paginationEvidence: { proved: false } },
          },
          {
            status: "PASS",
            evidence: { paginationEvidence: { proved: false } },
          },
        ],
        2,
      ),
    ).toEqual({
      allCasesPassed: true,
      paginationProved: false,
      verdict: "FAIL",
    });
    expect(
      contractsFinderMatrixVerdict(
        [
          {
            status: "PASS",
            evidence: { paginationEvidence: { proved: false } },
          },
          {
            status: "PASS",
            evidence: { paginationEvidence: { proved: true } },
          },
        ],
        2,
      ),
    ).toEqual({
      allCasesPassed: true,
      paginationProved: true,
      verdict: "PASS",
    });
  });

  it("defines a bounded USAspending historical-buyer matrix with continuation and zero controls", () => {
    const matrix = usaSpendingCanaryMatrix({});
    expect(matrix).toMatchObject([
      {
        id: "construction-page-two-historical-buyers",
        keyword: "construction",
        sinceDays: 730,
        limit: 6,
        expect: "nonzero",
      },
      {
        id: "maintenance-historical-buyer",
        keyword: "maintenance",
        sinceDays: 730,
        limit: 1,
        expect: "nonzero",
      },
      {
        id: "usaspending-deterministic-zero-control",
        limit: 1,
        expect: "zero",
      },
    ]);
    expect(usaSpendingCanaryOverrides({})).toEqual({
      keyword: "construction",
      sinceDays: 730,
      limit: 6,
    });
    expect(
      usaSpendingCanaryOverrides({
        ACQUISITION_CANARY_KEYWORD: " solar ",
        ACQUISITION_CANARY_SINCE_DAYS: "365",
        ACQUISITION_CANARY_LIMIT: "2",
      }),
    ).toEqual({ keyword: "solar", sinceDays: 365, limit: 2 });
    expect(usaSpendingCanaryExpectation(" ZERO ")).toBe("zero");
    expect(() =>
      usaSpendingCanaryOverrides({ ACQUISITION_CANARY_LIMIT: "0" }),
    ).toThrow(/business limit/u);
    expect(() =>
      usaSpendingCanaryOverrides({ ACQUISITION_CANARY_SINCE_DAYS: "3651" }),
    ).toThrow(/since days/u);
  });

  it("rejects a USAspending matrix without diverse positives, continuation capacity or a deterministic zero", () => {
    const env = (cases: unknown[]) => ({
      ACQUISITION_USASPENDING_MATRIX_CASES: JSON.stringify(cases),
    });
    expect(() =>
      usaSpendingCanaryMatrix(
        env([
          {
            id: "one",
            keyword: "solar",
            sinceDays: 730,
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "two",
            keyword: "solar",
            sinceDays: 730,
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "zero",
            keyword: "wrong",
            sinceDays: 730,
            limit: 1,
            expect: "zero",
          },
        ]),
      ),
    ).toThrow(/distinct positive keywords|continuation|deterministic zero/u);
    expect(() =>
      usaSpendingCanaryMatrix(
        env([
          {
            id: "one",
            keyword: "solar",
            sinceDays: 730,
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "two",
            keyword: "maintenance",
            sinceDays: 730,
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "zero",
            keyword: "codex-canary-no-match-usaspending-deadbeef",
            sinceDays: 730,
            limit: 1,
            expect: "zero",
          },
        ]),
      ),
    ).toThrow(/capable of proving continuation/u);
  });

  it("reads auditable USAspending buyer facts without retaining recipient or inventing identity", () => {
    expect(
      readUsaSpendingCanaryEvidence(
        {
          name: "Department of Defense / Department of the Navy",
          country: "US",
          attributes: {
            source_role: "buyer",
            signal_stage: "historical_award_buyer",
            procurement: {
              award_id: "A-1",
              awarding_agency: "Department of Defense",
              awarding_sub_agency: "Department of the Navy",
              query_match: true,
              match_basis: ["description"],
              start_date: "2025-01-01",
              end_date: "2025-12-31",
              source_page: 2,
              query_start_date: "2024-08-14",
              query_end_date: "2026-08-14",
              query_keywords: ["construction"],
              query_fingerprint: "a".repeat(64),
            },
          },
        },
        ["construction"],
      ),
    ).toMatchObject({
      parentSubagencyNameMatches: true,
      positiveKeywordMatch: true,
      recipientRetained: false,
      descriptionRetained: false,
      matchBasis: ["description"],
      sourcePage: 2,
      rawDomain: undefined,
      rawIdentifier: undefined,
      rawIdentifiers: undefined,
      startDateValid: true,
      endDateValid: true,
      queryStartDateValid: true,
      queryEndDateValid: true,
    });
    expect(
      readUsaSpendingCanaryEvidence(
        {
          name: "Department / Office",
          attributes: {
            procurement: {
              recipient_name: "Person",
              description: "Construction services",
              query_match: true,
              match_basis: ["description"],
              query_keywords: ["construction"],
            },
          },
        },
        ["construction"],
      ),
    ).toMatchObject({
      recipientRetained: true,
      descriptionRetained: true,
      positiveKeywordMatch: false,
    });
  });

  it("does not reconstruct USAspending keyword proof from persisted agency or legacy description text", () => {
    expect(
      readUsaSpendingCanaryEvidence(
        {
          name: "Construction Department / Construction Office",
          attributes: {
            procurement: {
              awarding_agency: "Construction Department",
              awarding_sub_agency: "Construction Office",
              description: "Construction services",
              query_keywords: ["construction"],
            },
          },
        },
        ["construction"],
      ).positiveKeywordMatch,
    ).toBe(false);
    expect(
      readUsaSpendingCanaryEvidence(
        {
          attributes: {
            procurement: {
              query_match: true,
              match_basis: ["free_text"],
              query_keywords: ["construction"],
            },
          },
        },
        ["construction"],
      ),
    ).toMatchObject({ matchBasisValid: false, positiveKeywordMatch: false });
  });

  it("requires persisted USAspending page-two evidence, exact quality, and matrix diversity", () => {
    expect(
      usaSpendingPaginationEvidence([
        { sourcePage: 1, queryFingerprint: "a".repeat(64) },
        { sourcePage: 2, queryFingerprint: "a".repeat(64) },
      ]),
    ).toEqual({
      acceptedPageOne: true,
      acceptedPageTwo: true,
      frozenQueryFingerprint: true,
      proved: true,
    });
    expect(
      usaSpendingPaginationEvidence([
        { sourcePage: 1, queryFingerprint: "a".repeat(64) },
        { sourcePage: 2, queryFingerprint: "b".repeat(64) },
      ]),
    ).toEqual({
      acceptedPageOne: true,
      acceptedPageTwo: true,
      frozenQueryFingerprint: false,
      proved: false,
    });
    expect(
      usaSpendingPaginationEvidence([
        { sourcePage: 1, queryFingerprint: "a".repeat(64) },
      ]),
    ).toEqual({
      acceptedPageOne: true,
      acceptedPageTwo: false,
      frozenQueryFingerprint: true,
      proved: false,
    });
    const quality = {
      providerKey: "usaspending_awards",
      terminalStatus: "DONE",
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 0,
      failureCount: 0,
      rawCount: 2,
      acceptedCount: 2,
      boundCount: 2,
      conflictCount: 0,
    };
    expect(usaSpendingPositiveQualityCanPass([quality], 2)).toBe(true);
    expect(
      usaSpendingPositiveQualityCanPass([{ ...quality, failureCount: 1 }], 2),
    ).toBe(false);
    const results = [
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedKeyword: "construction",
          paginationEvidence: { proved: true },
          procurementEvidence: [{ awardId: "A-1", companyName: "Navy" }],
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedKeyword: "maintenance",
          paginationEvidence: { proved: false },
          procurementEvidence: [{ awardId: "A-2", companyName: "DCMA" }],
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "zero",
          paginationEvidence: { proved: false },
          procurementEvidence: [],
        },
      },
    ];
    expect(usaSpendingMatrixVerdict(results, 3)).toEqual({
      allCasesPassed: true,
      paginationProved: true,
      positiveDiversityProved: true,
      verdict: "PASS",
    });
    expect(usaSpendingMatrixVerdict(results.slice(0, 2), 3).verdict).toBe(
      "FAIL",
    );
    const repeatedCompanyResults = structuredClone(results);
    const repeatedEvidence = repeatedCompanyResults[1]!.evidence as {
      procurementEvidence: Array<{ awardId: string; companyName: string }>;
    };
    repeatedEvidence.procurementEvidence[0]!.companyName = "Navy";
    expect(
      usaSpendingMatrixVerdict(repeatedCompanyResults, 3)
        .positiveDiversityProved,
    ).toBe(false);
  });

  it("never treats a description-only keyword as positive evidence", () => {
    const evidence = readUkProcurementCanaryEvidence(
      {
        name: "Example Council",
        country: "United Kingdom",
        region: "England",
        attributes: {
          source_role: "buyer",
          signal_stage: "planning_or_tender",
          procurement: {
            title: "General supplies",
            description: "Industrial pump maintenance and a named contact",
          },
        },
      },
      ["maintenance"],
    );

    expect(evidence.positiveKeywordMatch).toBe(false);
  });

  it("accepts a keyword found in the buyer name or procurement title", () => {
    expect(
      readUkProcurementCanaryEvidence(
        {
          name: "Example Council",
          attributes: {
            procurement: { title: "Automated barrier maintenance" },
          },
        },
        ["barrier"],
      ).positiveKeywordMatch,
    ).toBe(true);
    expect(
      readUkProcurementCanaryEvidence(
        {
          name: "Maintenance Services Council",
          attributes: { procurement: { title: "General supplies" } },
        },
        ["maintenance"],
      ).positiveKeywordMatch,
    ).toBe(true);
  });

  it("distinguishes a current UK deadline from a stale or invalid one", () => {
    const payload = {
      name: "Example Council",
      attributes: {
        procurement: {
          title: "Building maintenance",
          deadline: "2026-08-20T12:00:00+01:00",
        },
      },
    };
    expect(
      readUkProcurementCanaryEvidence(
        payload,
        ["maintenance"],
        new Date("2026-08-14T00:00:00Z"),
      ),
    ).toMatchObject({ deadlineIsCurrent: true });
    expect(
      readUkProcurementCanaryEvidence(
        payload,
        ["maintenance"],
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toMatchObject({ deadlineIsCurrent: false });
    expect(
      readUkProcurementCanaryEvidence(
        {
          ...payload,
          attributes: {
            procurement: { title: "Building maintenance", deadline: "invalid" },
          },
        },
        ["maintenance"],
        new Date("2026-08-14T00:00:00Z"),
      ).deadlineIsCurrent,
    ).toBe(false);
  });

  it("requires canonical United Kingdom plus the exact target region", () => {
    expect(
      matchesContractsFinderLocation(
        { country: "United Kingdom", region: "Northern Ireland" },
        "Northern Ireland",
      ),
    ).toBe(true);
    expect(
      matchesContractsFinderLocation(
        { country: "Northern Ireland", region: null },
        "Northern Ireland",
      ),
    ).toBe(false);
  });

  it("requires PNCP buyer evidence whose title matches and deadline is still future", () => {
    const evidence = readBrazilPncpCanaryEvidence(
      {
        name: "Municipio de Exemplo",
        country: "BR",
        region: "Recife/PE",
        identifiers: [
          { scheme: "br-cnpj", jurisdiction: "BR", value: "12345678000190" },
        ],
        attributes: {
          source_role: "buyer",
          signal_stage: "open_for_proposals",
          procurement: {
            title: "Prestação de serviço de manutenção",
            control_number: "12345678000190-1-000001/2026",
            matched_query_terms: ["serviço"],
            deadline: "2026-08-20T12:00:00",
            cnpj_claim: "12345678000190",
            cnpj_identity_status: "validated_authority",
            source_page: 2,
            query_date_final: "20260814",
            query_keywords: ["serviço"],
            query_fingerprint: "a".repeat(64),
          },
        },
      },
      "serviço",
      new Date("2026-08-14T00:00:00Z"),
    );

    expect(evidence).toMatchObject({
      country: "BR",
      positiveTitleKeywordMatch: true,
      sourceRole: "buyer",
      signalStage: "open_for_proposals",
      deadlineIsCurrent: true,
      cnpjClaim: "12345678000190",
      cnpjIdentityStatus: "validated_authority",
      sourcePage: 2,
      queryDateFinal: "20260814",
    });
    expect(evidence.deadlineAt).toBe("2026-08-20T15:00:00.000Z");
  });

  it("fails PNCP acceptance for description-only matches, stale or invalid deadlines", () => {
    const base = {
      name: "Municipio de Exemplo",
      country: "BR",
      attributes: {
        source_role: "buyer",
        signal_stage: "open_for_proposals",
        procurement: {
          matched_query_terms: ["equipamentos"],
          deadline: "2026-08-13T12:00:00-03:00",
        },
      },
    };
    expect(
      readBrazilPncpCanaryEvidence(
        base,
        "serviço",
        new Date("2026-08-14T00:00:00Z"),
      ),
    ).toMatchObject({
      positiveTitleKeywordMatch: false,
      deadlineIsCurrent: false,
    });
    expect(
      readBrazilPncpCanaryEvidence(
        {
          ...base,
          attributes: {
            ...base.attributes,
            procurement: {
              ...base.attributes.procurement,
              deadline: "not-a-date",
            },
          },
        },
        "equipamentos",
        new Date("2026-08-14T00:00:00Z"),
      ).deadlineIsCurrent,
    ).toBe(false);
    expect(
      readBrazilPncpCanaryEvidence(
        {
          ...base,
          attributes: {
            ...base.attributes,
            procurement: {
              ...base.attributes.procurement,
              deadline: "2026-02-30T12:00:00",
            },
          },
        },
        "equipamentos",
        new Date("2026-02-01T00:00:00Z"),
      ).deadlineIsCurrent,
    ).toBe(false);
  });

  it("requires PNCP title evidence instead of trusting a persisted match marker", () => {
    const evidence = readBrazilPncpCanaryEvidence(
      {
        country: "BR",
        attributes: {
          procurement: {
            title: "Aquisição de material escolar",
            matched_query_terms: ["manutenção"],
            deadline: "2026-09-01T00:00:00",
          },
        },
      },
      "manutenção",
      new Date("2026-08-14T00:00:00Z"),
    );
    expect(evidence.positiveTitleKeywordMatch).toBe(false);
  });

  it("accepts PNCP authority evidence only when Raw claim and ACTIVE br-cnpj identity agree", () => {
    const valid = {
      rawRecordId: "raw-pncp-1",
      canonicalCompanyId: "company-pncp-1",
      controlNumber: "11222333000181-1-000001/2026",
      cnpjClaim: "11222333000181",
      cnpjIdentityStatus: "validated_authority",
      rawIdentifiers: [
        { scheme: "br-cnpj", jurisdiction: "BR", value: "11222333000181" },
      ],
    };
    const persisted = [
      {
        rawRecordId: "raw-pncp-1",
        companyId: "company-pncp-1",
        scheme: "br-cnpj",
        jurisdiction: "BR",
        normalizedValue: "11222333000181",
        authorityProviderKey: "brazil_pncp",
        status: "ACTIVE",
        validatorVersion: "cnpj-v1",
      },
    ];

    expect(
      brazilPncpAuthorityEvidenceIsConsistent(valid, persisted, "brazil_pncp"),
    ).toBe(true);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(valid, [], "brazil_pncp"),
    ).toBe(false);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        valid,
        [{ ...persisted[0], normalizedValue: "12345678000190" }],
        "brazil_pncp",
      ),
    ).toBe(false);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        valid,
        [{ ...persisted[0], status: "PENDING" }],
        "brazil_pncp",
      ),
    ).toBe(false);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        {
          ...valid,
          controlNumber: "12345678000190-1-000001/2026",
        },
        persisted,
        "brazil_pncp",
      ),
    ).toBe(false);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        {
          ...valid,
          controlNumber: "11222333000181/2026",
        },
        persisted,
        "brazil_pncp",
      ),
    ).toBe(false);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        { ...valid, rawRecordId: "raw-pncp-repeat" },
        persisted,
        "brazil_pncp",
      ),
    ).toBe(true);
  });

  it("requires claim-free PNCP Raw to have no br-cnpj identifier", () => {
    const claimFree = {
      rawRecordId: "raw-pncp-2",
      canonicalCompanyId: "company-pncp-2",
      cnpjClaim: undefined,
      cnpjIdentityStatus: undefined,
      rawIdentifiers: undefined,
    };

    expect(
      brazilPncpAuthorityEvidenceIsConsistent(claimFree, [], "brazil_pncp"),
    ).toBe(true);
    expect(
      brazilPncpAuthorityEvidenceIsConsistent(
        claimFree,
        [
          {
            rawRecordId: "raw-pncp-2",
            companyId: "company-pncp-2",
            scheme: "br-cnpj",
            jurisdiction: "BR",
            normalizedValue: "11222333000181",
            authorityProviderKey: "brazil_pncp",
            status: "ACTIVE",
            validatorVersion: "cnpj-v1",
          },
        ],
        "brazil_pncp",
      ),
    ).toBe(false);
  });

  it("validates the PNCP matrix, frozen pagination proof and positive diversity", () => {
    expect(brazilPncpCanaryOverrides({})).toEqual({
      keyword: "manutenção",
      state: undefined,
      limit: 25,
    });
    expect(
      brazilPncpCanaryOverrides({
        ACQUISITION_CANARY_KEYWORD: " serviço ",
        ACQUISITION_CANARY_STATE: " pe ",
        ACQUISITION_CANARY_LIMIT: "2",
      }),
    ).toEqual({ keyword: "serviço", state: "PE", limit: 2 });
    expect(() =>
      brazilPncpCanaryOverrides({ ACQUISITION_CANARY_STATE: "Brazil" }),
    ).toThrow(/two-letter UF/u);
    expect(brazilPncpCanaryMatrix({})).toHaveLength(3);

    const fingerprint = "a".repeat(64);
    expect(
      brazilPncpPaginationEvidence([
        {
          sourcePage: 1,
          queryDateFinal: "20260814",
          queryFingerprint: fingerprint,
        },
        {
          sourcePage: 2,
          queryDateFinal: "20260814",
          queryFingerprint: fingerprint,
        },
      ]),
    ).toEqual({
      acceptedPageOne: true,
      acceptedPageTwo: true,
      frozenQuery: true,
      proved: true,
    });
    expect(
      brazilPncpPaginationEvidence([
        {
          sourcePage: 1,
          queryDateFinal: "20260814",
          queryFingerprint: fingerprint,
        },
        {
          sourcePage: 2,
          queryDateFinal: "20260815",
          queryFingerprint: "b".repeat(64),
        },
      ]).proved,
    ).toBe(false);

    const authorityRaw = {
      rawRecordId: "raw-pncp-1",
      canonicalCompanyId: "company-pncp-1",
      controlNumber: "11222333000181-1-000001/2026",
      companyName: "Buyer A",
      cnpjClaim: "11222333000181",
      cnpjIdentityStatus: "validated_authority",
      rawIdentifiers: [
        { scheme: "br-cnpj", jurisdiction: "BR", value: "11222333000181" },
      ],
    };
    const authorityIdentifier = {
      rawRecordId: "raw-pncp-1",
      companyId: "company-pncp-1",
      scheme: "br-cnpj",
      jurisdiction: "BR",
      normalizedValue: "11222333000181",
      authorityProviderKey: "brazil_pncp",
      status: "ACTIVE",
      validatorVersion: "cnpj-v1",
    };
    const results = [
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedKeyword: "manutenção",
          paginationEvidence: { proved: true },
          procurementEvidence: [authorityRaw],
          identifiers: [authorityIdentifier],
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedKeyword: "equipamento",
          paginationEvidence: { proved: false },
          procurementEvidence: [
            { controlNumber: "B-2", companyName: "Buyer B" },
          ],
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "zero",
          paginationEvidence: { proved: false },
          procurementEvidence: [],
        },
      },
    ];
    expect(brazilPncpMatrixVerdict(results, 3)).toEqual({
      allCasesPassed: true,
      paginationProved: true,
      positiveDiversityProved: true,
      authorityIdentityProved: true,
      verdict: "PASS",
    });
    const repeated = structuredClone(results);
    (
      repeated[1]!.evidence.procurementEvidence[0] as { companyName: string }
    ).companyName = "Buyer A";
    expect(brazilPncpMatrixVerdict(repeated, 3).verdict).toBe("FAIL");
    const claimFree = structuredClone(results);
    claimFree[0]!.evidence.procurementEvidence = [
      {
        rawRecordId: "raw-pncp-1",
        canonicalCompanyId: "company-pncp-1",
        controlNumber: "A-1",
        companyName: "Buyer A",
      },
    ];
    expect(brazilPncpMatrixVerdict(claimFree, 3)).toMatchObject({
      authorityIdentityProved: false,
      verdict: "FAIL",
    });
    const crossRaw = structuredClone(results);
    crossRaw[0]!.evidence.identifiers = [
      { ...authorityIdentifier, rawRecordId: "raw-pncp-other" },
    ];
    expect(brazilPncpMatrixVerdict(crossRaw, 3)).toMatchObject({
      authorityIdentityProved: false,
      verdict: "FAIL",
    });
  });

  it("binds each PNCP matrix result to its live case contract and labels zero controls separately", () => {
    const [positive, , zero] = brazilPncpCanaryMatrix({});
    expect(positive).toBeDefined();
    expect(zero).toBeDefined();
    const base = {
      canaryKey: "brazil_pncp",
      requestedCountry: "BR",
      sourceDataMode: "live-official-http",
      modelMode: "stub",
      modelScoringProved: false,
      sourceUrls: [
        "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta?dataFinal=20260814",
      ],
    };
    const positiveEvidence = {
      ...base,
      verdict: "PASS",
      canaryCaseId: positive!.id,
      expectation: positive!.expect,
      requestedState: positive!.state,
      requestedKeyword: positive!.keyword,
      requestedLimit: positive!.limit,
      positiveChannelProved: true,
      counts: { acceptedRaw: 1 },
      procurementEvidence: [{ controlNumber: "11222333000181-1-000001/2026" }],
    };
    expect(
      brazilPncpMatrixCaseEvidenceIsValid(positiveEvidence, positive!),
    ).toBe(true);
    for (const tampered of [
      { verdict: "CONTROL_PASS" },
      { canaryCaseId: "wrong-case" },
      { requestedKeyword: "wrong-keyword" },
      { requestedState: "SP" },
      { requestedLimit: positive!.limit + 1 },
      { sourceDataMode: "mock" },
      { modelMode: "mock-provider" },
      { counts: { acceptedRaw: 0 } },
      { sourceUrls: ["https://example.test/not-pncp"] },
    ]) {
      expect(
        brazilPncpMatrixCaseEvidenceIsValid(
          { ...positiveEvidence, ...tampered },
          positive!,
        ),
      ).toBe(false);
    }

    const zeroEvidence = {
      ...base,
      verdict: "CONTROL_PASS",
      canaryCaseId: zero!.id,
      expectation: zero!.expect,
      requestedState: zero!.state,
      requestedKeyword: zero!.keyword,
      requestedLimit: zero!.limit,
      positiveChannelProved: false,
      counts: { acceptedRaw: 0 },
      procurementEvidence: [],
      sourceUrls: [],
    };
    expect(brazilPncpMatrixCaseEvidenceIsValid(zeroEvidence, zero!)).toBe(true);
    expect(
      brazilPncpMatrixCaseEvidenceIsValid(
        { ...zeroEvidence, verdict: "PASS" },
        zero!,
      ),
    ).toBe(false);
  });

  it("defines two distinct World Bank buyer searches plus one deterministic zero control", () => {
    const matrix = worldBankCanaryMatrix({});
    const positives = matrix.filter((item) => item.expect === "nonzero");
    const zeros = matrix.filter((item) => item.expect === "zero");

    expect(positives).toHaveLength(2);
    expect(matrix.map((item) => item.limit)).toEqual([10, 1, 1]);
    expect(positives.map((item) => item.country)).toEqual([
      "Kenya",
      "Bangladesh",
    ]);
    expect(new Set(positives.map((item) => item.country)).size).toBe(2);
    expect(new Set(positives.map((item) => item.keyword)).size).toBe(2);
    expect(
      positives.every(
        (item) => item.claim === "buyer_or_implementing_agency_sample",
      ),
    ).toBe(true);
    expect(zeros).toEqual([
      expect.objectContaining({
        claim: "zero_result_control",
        keyword: expect.stringMatching(/^codex-canary-no-match-/u),
      }),
    ]);
  });

  it("describes World Bank notices as published or historical research, never an active project claim", () => {
    const signals = worldBankCanaryTriggerSignals();
    expect(signals).toEqual([
      "published procurement notice research",
      "historical procurement buyer evidence",
    ]);
    expect(signals.join(" ").toLocaleLowerCase("en-US")).not.toContain(
      "active",
    );
  });

  it("accepts a validated configurable World Bank matrix and rejects misleading configurations", () => {
    const configured = JSON.stringify([
      {
        id: "one",
        country: " Colombia ",
        keyword: " water ",
        limit: 3,
        expect: "nonzero",
      },
      {
        id: "two",
        country: " Indonesia ",
        keyword: " solar ",
        limit: 1,
        expect: "nonzero",
      },
      {
        id: "zero",
        country: "Codex-Nowhere-Custom",
        keyword: "codex-canary-no-match-custom",
        limit: 1,
        expect: "zero",
      },
    ]);
    expect(
      worldBankCanaryMatrix({
        ACQUISITION_WORLD_BANK_MATRIX_CASES: configured,
      }),
    ).toMatchObject([
      {
        id: "one",
        country: "Colombia",
        keyword: "water",
        limit: 3,
        expect: "nonzero",
      },
      {
        id: "two",
        country: "Indonesia",
        keyword: "solar",
        limit: 1,
        expect: "nonzero",
      },
      {
        id: "zero",
        country: "Codex-Nowhere-Custom",
        keyword: "codex-canary-no-match-custom",
        limit: 1,
        expect: "zero",
      },
    ]);
    expect(() =>
      worldBankCanaryMatrix({
        ACQUISITION_WORLD_BANK_MATRIX_CASES: JSON.stringify([
          {
            id: "one",
            country: "Colombia",
            keyword: "water",
            limit: 26,
            expect: "nonzero",
          },
          {
            id: "two",
            country: "Indonesia",
            keyword: "solar",
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "zero",
            country: "Codex-Nowhere-Custom",
            keyword: "codex-canary-no-match-custom",
            limit: 1,
            expect: "zero",
          },
        ]),
      }),
    ).toThrow(/business limit/u);
    expect(() =>
      worldBankCanaryMatrix({
        ACQUISITION_WORLD_BANK_MATRIX_CASES: JSON.stringify([
          {
            id: "one",
            country: "Colom\nbia",
            keyword: "water",
            limit: 3,
            expect: "nonzero",
          },
          {
            id: "two",
            country: "Indonesia",
            keyword: "solar",
            limit: 1,
            expect: "nonzero",
          },
          {
            id: "zero",
            country: "Codex-Nowhere-Custom",
            keyword: "codex-canary-no-match-custom",
            limit: 1,
            expect: "zero",
          },
        ]),
      }),
    ).toThrow(/printable characters/u);
    expect(() =>
      worldBankCanaryMatrix({
        ACQUISITION_WORLD_BANK_MATRIX_CASES: JSON.stringify([
          { id: "one", country: "Kenya", keyword: "water", expect: "nonzero" },
          { id: "two", country: "Kenya", keyword: "solar", expect: "nonzero" },
          {
            id: "zero",
            country: "Kenya",
            keyword: "not-actually-deterministic",
            expect: "zero",
          },
        ]),
      }),
    ).toThrow(/distinct countries|deterministic zero/u);
  });

  it("reads World Bank buyer facts without promoting a project name to organization identity", () => {
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Nairobi Water Agency",
          country: "Kenya",
          attributes: {
            source_role: "procurement_buyer_or_implementing_agency",
            signal_stage: "published_notice",
            procurement: {
              notice_id: "WB-123",
              title: "Supply of water pumps",
              project_id: "P123",
              project_name: "Urban Water Project",
              project_country: "Rwanda",
              method: "Request for Bids",
            },
          },
        },
        ["water"],
      ),
    ).toEqual({
      companyName: "Nairobi Water Agency",
      country: "Kenya",
      sourceRole: "procurement_buyer_or_implementing_agency",
      signalStage: "published_notice",
      noticeId: "WB-123",
      title: "Supply of water pumps",
      projectId: "P123",
      projectName: "Urban Water Project",
      projectCountry: "Rwanda",
      method: "Request for Bids",
      deadline: undefined,
      positiveKeywordMatch: true,
      projectNameWasPromoted: false,
    });
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Urban Water Project",
          attributes: {
            procurement: {
              project_name: "Urban Water Project",
              title: "Water works",
            },
          },
        },
        ["water"],
      ).projectNameWasPromoted,
    ).toBe(true);
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Nairobi Utility",
          attributes: {
            procurement: {
              project_name: "Urban Services",
              title: "Supply of industrial pumps",
            },
          },
        },
        ["water pump"],
      ).positiveKeywordMatch,
    ).toBe(true);
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Pump Authority",
          attributes: {
            procurement: {
              project_name: "Urban Services",
              title: "General equipment",
            },
          },
        },
        ["water pump"],
      ).positiveKeywordMatch,
    ).toBe(true);
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Pumping Authority",
          attributes: {
            procurement: {
              project_name: "Urban Services",
              title: "General equipment",
            },
          },
        },
        ["water pump"],
      ).positiveKeywordMatch,
    ).toBe(false);
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Roads Authority",
          attributes: {
            procurement: {
              project_name: "Transport Programme",
              title: "Bridge construction",
            },
          },
        },
        ["water pump"],
      ).positiveKeywordMatch,
    ).toBe(false);
    expect(
      readWorldBankCanaryEvidence(
        {
          name: "Roads Authority",
          attributes: {
            procurement: {
              project_name: "Transport Programme",
              title: "Construction of bridge",
            },
          },
        },
        ["supply of water pumps"],
      ).positiveKeywordMatch,
    ).toBe(false);
  });

  it("proves World Bank live pagination only from an accepted official offset URL", () => {
    expect(
      worldBankPaginationEvidence(
        [
          "https://search.worldbank.org/api/v2/procnotices?format=json&rows=5&os=0&qterm=water",
          "https://search.worldbank.org/api/v2/procnotices?format=json&rows=5&os=5&qterm=water",
        ],
        {},
      ),
    ).toEqual({
      acceptedContinuation: true,
      paginationTruncated: false,
      proved: true,
    });
    expect(
      worldBankPaginationEvidence(
        [
          "https://evil.example/api/v2/procnotices?os=5",
          "https://search.worldbank.org/api/v2/procnotices?os=0",
        ],
        { perSource: { public_intelligence: { paginationTruncated: true } } },
      ),
    ).toEqual({
      acceptedContinuation: false,
      paginationTruncated: true,
      proved: false,
    });
  });

  it("distinguishes truthful diagnostics from the stricter positive canary status", () => {
    expect(worldBankRunStatusIsTruthful("DONE", {})).toBe(true);
    expect(
      worldBankRunStatusIsTruthful("PARTIAL", {
        dataQualityBlocked: true,
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toBe(true);
    expect(
      worldBankRunStatusIsTruthful("PARTIAL", {
        dataQualityBlocked: false,
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toBe(false);
    expect(
      worldBankRunStatusIsTruthful("DONE", {
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toBe(false);
    expect(worldBankPositiveRunCanPass("DONE", {})).toBe(true);
    expect(
      worldBankPositiveRunCanPass("PARTIAL", {
        dataQualityBlocked: true,
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toBe(false);
    expect(
      worldBankPositiveRunCanPass("DONE", {
        perSource: { public_intelligence: { paginationTruncated: true } },
      }),
    ).toBe(false);
  });

  it("requires one successful DONE quality contribution for a positive World Bank canary", () => {
    const done = {
      providerKey: "world_bank_procurement",
      terminalStatus: "DONE",
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 0,
      failureCount: 0,
      rawCount: 2,
      acceptedCount: 2,
      boundCount: 2,
      conflictCount: 0,
    };
    expect(
      worldBankPositiveQualityCanPass([done], "world_bank_procurement", 2),
    ).toBe(true);
    expect(
      worldBankPositiveQualityCanPass(
        [
          {
            ...done,
            terminalStatus: "PARTIAL",
            successCount: 0,
            failureCount: 1,
          },
        ],
        "world_bank_procurement",
        2,
      ),
    ).toBe(false);
    expect(
      worldBankPositiveQualityCanPass(
        [{ ...done, successCount: 1, failureCount: 1 }],
        "world_bank_procurement",
        2,
      ),
    ).toBe(false);
  });

  it("accepts the exact two-step SEC quality row plus truthful companion fit-evidence zero results", () => {
    const sec = {
      providerKey: "sec_edgar",
      terminalStatus: "DONE",
      attemptedCount: 2,
      successCount: 2,
      zeroResultCount: 0,
      failureCount: 0,
      failedRunCount: 0,
      processedCount: 2,
      rawCount: 2,
      acceptedCount: 2,
      boundCount: 2,
      domainCount: 0,
      authorityCount: 2,
      conflictCount: 0,
      duplicateCount: 0,
    };
    const companion = (providerKey: string) => ({
      providerKey,
      terminalStatus: "DONE",
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 1,
      failureCount: 0,
      failedRunCount: 0,
      processedCount: 0,
      rawCount: 0,
      acceptedCount: null,
      boundCount: null,
      domainCount: null,
      authorityCount: null,
      conflictCount: null,
      duplicateCount: 0,
    });
    const rows = [
      sec,
      companion("gleif"),
      companion("wikidata"),
      companion("digital_footprint"),
    ];
    expect(secEdgarQualityCanPass(rows)).toBe(true);
    expect(secEdgarQualityCanPass(rows.slice(0, 3))).toBe(false);
    expect(
      secEdgarQualityCanPass([{ ...sec, rawCount: 1 }, ...rows.slice(1)]),
    ).toBe(false);
    expect(
      secEdgarQualityCanPass([
        sec,
        { ...companion("gleif"), zeroResultCount: 0 },
        ...rows.slice(2),
      ]),
    ).toBe(false);
  });

  it("requires every World Bank case and matrix-level continuation proof", () => {
    const results = [
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedCountry: "Kenya",
          requestedKeyword: "water",
          procurementEvidence: [{ noticeId: "WB-1" }],
          paginationEvidence: { proved: false },
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "nonzero",
          requestedCountry: "India",
          requestedKeyword: "solar",
          procurementEvidence: [{ noticeId: "WB-2" }],
          paginationEvidence: { proved: true },
        },
      },
      {
        status: "PASS",
        evidence: {
          expectation: "zero",
          paginationEvidence: { proved: false },
        },
      },
    ];
    expect(worldBankMatrixVerdict(results, 3)).toEqual({
      allCasesPassed: true,
      paginationProved: true,
      positiveDiversityProved: true,
      verdict: "PASS",
    });
    expect(worldBankMatrixVerdict(results.slice(0, 1), 3).verdict).toBe("FAIL");
    expect(
      worldBankCanaryOverrides({
        ACQUISITION_CANARY_COUNTRY: " Ghana ",
        ACQUISITION_CANARY_KEYWORD: " solar ",
        ACQUISITION_CANARY_LIMIT: " 2 ",
      }),
    ).toEqual({ country: "Ghana", keyword: "solar", limit: 2 });
    expect(worldBankCanaryOverrides({})).toEqual({
      country: "Kenya",
      keyword: "water pump",
      limit: 25,
    });
    expect(() =>
      worldBankCanaryOverrides({ ACQUISITION_CANARY_LIMIT: "0" }),
    ).toThrow(/business limit/u);
    expect(worldBankCanaryExpectation(" ZERO ")).toBe("zero");
    expect(() => worldBankCanaryExpectation("maybe")).toThrow(
      /must be nonzero or zero/u,
    );
  });

  it("accepts exactly one complete zero-result quality row and rejects duplicates", () => {
    const row = {
      providerKey: "world_bank_procurement",
      terminalStatus: "DONE",
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 1,
      failureCount: 0,
      rawCount: 0,
      acceptedCount: 0,
      boundCount: 0,
      conflictCount: 0,
    };

    expect(zeroResultQualityCanPass([row], "world_bank_procurement")).toBe(
      true,
    );
    expect(zeroResultQualityCanPass([row, row], "world_bank_procurement")).toBe(
      false,
    );
    expect(
      zeroResultQualityCanPass(
        [{ ...row, zeroResultCount: 0 }],
        "world_bank_procurement",
      ),
    ).toBe(false);
  });
});
