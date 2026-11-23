import { buildContactEnrichmentQualityResult } from "./contact-enrichment-results.dto";
import type { EnrichmentRuntimeExecutionRecord } from "./enrichment-safety.contract";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { TokenVerifier } from "../../auth/token-verifier";
import { ROLES_TO_SCOPES_POLICY } from "../../auth/scopes";
import "reflect-metadata";
import { Module, VersioningType } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AuthGuard } from "../../auth/auth.guard";
import { ScopesGuard } from "../../auth/scopes.guard";
import {
  ContactEnrichmentResultsController,
  CONTACT_ENRICHMENT_RESULTS_PORT,
} from "./contact-enrichment-results.controller";
import { DiscoveryModule } from "../../discovery/discovery.module";
import { CONTACT_ENRICHMENT_SAFETY_EXECUTOR } from "../../discovery/enrich-contacts.service";
import { describe, expect, it, vi } from "vitest";
import {
  CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA,
  parseContactEnrichmentQualityResult,
} from "./contact-enrichment-results.dto";
const COMPANY = "00000000-0000-4000-8000-000000000002",
  CONTACT = "00000000-0000-4000-8000-000000000003",
  POINT = "00000000-0000-4000-8000-000000000004",
  ATTEMPT = "00000000-0000-4000-8000-000000000005";
export function resultFixture() {
  return {
    version: 1,
    protocolVersion: 1,
    operationRef: "a".repeat(64),
    companyId: COMPANY,
    entrypoint: "http",
    businessRunId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "APPLY_PENDING",
    resultRevision: 1,
    qualityCoverage: "PREREQUISITE_ONLY",
    summary: {
      consideredUniqueContacts: 1,
      eligibleUniqueContacts: 1,
      stockValidPersonalContacts: null,
      physicallyAttemptedUniqueContacts: null,
      newCandidatePoints: 1,
      newValidPersonalContacts: null,
      unresolvedUniqueContacts: null,
      skippedByReason: [],
    },
    perContact: [
      {
        contactId: CONTACT,
        reasonCode: "STORED",
        beforeStates: [],
        afterStates: ["UNKNOWN"],
        pointRefs: [POINT],
        eventRefs: [],
        attemptRefs: [ATTEMPT],
        newCandidate: true,
        newValidPersonal: null,
      },
    ],
    spend: {
      quotedUpperBoundMicrousd: "3480",
      knownChargedMicrousd: "1780",
      unknownUpperBoundMicrousd: "1700",
      costBasis: "estimated_upper_bound",
    },
    unavailableMetrics: [
      "stockValidPersonalContacts",
      "physicallyAttemptedUniqueContacts",
      "newValidPersonalContacts",
      "unresolvedUniqueContacts",
    ],
  };
}
describe("bounded prerequisite-only result metadata schema, not full-quality or SQL proof", () => {
  it("preserves exact ledger micro strings and truthful unavailable quality fields", () => {
    const source = resultFixture();
    expect(parseContactEnrichmentQualityResult(source)).toEqual(source);
    expect(
      Object.isFrozen(parseContactEnrichmentQualityResult(source).summary),
    ).toBe(true);
  });
  it("can disclose proven physical/unresolved metadata without inventing full quality", () => {
    const source = resultFixture();
    Object.assign(source.summary, {
      physicallyAttemptedUniqueContacts: 1,
      unresolvedUniqueContacts: 0,
    });
    source.unavailableMetrics = [
      "stockValidPersonalContacts",
      "newValidPersonalContacts",
    ];
    expect(parseContactEnrichmentQualityResult(source).summary).toMatchObject({
      physicallyAttemptedUniqueContacts: 1,
      unresolvedUniqueContacts: 0,
      newValidPersonalContacts: null,
    });
  });
  it("publishes a closed code-first object with explicit constant and nullable quality fields", () => {
    const schema =
      CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA as unknown as Record<
        string,
        unknown
      >;
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.qualityCoverage).toEqual(
      expect.objectContaining({ enum: ["PREREQUISITE_ONLY"] }),
    );
    expect(Object.keys(properties).sort()).toEqual(
      Object.keys(resultFixture()).sort(),
    );
  });
  it.each(["stockValidPersonalContacts", "newValidPersonalContacts"])(
    "rejects a fabricated zero/full-quality %s",
    (field) => {
      const source = resultFixture();
      Object.assign(source.summary, { [field]: 0 });
      expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    },
  );
  it.each([
    "accountKey",
    "authorityId",
    "objectKey",
    "durableReceipt",
    "email",
    "fullName",
  ])("rejects private or PII top-level %s", (key) => {
    expect(() =>
      parseContactEnrichmentQualityResult({
        ...resultFixture(),
        [key]: "PII_SENTINEL_DO_NOT_EXPOSE",
      }),
    ).toThrow();
  });
  it("does not suppress an unknown spend or turn it into a provider invoice", () => {
    const source = resultFixture();
    source.spend.costBasis = "provider_invoice" as never;
    expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    const missing = resultFixture();
    delete (missing.spend as Partial<typeof missing.spend>)
      .unknownUpperBoundMicrousd;
    expect(() => parseContactEnrichmentQualityResult(missing)).toThrow();
  });
  it.each(["01", "-1", "1.78", "1780 ", "9223372036854775808"])(
    "rejects noncanonical/out-of-range micro %s",
    (micro) => {
      const source = resultFixture();
      source.spend.knownChargedMicrousd = micro;
      expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    },
  );
  it("rejects duplicate/truncated per-contact rows and inconsistent frozen-subset denominator", () => {
    const source = resultFixture();
    source.perContact.push(source.perContact[0]!);
    expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    const wrong = resultFixture();
    wrong.summary.consideredUniqueContacts = 2;
    expect(() => parseContactEnrichmentQualityResult(wrong)).toThrow();
    const huge = resultFixture();
    huge.perContact = Array.from(
      { length: 11 },
      () => resultFixture().perContact[0]!,
    );
    expect(() => parseContactEnrichmentQualityResult(huge)).toThrow();
  });
  it("requires unavailableMetrics to match precisely the fields that were not proven", () => {
    const source = resultFixture();
    source.unavailableMetrics = [];
    expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
  });
  it("rejects nested raw payloads and getters without evaluating them", () => {
    const source = resultFixture();
    Object.assign(source.perContact[0]!, { rawDetail: "PII_SENTINEL" });
    expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    const read = vi.fn(() => "PII_SENTINEL");
    const value = resultFixture();
    Object.defineProperty(value, "summary", { enumerable: true, get: read });
    expect(() => parseContactEnrichmentQualityResult(value)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("actual code-first Swagger from an isolated synthetic module, no listen", () => {
  it("generates exact read/recover routes, scopes and closed prerequisite-only result schema without a Grant requirement", async () => {
    const forbidden = vi.fn(async () => {
      throw new Error("code_first_must_not_access_runtime_ports");
    });
    const verifier = { verify: forbidden };
    const policy = { resolve: () => [] };
    @Module({
      controllers: [ContactEnrichmentResultsController],
      providers: [
        {
          provide: CONTACT_ENRICHMENT_RESULTS_PORT,
          useValue: {
            listEnrichmentExecutions: forbidden,
            readEnrichmentExecution: forbidden,
            recoverEnrichmentExecution: forbidden,
          },
        },
        { provide: TokenVerifier, useValue: verifier },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
        {
          provide: AuthGuard,
          useValue: new AuthGuard(verifier as never, policy),
        },
        { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
      ],
    })
    class SyntheticResultsModule {}
    const app = await NestFactory.create(SyntheticResultsModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      app.setGlobalPrefix("api");
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      );
      const path =
        "/api/v1/canonical-companies/{id}/contact-enrichment-results";
      const list = document.paths[path]?.get,
        read = document.paths[path + "/{operationRef}"]?.get,
        recover = document.paths[path + "/{operationRef}/recover"]?.post;
      expect(list?.operationId).toBe("listContactEnrichmentResults_v1");
      expect(read?.operationId).toBe("readContactEnrichmentResult_v1");
      expect(recover?.operationId).toBe("recoverContactEnrichmentResult_v1");
      expect(list?.["x-required-scopes"]).toEqual(
        expect.arrayContaining(["acquisition:read", "contact-discovery:read"]),
      );
      expect(recover?.["x-required-scopes"]).toEqual(
        expect.arrayContaining([
          "acquisition:write",
          "contact-discovery:read",
          "compliance:manage",
        ]),
      );
      expect(JSON.stringify(recover?.parameters ?? [])).not.toMatch(
        /execution-budget|grant/i,
      );
      expect(JSON.stringify(read?.responses)).toContain("PREREQUISITE_ONLY");
      expect(JSON.stringify(read?.responses)).toContain(
        '"additionalProperties":false',
      );
      expect(Object.keys(document.paths)).toHaveLength(3);
      expect(forbidden).not.toHaveBeenCalled();
      expect(app.getHttpServer().listening).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("result metadata counterexamples for uncertain money and foreign references", () => {
  it.each(["knownChargedMicrousd", "unknownUpperBoundMicrousd"] as const)(
    "never accepts %s above the original total quote merely because the other amount is unknown",
    (key) => {
      const source = resultFixture();
      Object.assign(source.spend, {
        knownChargedMicrousd: null,
        unknownUpperBoundMicrousd: null,
        [key]: "3481",
      });
      expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    },
  );
  it.each(["pointRefs", "eventRefs", "attemptRefs"] as const)(
    "never attributes one immutable %s identity to different contacts",
    (key) => {
      const source = resultFixture();
      source.summary.consideredUniqueContacts = 2;
      source.summary.eligibleUniqueContacts = 2;
      source.summary.newCandidatePoints = 2;
      const first = {
        ...source.perContact[0]!,
        pointRefs: ["00000000-0000-4000-8000-000000000011"],
        eventRefs: ["00000000-0000-4000-8000-000000000012"],
        attemptRefs: ["00000000-0000-4000-8000-000000000013"],
      };
      const second = {
        ...first,
        contactId: "00000000-0000-4000-8000-000000000014",
        pointRefs: ["00000000-0000-4000-8000-000000000015"],
        eventRefs: ["00000000-0000-4000-8000-000000000016"],
        attemptRefs: ["00000000-0000-4000-8000-000000000017"],
      };
      second[key] = first[key];
      source.perContact = [first, second] as never;
      expect(() => parseContactEnrichmentQualityResult(source)).toThrow();
    },
  );
  it("can redact live identities without rewriting aggregate audit counts or the original spend", () => {
    const source = resultFixture();
    source.status = "REDACTED";
    source.perContact = [];
    const result = parseContactEnrichmentQualityResult(source);
    expect(result.summary.newCandidatePoints).toBe(1);
    expect(result.summary.consideredUniqueContacts).toBe(1);
    expect(result.perContact).toEqual([]);
    expect(result.spend).toEqual(source.spend);
  });
});


function persistedMetadataWorld(kind: 'empty' | 'unknown' | 'settled' | 'redacted' = 'empty'): EnrichmentRuntimeExecutionRecord {
  const ws = '00000000-0000-4000-8000-000000000001', authorityId = '00000000-0000-4000-8000-000000000006', accountId = '00000000-0000-4000-8000-000000000007', executionId = '00000000-0000-4000-8000-000000000008', operationId = '00000000-0000-4000-8000-000000000009';
  const plan = buildFrozenEnrichmentPlan({ workspaceId: ws, companyId: COMPANY, entrypoint: 'http', businessRunId: null, requestSha256: 'a'.repeat(64), admittedAtMs: 1000, deadlineAtMs: 601000, targets: [{ contactId: CONTACT, contactOrdinal: 0, inputVersion: 'a'.repeat(64), beforeDigest: 'b'.repeat(64), pointRefs: [] }], slots: [{ slotKey: 'finder', contactId: CONTACT, contactOrdinal: 0, phase: 'FINDER', provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null }], limits: { authorityCapMicrousd: '500000', companyCapMicrousd: '500000', contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 } });
  const paid = kind === 'settled' || kind === 'redacted';
  const reference = { schemaVersion: 'generic-operation-artifact-ref/v1', operationId, artifactId: '00000000-0000-4000-8000-000000000010', resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' };
  const decision = { status: 'APPLIED', contactId: CONTACT, reasonCode: 'STORED', state: 'UNKNOWN', pointRefs: [POINT], eventRefs: [], attemptRefs: [ATTEMPT], newCandidatePoints: 1 };
  return { view: { executionId, operationRef: 'a'.repeat(64), planSha256: plan.planSha256, status: kind === 'redacted' ? 'REDACTED' : paid ? 'COMPLETED' : kind === 'unknown' ? 'RESULT_UNKNOWN' : 'PREPARED', accountId, authorityId, generation: 1 }, workspaceId: ws, companyId: COMPANY, entrypoint: 'http', businessRunId: null, requestSha256: plan.requestSha256, admissionRequestSha256: 'c'.repeat(64), accountKey: 'original-key', currentAccount: { accountId, authorityId, generation: 1 }, plan: kind === 'redacted' ? null : plan, targetCount: 1, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' }, createdAt: '2026-11-22T00:00:00.000Z', resultRevision: 1, resultSnapshot: paid ? { version: 1, targetCount: 1, newCandidatePoints: 1, contacts: kind === 'redacted' ? [] : [decision] } : null,
    steps: [{ id: '00000000-0000-4000-8000-000000000011', workspace_id: ws, company_id: COMPANY, execution_id: executionId, contact_id: kind === 'redacted' ? null : CONTACT, contact_ordinal: 0, slot_key: 'finder', phase: 'FINDER', provider: 'hunter', tool_id: 'contact_email.find.hunter', tool_version: '1.0.0', quote_microusd: 1700n, pricing_version: 'p1', depends_on_slot_key: null, input_fingerprint: null, operation_key: paid || kind === 'unknown' ? 'original-operation-key' : null, budget_operation_id: paid || kind === 'unknown' ? operationId : null, candidate_ref: null, revision: 1, dispatch_phase: kind === 'unknown' ? 'RESULT_UNKNOWN' : paid ? 'SETTLED' : 'ADMITTED', domain_state: kind === 'redacted' ? 'REDACTED' : paid ? 'APPLIED' : 'PENDING', authority_id: authorityId, account_id: accountId, generation: 1, account_key: 'original-key', execution_status: 'PREPARED', deadline_open: false,
      budget_original_id: paid || kind === 'unknown' ? operationId : null, budget_status: kind === 'unknown' ? 'RESULT_UNKNOWN' : paid ? 'SETTLED' : null, budget_amount_unit: paid || kind === 'unknown' ? 'microusd' : null, budget_reserved_microusd: paid || kind === 'unknown' ? 1700n : null, budget_charged_microusd: paid ? 1700n : null, budget_result_schema: paid ? 'contact-email-find-hunter/v1' : null, budget_result_digest: paid ? 'b'.repeat(64) : null, budget_result_json: paid ? reference : null, budget_receipt_usage: paid ? { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' } : null, budget_receipt_cost_basis: paid ? 'estimated_upper_bound' : null }],
  } as EnrichmentRuntimeExecutionRecord;
}
describe('scoped persistent metadata derivation from original ledger facts, no bodies', () => {
  it('keeps an admitted not-yet-dispatched operation distinct from a paid miss or success', () => {
    const result = buildContactEnrichmentQualityResult(persistedMetadataWorld()); expect(result).toMatchObject({ qualityCoverage: 'PREREQUISITE_ONLY', status: 'PREPARED', summary: { consideredUniqueContacts: 1, physicallyAttemptedUniqueContacts: 0, newCandidatePoints: 0 }, spend: { quotedUpperBoundMicrousd: '1700', knownChargedMicrousd: '0', unknownUpperBoundMicrousd: '0' } }); expect(result.perContact[0]?.reasonCode).toBe('PENDING');
  });
  it('preserves the original unknown upper bound and never relabels it a free miss', () => {
    const result = buildContactEnrichmentQualityResult(persistedMetadataWorld('unknown')); expect(result.spend).toMatchObject({ knownChargedMicrousd: '0', unknownUpperBoundMicrousd: '1700' }); expect(result.summary.physicallyAttemptedUniqueContacts).toBeNull(); expect(result.perContact[0]?.reasonCode).toBe('RESULT_UNKNOWN');
  });
  it('uses only the committed original decision and original ledger charge for one candidate', () => {
    const record = persistedMetadataWorld('settled'), result = buildContactEnrichmentQualityResult(record); expect(result.summary).toMatchObject({ newCandidatePoints: 1, physicallyAttemptedUniqueContacts: 1, newValidPersonalContacts: null }); expect(result.spend).toMatchObject({ knownChargedMicrousd: '1700', unknownUpperBoundMicrousd: '0' }); expect(result.perContact[0]).toMatchObject({ pointRefs: [POINT], afterStates: ['UNKNOWN'], newCandidate: true }); expect(JSON.stringify(result)).not.toMatch(/original-key|durableReceipt|artifactId|operationId|objectKey/);
  });
  it('can read original audit metadata after account generation changes without attestation or query rewriting', () => { const record = persistedMetadataWorld('settled'); Object.assign(record.currentAccount, { generation: 2 }); expect(buildContactEnrichmentQualityResult(record).spend.knownChargedMicrousd).toBe('1700'); });
  it('keeps redacted aggregate counts and original charges while every personal reference is absent', () => { const result = buildContactEnrichmentQualityResult(persistedMetadataWorld('redacted')); expect(result.perContact).toEqual([]); expect(result.summary.consideredUniqueContacts).toBe(1); expect(result.summary.newCandidatePoints).toBe(1); expect(result.spend.knownChargedMicrousd).toBe('1700'); expect(JSON.stringify(result)).not.toContain(CONTACT); });
  it('rejects a duplicate original operation instead of double-counting its money', () => { const record = persistedMetadataWorld('settled'); Object.assign(record, { steps: [record.steps[0], record.steps[0]] }); expect(() => buildContactEnrichmentQualityResult(record)).toThrow(); });
  it('rejects foreign/extra-data persisted decisions instead of turning them into public proof', () => { for (const patch of [{ contactId: COMPANY }, { email: 'PII_SENTINEL' }]) { const record = persistedMetadataWorld('settled'); const snapshot = record.resultSnapshot as { contacts: Record<string, unknown>[] }; Object.assign(snapshot.contacts[0]!, patch); expect(() => buildContactEnrichmentQualityResult(record)).toThrow(); } });
});

describe("real DiscoveryModule assembly metadata", () => {
  it("registers the results controller and binds its port to the real safety executor", () => {
    const controllers = (Reflect.getMetadata("controllers", DiscoveryModule) ?? []) as unknown[];
    expect(controllers).toContain(ContactEnrichmentResultsController);
    const providers = (Reflect.getMetadata("providers", DiscoveryModule) ?? []) as unknown[];
    const binding = providers.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { provide?: unknown }).provide === CONTACT_ENRICHMENT_RESULTS_PORT,
    ) as { provide?: unknown; useExisting?: unknown } | undefined;
    expect(binding).toBeDefined();
    expect(binding?.useExisting).toBe(CONTACT_ENRICHMENT_SAFETY_EXECUTOR);
  });
});
