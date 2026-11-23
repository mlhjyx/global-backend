import { describe, expect, it } from "vitest";
import {
  buildContactEnrichmentQualityFacts,
  parseContactEnrichmentQualityFacts,
  CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA,
} from "./contact-enrichment-quality-facts.dto";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import type { EnrichmentRuntimeExecutionRecord } from "./enrichment-safety.contract";

const W = "00000000-0000-4000-8000-000000000001";
const C = "00000000-0000-4000-8000-000000000002";
const C1 = "00000000-0000-4000-8000-000000000002";
const C2 = "00000000-0000-4000-8000-000000000003";
const P1 = "00000000-0000-4000-8000-000000000011";
const E1 = "00000000-0000-4000-8000-000000000013";
const A1 = "00000000-0000-4000-8000-000000000014";
const A = "00000000-0000-4000-8000-000000000006";
const ACCOUNT = "00000000-0000-4000-8000-000000000007";
const EXEC = "00000000-0000-4000-8000-000000000008";
const OPERATION = "00000000-0000-4000-8000-000000000009";

function factsFixture() {
  return {
    version: 2,
    protocolVersion: 1,
    operationRef: "a".repeat(64),
    companyId: C,
    entrypoint: "http",
    businessRunId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "APPLY_PENDING",
    resultRevision: 2,
    qualityCoverage: "FULL_QUALITY_FACTS",
    basis: {
      consideredScope: "FROZEN_EXECUTION_TARGETS",
      attributionBasis: "CANONICAL_COMPANY_CONTACT_SCOPE",
      validityBasis: "ORIGINAL_VERIFICATION_RULES",
      sendability: "NOT_IMPLIED",
    },
    summary: {
      consideredUniqueContacts: 2,
      coveredUniqueContacts: 2,
      eligibleUniqueContacts: 2,
      stockValidPersonalContacts: 0,
      organizationChannelContacts: 1,
      unknownEmailTypeContacts: 1,
      physicallyAttemptedUniqueContacts: 1,
      newCandidatePoints: 1,
      newValidPersonalContacts: 0,
      unresolvedUniqueContacts: 1,
      skippedByReason: [{ reasonCode: "DEADLINE", count: 1 }],
    },
    perContact: [
      {
        contactId: C1,
        reasonCode: "STORED",
        committedState: "UNKNOWN",
        beforeStates: [],
        afterStates: ["UNKNOWN"],
        pointRefs: [P1],
        eventRefs: [E1],
        attemptRefs: [A1],
        newCandidate: true,
        newValidPersonal: false,
        stockValidPersonal: false,
        organizationChannel: false,
        unknownEmailType: true,
        eligible: true,
        unresolved: true,
      },
      {
        contactId: C2,
        reasonCode: "DEADLINE",
        committedState: null,
        beforeStates: ["UNKNOWN"],
        afterStates: ["UNKNOWN"],
        pointRefs: [],
        eventRefs: [],
        attemptRefs: [],
        newCandidate: false,
        newValidPersonal: false,
        stockValidPersonal: false,
        organizationChannel: true,
        unknownEmailType: false,
        eligible: true,
        unresolved: false,
      },
    ],
    spend: {
      quotedUpperBoundMicrousd: "3400",
      knownChargedMicrousd: "1700",
      unknownUpperBoundMicrousd: "1700",
      costBasis: "estimated_upper_bound",
    },
    unavailableMetrics: [],
  };
}

describe("complete A01-A07 quality facts projection, closed and versioned", () => {
  it("accepts the complete facts projection with real denominators", () => {
    const source = factsFixture();
    expect(parseContactEnrichmentQualityFacts(source)).toMatchObject({
      version: 2,
      qualityCoverage: "FULL_QUALITY_FACTS",
      summary: {
        consideredUniqueContacts: 2,
        coveredUniqueContacts: 2,
        unresolvedUniqueContacts: 1,
        skippedByReason: [{ reasonCode: "DEADLINE", count: 1 }],
      },
    });
    expect(Object.isFrozen(parseContactEnrichmentQualityFacts(source))).toBe(
      true,
    );
  });
  it("keeps a partial fact set PREREQUISITE_ONLY with null metrics, never zero", () => {
    const source = factsFixture();
    source.summary.consideredUniqueContacts = 3;
    source.summary.coveredUniqueContacts = 2;
    source.qualityCoverage = "PREREQUISITE_ONLY" as never;
    source.perContact.push({
      ...source.perContact[1]!,
      contactId: "00000000-0000-4000-8000-000000000015",
      reasonCode: "PENDING",
      committedState: null,
      beforeStates: null as never,
      pointRefs: [],
      afterStates: null as never,
      newCandidate: null,
      newValidPersonal: null,
      stockValidPersonal: null,
      organizationChannel: null,
      unknownEmailType: null,
      eligible: null,
      unresolved: null,
    });
    source.summary.eligibleUniqueContacts = null as never;
    source.summary.stockValidPersonalContacts = null as never;
    source.summary.organizationChannelContacts = null as never;
    source.summary.unknownEmailTypeContacts = null as never;
    source.summary.newValidPersonalContacts = null as never;
    source.summary.unresolvedUniqueContacts = null as never;
    source.summary.skippedByReason = null as never;
    source.unavailableMetrics = [
      "eligibleUniqueContacts",
      "stockValidPersonalContacts",
      "organizationChannelContacts",
      "unknownEmailTypeContacts",
      "newValidPersonalContacts",
      "unresolvedUniqueContacts",
      "skippedByReason",
    ];
    expect(parseContactEnrichmentQualityFacts(source)).toMatchObject({
      qualityCoverage: "PREREQUISITE_ONLY",
      summary: {
        consideredUniqueContacts: 3,
        coveredUniqueContacts: 2,
        eligibleUniqueContacts: null,
        newCandidatePoints: 1,
      },
    });
  });
  it.each([
    ["a fabricated zero for an uncovered denominator", "eligibleUniqueContacts", 0],
    ["a fabricated unresolved zero", "unresolvedUniqueContacts", 0],
    ["a fabricated stock zero", "stockValidPersonalContacts", 0],
    ["a fabricated new-valid zero", "newValidPersonalContacts", 0],
  ])("rejects %s while coverage is partial", (_label, key, value) => {
    const source = factsFixture();
    source.summary.consideredUniqueContacts = 3;
    source.summary.coveredUniqueContacts = 2;
    source.qualityCoverage = "PREREQUISITE_ONLY" as never;
    (source.summary as Record<string, unknown>)[key] = value;
    expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
  });
  it("never lets a claim of full facts survive an uncovered contact", () => {
    const source = factsFixture();
    source.summary.consideredUniqueContacts = 3;
    source.summary.coveredUniqueContacts = 2;
    expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
  });
  it("requires exact counts for each unique-contact denominator", () => {
    for (const [key, value] of [
      ["eligibleUniqueContacts", 1],
      ["organizationChannelContacts", 2],
      ["unknownEmailTypeContacts", 0],
      ["unresolvedUniqueContacts", 0],
      ["newValidPersonalContacts", 1],
      ["newCandidatePoints", 0],
    ] as const) {
      const source = factsFixture();
      (source.summary as Record<string, unknown>)[key] = value;
      expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
    }
  });
  it("requires skipped reasons to match the covered contacts exactly", () => {
    const source = factsFixture();
    source.summary.skippedByReason = [];
    expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
    const extra = factsFixture();
    extra.summary.skippedByReason = [
      { reasonCode: "DEADLINE", count: 1 },
      { reasonCode: "BUDGET_CAP", count: 1 },
    ];
    expect(() => parseContactEnrichmentQualityFacts(extra)).toThrow();
  });
  it("keeps organization-only and unknown-category contacts out of the personal denominator", () => {
    const source = factsFixture();
    // C2 has only an organization channel, C1 only an unknown-category channel.
    expect(source.summary.stockValidPersonalContacts).toBe(0);
    expect(source.summary.newValidPersonalContacts).toBe(0);
    const result = parseContactEnrichmentQualityFacts(source);
    expect(result.perContact.map((row) => row.stockValidPersonal)).toEqual([
      false,
      false,
    ]);
  });
  it("rejects a personal success that was never a new candidate point", () => {
    const source = factsFixture();
    Object.assign(source.perContact[0]!, {
      newCandidate: false,
      newValidPersonal: true,
      stockValidPersonal: false,
    });
    expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
  });
  it.each([
    ["duplicate contacts", (s: ReturnType<typeof factsFixture>) => s.perContact.push({ ...s.perContact[0]! })],
    ["mixed covered/uncovered quality fields", (s: ReturnType<typeof factsFixture>) => { Object.assign(s.perContact[1]!, { eligible: null }); }],
    ["a raw PII payload", (s: ReturnType<typeof factsFixture>) => { Object.assign(s.perContact[0]!, { email: "PII_SENTINEL" }); }],
  ])("rejects %s", (_label, mutate) => {
    const source = factsFixture();
    mutate(source);
    expect(() => parseContactEnrichmentQualityFacts(source)).toThrow();
  });
  it("keeps redacted executions unavailable while preserving aggregate counts", () => {
    const source = factsFixture();
    source.status = "REDACTED";
    source.perContact = [];
    source.qualityCoverage = "PREREQUISITE_ONLY" as never;
    source.summary.coveredUniqueContacts = 0;
    source.summary.eligibleUniqueContacts = null as never;
    source.summary.stockValidPersonalContacts = null as never;
    source.summary.organizationChannelContacts = null as never;
    source.summary.unknownEmailTypeContacts = null as never;
    source.summary.newValidPersonalContacts = null as never;
    source.summary.unresolvedUniqueContacts = null as never;
    source.summary.skippedByReason = null as never;
    source.unavailableMetrics = [
      "eligibleUniqueContacts",
      "stockValidPersonalContacts",
      "organizationChannelContacts",
      "unknownEmailTypeContacts",
      "newValidPersonalContacts",
      "unresolvedUniqueContacts",
      "skippedByReason",
    ];
    const result = parseContactEnrichmentQualityFacts(source);
    expect(result.summary.consideredUniqueContacts).toBe(2);
    expect(result.summary.newCandidatePoints).toBe(1);
    expect(result.perContact).toEqual([]);
  });
  it("publishes a closed code-first schema with the explicit coverage states", () => {
    const schema = CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA as unknown as Record<
      string,
      unknown
    >;
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.version).toEqual(expect.objectContaining({ enum: [2] }));
    expect(properties.qualityCoverage).toEqual(
      expect.objectContaining({
        enum: ["PREREQUISITE_ONLY", "FULL_QUALITY_FACTS"],
      }),
    );
    expect(JSON.stringify(properties.basis)).toContain(
      "FROZEN_EXECUTION_TARGETS",
    );
    expect(JSON.stringify(properties.basis)).toContain("NOT_IMPLIED");
    expect(JSON.stringify(schema)).not.toMatch(/accountKey|authorityId|artifactId/);
  });
});

function persistedWorld(
  snapshot:
    | { version: 1; targetCount: 1; newCandidatePoints: number; contacts: unknown[] }
    | {
        version: 2;
        targetCount: number;
        newCandidatePoints: number;
        contacts: unknown[];
        quality: { version: 1; contacts: unknown[] };
      }
    | null,
): EnrichmentRuntimeExecutionRecord {
  const plan = buildFrozenEnrichmentPlan({
    workspaceId: W,
    companyId: C,
    entrypoint: "http",
    businessRunId: null,
    requestSha256: "a".repeat(64),
    admittedAtMs: 1000,
    deadlineAtMs: 601000,
    targets: [
      {
        contactId: C1,
        contactOrdinal: 0,
        inputVersion: "a".repeat(64),
        beforeDigest: "b".repeat(64),
        pointRefs: [],
      },
    ],
    slots: [
      {
        slotKey: "finder",
        contactId: C1,
        contactOrdinal: 0,
        phase: "FINDER",
        provider: "hunter",
        toolId: "contact_email.find.hunter",
        toolVersion: "1.0.0",
        quoteMicrousd: "1700",
        pricingVersion: "p1",
        dependsOnSlotKey: null,
      },
    ],
    limits: {
      authorityCapMicrousd: "500000",
      companyCapMicrousd: "500000",
      contactCapMicrousd: "150000",
      finderCompanyMax: 10,
      finderContactMax: 3,
      verifyAddressMax: 6,
      maxContacts: 10,
    },
  });
  const reference = {
    schemaVersion: "generic-operation-artifact-ref/v1",
    operationId: OPERATION,
    artifactId: "00000000-0000-4000-8000-000000000010",
    resultSchema: "contact-email-find-hunter/v1",
    sha256: "b".repeat(64),
    mediaType: "application/octet-stream",
    sizeBytes: "128",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  return {
    view: {
      executionId: EXEC,
      operationRef: "a".repeat(64),
      planSha256: plan.planSha256,
      status: "COMPLETED",
      accountId: ACCOUNT,
      authorityId: A,
      generation: 1,
    },
    workspaceId: W,
    companyId: C,
    entrypoint: "http",
    businessRunId: null,
    requestSha256: plan.requestSha256,
    admissionRequestSha256: "c".repeat(64),
    accountKey: "original-key",
    currentAccount: { accountId: ACCOUNT, authorityId: A, generation: 1 },
    plan,
    targetCount: 1,
    executionOptions: { lawfulBasisKind: "legitimate_interest", tier: "B" },
    createdAt: "2026-11-22T00:00:00.000Z",
    resultRevision: 2,
    resultSnapshot: snapshot,
    steps: [
      {
        id: "00000000-0000-4000-8000-000000000016",
        workspace_id: W,
        company_id: C,
        execution_id: EXEC,
        contact_id: C1,
        contact_ordinal: 0,
        slot_key: "finder",
        phase: "FINDER",
        provider: "hunter",
        tool_id: "contact_email.find.hunter",
        tool_version: "1.0.0",
        quote_microusd: 1700n,
        pricing_version: "p1",
        depends_on_slot_key: null,
        input_fingerprint: null,
        operation_key: "original-operation-key",
        budget_operation_id: OPERATION,
        candidate_ref: null,
        revision: 2,
        dispatch_phase: "SETTLED",
        domain_state: "APPLIED",
        authority_id: A,
        account_id: ACCOUNT,
        generation: 1,
        account_key: "original-key",
        execution_status: "COMPLETED",
        deadline_open: false,
        budget_original_id: OPERATION,
        budget_status: "SETTLED",
        budget_amount_unit: "microusd",
        budget_reserved_microusd: 1700n,
        budget_charged_microusd: 1700n,
        budget_result_schema: "contact-email-find-hunter/v1",
        budget_result_digest: "b".repeat(64),
        budget_result_json: reference,
        budget_receipt_usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          chargedMicrousd: "1700",
          upperBoundMicrousd: "1700",
        },
        budget_receipt_cost_basis: "estimated_upper_bound",
      },
    ],
  } as EnrichmentRuntimeExecutionRecord;
}

describe("read projection from persisted original operation facts", () => {
  it("keeps a legacy version-one snapshot PREREQUISITE_ONLY without filling zeros", () => {
    const result = buildContactEnrichmentQualityFacts(
      persistedWorld({
        version: 1,
        targetCount: 1,
        newCandidatePoints: 1,
        contacts: [
          {
            status: "APPLIED",
            contactId: C1,
            reasonCode: "STORED",
            state: "UNKNOWN",
            pointRefs: [P1],
            eventRefs: [E1],
            attemptRefs: [A1],
            newCandidatePoints: 1,
          },
        ],
      }),
    );
    expect(result.qualityCoverage).toBe("PREREQUISITE_ONLY");
    expect(result.summary.coveredUniqueContacts).toBe(0);
    expect(result.summary.eligibleUniqueContacts).toBeNull();
    expect(result.summary.stockValidPersonalContacts).toBeNull();
    expect(result.summary.unresolvedUniqueContacts).toBeNull();
    expect(result.summary.newValidPersonalContacts).toBeNull();
    expect(result.perContact[0]).toMatchObject({
      contactId: C1,
      reasonCode: "STORED",
      committedState: "UNKNOWN",
      eligible: null,
      unresolved: null,
      newCandidate: true,
    });
  });
  it("derives complete facts from the same-transaction quality block", () => {
    const result = buildContactEnrichmentQualityFacts(
      persistedWorld({
        version: 2,
        targetCount: 1,
        newCandidatePoints: 1,
        contacts: [
          {
            status: "APPLIED",
            contactId: C1,
            reasonCode: "STORED",
            state: "UNKNOWN",
            pointRefs: [P1],
            eventRefs: [E1],
            attemptRefs: [A1],
            newCandidatePoints: 1,
          },
        ],
        quality: {
          version: 1,
          contacts: [
            {
              contactId: C1,
              beforeStates: [],
              afterStates: ["UNKNOWN"],
              stockValidPersonal: false,
              organizationChannel: false,
              emailTypeUnknown: true,
              eligible: true,
              newCandidate: true,
              newValidPersonal: false,
              unresolved: true,
            },
          ],
        },
      }),
    );
    expect(result.qualityCoverage).toBe("FULL_QUALITY_FACTS");
    expect(result.summary).toMatchObject({
      consideredUniqueContacts: 1,
      coveredUniqueContacts: 1,
      eligibleUniqueContacts: 1,
      stockValidPersonalContacts: 0,
      unknownEmailTypeContacts: 1,
      newValidPersonalContacts: 0,
      unresolvedUniqueContacts: 1,
      skippedByReason: [],
    });
    expect(result.perContact[0]).toMatchObject({
      eligible: true,
      newCandidate: true,
      newValidPersonal: false,
      unresolved: true,
      unknownEmailType: true,
    });
  });
  it("rejects a foreign persisted decision row that is not a frozen target", () => {
    const source = persistedWorld({
      version: 2,
      targetCount: 1,
      newCandidatePoints: 0,
      contacts: [
        {
          status: "APPLIED",
          contactId: C2,
          reasonCode: "STORED",
          state: "UNKNOWN",
          pointRefs: [],
          eventRefs: [],
          attemptRefs: [],
          newCandidatePoints: 0,
        },
      ],
      quality: { version: 1, contacts: [] },
    });
    expect(() => buildContactEnrichmentQualityFacts(source)).toThrow();
  });
  it("rejects a persisted quality block that disagrees with the committed decisions", () => {
    const source = persistedWorld({
      version: 2,
      targetCount: 1,
      newCandidatePoints: 1,
      contacts: [
        {
          status: "APPLIED",
          contactId: C1,
          reasonCode: "STORED",
          state: "UNKNOWN",
          pointRefs: [P1],
          eventRefs: [E1],
          attemptRefs: [A1],
          newCandidatePoints: 1,
        },
      ],
      quality: {
        version: 1,
        contacts: [
          {
            contactId: C2,
            beforeStates: [],
            afterStates: ["UNKNOWN"],
            stockValidPersonal: false,
            organizationChannel: false,
            emailTypeUnknown: false,
            eligible: true,
            newCandidate: false,
            newValidPersonal: false,
            unresolved: true,
          },
        ],
      },
    });
    expect(() => buildContactEnrichmentQualityFacts(source)).toThrow();
  });
});
