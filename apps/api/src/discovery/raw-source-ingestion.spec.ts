// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { describe, expect, it } from "vitest";
import {
  RAW_SOURCE_INGEST_VERSION,
  prepareRawSourceBatch,
  rawPayloadHash,
  rawSourceIngestLimits,
  reconcileRawSourceBatch,
  type RawSourcePolicySnapshot,
} from "./raw-source-ingestion";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const LIMITS = Object.freeze({
  maxRecordBytes: 512,
  maxBatchBytes: 1_024,
  defaultRetentionDays: 30,
});
const POLICIES: RawSourcePolicySnapshot[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    domain: "registry.example",
    retentionDays: 90,
    reviewStatus: "APPROVED",
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
  },
];

function companyRecord(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "company-1",
    name: "Acme GmbH",
    domain: "acme.example",
    country: "DE",
    attributes: { products: ["pump"], employee_band: "50-100" },
    provenance: {
      sourceUrl: "https://registry.example/companies/1",
      fetchedAt: "2026-08-25T12:00:00.000Z",
      contentHash: "a".repeat(64),
      parserVersion: "registry/v1",
    },
    ...overrides,
  };
}

describe("Raw Source v2 ingestion boundary", () => {
  it("canonicalizes key order and excludes transport observation time from the payload identity", () => {
    expect(rawPayloadHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      rawPayloadHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    const first = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const replay = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({
          provenance: {
            ...companyRecord().provenance,
            fetchedAt: "2026-08-26T12:00:00.000Z",
          },
        }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(replay.payloadHash).toBe(first.payloadHash);
    expect(replay.fetchedAt?.toISOString()).toBe("2026-08-26T12:00:00.000Z");
  });

  it("creates a bounded accepted receipt with an exact policy snapshot", () => {
    const prepared = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(prepared).toMatchObject({
      ingestVersion: RAW_SOURCE_INGEST_VERSION,
      ingestStatus: "ACCEPTED",
      dispositionCode: null,
      retentionDays: 90,
      sourcePolicySnapshot: {
        kind: "source_policy",
        id: POLICIES[0]!.id,
        domain: "registry.example",
        retentionDays: 90,
        minimizedFields: [],
      },
    });
    expect(prepared.ingestKey).toMatch(/^external:[0-9a-f]{64}$/u);
    expect(prepared.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.payloadBytes).toBeGreaterThan(0);
    expect(prepared.expiresAt.toISOString()).toBe("2026-11-24T00:00:00.000Z");
  });

  it("derives a stable identity key when externalId is absent", () => {
    const first = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ externalId: "", attributes: { employees: 10 } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const changed = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ externalId: "", attributes: { employees: 11 } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(first.ingestKey).toMatch(/^identity:[0-9a-f]{64}$/u);
    expect(changed.ingestKey).toBe(first.ingestKey);
    expect(changed.payloadHash).not.toBe(first.payloadHash);
  });

  it("minimizes an attribute outside the provider allowlist and rejects an ungoverned provider", () => {
    const bounded = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ attributes: { products: ["pump"], mystery: "drop" } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    expect(bounded.ingestStatus).toBe("ACCEPTED");
    expect(bounded.payload).toMatchObject({
      attributes: { products: ["pump"] },
    });
    expect(JSON.stringify(bounded.payload)).not.toContain("mystery");
    expect(bounded.sourcePolicySnapshot).toMatchObject({
      minimizedFields: ["attributes.mystery"],
    });

    const ungoverned = prepareRawSourceBatch({
      providerKey: "unknown-provider",
      records: [companyRecord()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    expect(ungoverned).toMatchObject({
      ingestStatus: "REJECTED",
      dispositionCode: "UNGOVERNED_PROVIDER_PAYLOAD",
    });
  });

  it.each([
    [
      "directory",
      {
        source_kind: "directory",
        source_directory: "registry.example",
        listing_location: "DE",
      },
    ],
    [
      "wikidata",
      {
        wikidata_qid: "Q1",
        latitude: 1,
        longitude: 2,
        source_class: "public_intelligence",
      },
    ],
    [
      "openstreetmap",
      { osm_id: "node/1", city: "Berlin", osm_tags: { industrial: "factory" } },
    ],
    ["trade_fair", { stand: "A42", products: ["pump"], source_fair: "fair-1" }],
    [
      "ted",
      { ted: { publication_number: "1", buyer_names: ["Public Authority"] } },
    ],
    ["openfda", { fda: { registration_number: "1" }, products: ["device"] }],
    [
      "public_web",
      {
        products: ["pump"],
        keywords: ["industrial"],
        extraction_confidence: 0.9,
      },
    ],
  ])(
    "accepts the bounded current-main %s mapper surface",
    (providerKey, attributes) => {
      const row = prepareRawSourceBatch({
        providerKey,
        records: [companyRecord({ attributes })],
        policies: POLICIES,
        limits: LIMITS,
        now: NOW,
      }).rows[0]!;
      expect(row.ingestStatus).toBe("ACCEPTED");
      expect(row.sourcePolicySnapshot).toMatchObject({ minimizedFields: [] });
    },
  );

  it("minimizes personal/contact fields before hashing or persistence", () => {
    const prepared = prepareRawSourceBatch({
      providerKey: "trade_fair",
      records: [
        companyRecord({
          attributes: {
            products: ["pump"],
            public_email: "named.person@example.test",
            public_phone: "+49 555 0100",
            contact: { full_name: "Must Not Persist" },
          },
        }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(prepared.ingestStatus).toBe("ACCEPTED");
    expect(JSON.stringify(prepared.payload)).not.toContain("named.person");
    expect(JSON.stringify(prepared.payload)).not.toContain("Must Not Persist");
    expect(prepared.sourcePolicySnapshot).toMatchObject({
      minimizedFields: [
        "attributes.contact",
        "attributes.public_email",
        "attributes.public_phone",
      ],
    });
  });

  it.each([
    [
      "unknown top-level field",
      companyRecord({ secret_extension: "never persist" }),
      "UNKNOWN_PAYLOAD_FIELD",
    ],
    [
      "malformed non-JSON value",
      companyRecord({ attributes: { count: BigInt(1) } }),
      "INVALID_JSON",
    ],
    [
      "unapproved policy",
      companyRecord(),
      "SOURCE_POLICY_SUSPENDED",
      [{ ...POLICIES[0]!, reviewStatus: "SUSPENDED" }],
    ],
  ])(
    "stores only a minimal receipt for %s",
    (_name, value, reason, policyOverride) => {
      const prepared = prepareRawSourceBatch({
        providerKey: "registry",
        records: [value],
        policies: policyOverride ?? POLICIES,
        limits: LIMITS,
        now: NOW,
      }).rows[0]!;

      expect(prepared.ingestStatus).not.toBe("ACCEPTED");
      expect(prepared.dispositionCode).toBe(reason);
      expect(prepared.externalId).toBeNull();
      expect(prepared.payload).toMatchObject({ reason });
      expect(JSON.stringify(prepared.payload)).not.toContain("never persist");
    },
  );

  it("reconciles exact replays and turns a reused processing key with changed content into one receipt", () => {
    const original = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const changed = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord({ name: "Changed GmbH" })],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const existing = [
      {
        id: "raw-original",
        externalId: original.externalId,
        ingestKey: original.ingestKey,
        payloadHash: original.payloadHash,
        payload: original.payload,
      },
    ];

    expect(reconcileRawSourceBatch([original], existing)).toMatchObject({
      rows: [],
      duplicateCount: 1,
    });
    const drift = reconcileRawSourceBatch([changed], existing);
    expect(drift).toMatchObject({ acceptedCount: 0, quarantinedCount: 1 });
    expect(drift.rows[0]).toMatchObject({
      externalId: null,
      ingestStatus: "QUARANTINED",
      dispositionCode: "PROCESSING_KEY_DRIFT",
      payload: { conflictWithRawId: "raw-original" },
    });
    expect(
      reconcileRawSourceBatch(
        [changed],
        [
          ...existing,
          {
            id: "raw-drift",
            externalId: null,
            ingestKey: drift.rows[0]!.ingestKey,
            payloadHash: drift.rows[0]!.payloadHash,
            payload: drift.rows[0]!.payload,
          },
        ],
      ),
    ).toMatchObject({ rows: [], duplicateCount: 1 });
  });

  it.each([
    ["missing source policy", [], "SOURCE_POLICY_MISSING"],
    [
      "invalid provenance shape",
      POLICIES,
      "INVALID_PROVENANCE",
      companyRecord({
        provenance: { ...companyRecord().provenance, extra: true },
      }),
    ],
    [
      "missing company name",
      POLICIES,
      "MALFORMED_PAYLOAD",
      companyRecord({ name: "" }),
    ],
  ])("fails closed for %s", (_name, policyRows, reason, recordOverride) => {
    const row = prepareRawSourceBatch({
      providerKey: "registry",
      records: [recordOverride ?? companyRecord()],
      policies: policyRows as RawSourcePolicySnapshot[],
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    expect(row.dispositionCode).toBe(reason);
    expect(row.ingestStatus).not.toBe("ACCEPTED");
  });

  it("bounds record and batch bytes and uses safe environment defaults", () => {
    const oversized = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ attributes: { company_text: "x".repeat(2_000) } }),
      ],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 100, maxBatchBytes: 4_000 },
      now: NOW,
    }).rows[0]!;
    expect(oversized.dispositionCode).toBe("PAYLOAD_TOO_LARGE");
    expect(JSON.stringify(oversized.payload)).not.toContain("x".repeat(100));

    const batched = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ externalId: "one" }),
        companyRecord({ externalId: "two" }),
      ],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 2_000, maxBatchBytes: 600 },
      now: NOW,
    });
    expect(batched.rows[1]?.dispositionCode).toBe("BATCH_LIMIT_EXCEEDED");
    expect(
      rawSourceIngestLimits({
        RAW_SOURCE_MAX_RECORD_BYTES: "invalid",
        RAW_SOURCE_MAX_BATCH_BYTES: "999999999",
        RAW_SOURCE_DEFAULT_RETENTION_DAYS: "0",
      }),
    ).toEqual({
      maxRecordBytes: 512 * 1024,
      maxBatchBytes: 20 * 1024 * 1024,
      defaultRetentionDays: 365,
    });
  });
});
