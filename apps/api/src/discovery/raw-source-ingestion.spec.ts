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
    allowedPurpose: ["discovery"],
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

  it("uses an ordinal comparator even when localeCompare is hostile, including non-ASCII keys", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale comparator must not be used");
    };
    try {
      expect(rawPayloadHash({ ä: 1, z: 2, A: 3 })).toBe(
        rawPayloadHash({ A: 3, z: 2, ä: 1 }),
      );
    } finally {
      String.prototype.localeCompare = original;
    }
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
        companyRecord({ externalId: undefined, attributes: { employees: 10 } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const changed = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ externalId: undefined, attributes: { employees: 11 } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(first.ingestKey).toMatch(/^identity:[0-9a-f]{64}$/u);
    expect(changed.ingestKey).toBe(first.ingestKey);
    expect(changed.payloadHash).not.toBe(first.payloadHash);
  });

  it.each(["Johnson Controls", "Parker Hannifin", "General Dynamics"])(
    "admits the provider-classified industrial company %s without a title-case person heuristic",
    (name) => {
      const row = prepareRawSourceBatch({
        providerKey: "registry",
        records: [companyRecord({ name })],
        policies: POLICIES,
        limits: LIMITS,
        now: NOW,
      }).rows[0]!;
      expect(row).toMatchObject({
        ingestStatus: "ACCEPTED",
        dispositionCode: null,
        payload: expect.objectContaining({ name }),
      });
    },
  );

  it.each([
    ["company name", { name: "Acme ٥٥٥-٠١٠٠" }],
    [
      "URL path",
      {
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/company/٥٥٥-٠١٠٠",
        },
      },
    ],
  ])("rejects a Unicode-decimal local phone in every persisted %s", (_label, overrides) => {
    const row = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord(overrides)],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(row).toMatchObject({
      ingestStatus: "REJECTED",
      dispositionCode: "PROVIDER_PAYLOAD_SCHEMA_INVALID",
      externalId: null,
    });
    expect(JSON.stringify(row.payload)).not.toContain("٥٥٥-٠١٠٠");
  });

  it("rejects an attribute outside the provider schema and an ungoverned provider", () => {
    const bounded = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        companyRecord({ attributes: { products: ["pump"], mystery: "drop" } }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    expect(bounded.ingestStatus).toBe("REJECTED");
    expect(bounded.dispositionCode).toBe("PROVIDER_PAYLOAD_SCHEMA_INVALID");
    expect(JSON.stringify(bounded.payload)).not.toContain("mystery");

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
        detail_url: "https://registry.example/company/1",
        source_class: "industry_data",
      },
    ],
    [
      "wikidata",
      {
        wikidata_qid: "Q1",
        latitude: 1,
        longitude: 2,
        source_class: "company_registry",
      },
    ],
    [
      "openstreetmap",
      {
        osm_id: "node/1",
        latitude: 52.5,
        longitude: 13.4,
        source_class: "industry_data",
      },
    ],
    [
      "trade_fair",
      {
        stand: "A42",
        products: ["pump"],
        source_fair: "fair-1",
        source_class: "industry_data",
      },
    ],
    [
      "ted",
      {
        ted: {
          publication_number: "1",
          publication_date: "2026-08-25",
          notice_type: "award",
          cpv: ["42122000"],
          buyer_countries: ["DE"],
        },
      },
    ],
    [
      "openfda",
      {
        fda: {
          registration_number: "1",
          status_code: "1",
          product_codes: ["LLZ"],
          initial_importer: false,
        },
        products: ["LLZ"],
      },
    ],
    [
      "public_web",
      {
        products: ["pump"],
        keywords: ["industrial"],
        extraction_confidence: 0.9,
        extraction_evidence_digest: "b".repeat(64),
        source_class: "public_intelligence",
      },
    ],
  ])(
    "accepts the bounded current-main %s mapper surface",
    (providerKey, attributes) => {
      const row = prepareRawSourceBatch({
        providerKey,
        records: [
          companyRecord({
            externalId:
              ({
                directory: "directory:acme.example",
                wikidata: "wikidata:Q1",
                openstreetmap: "osm:node/1",
                trade_fair: "fair-1:company-1",
                ted: "ted:1:0",
                openfda: "openfda:1",
                public_web: "acme.example",
              } as Record<string, string>)[providerKey] ?? "company-1",
            attributes,
            ...({
              wikidata: {
                license: "CC0-1.0",
                provenance: {
                  ...companyRecord().provenance,
                  sourceUrl: "https://www.wikidata.org/wiki/Q1",
                },
              },
              openstreetmap: {
                license: "ODbL-1.0",
                provenance: {
                  ...companyRecord().provenance,
                  sourceUrl: "https://www.openstreetmap.org/node/1",
                },
              },
              ted: {
                license: "CC BY 4.0",
                provenance: {
                  ...companyRecord().provenance,
                  sourceUrl: "https://ted.europa.eu/en/notice/-/detail/1",
                },
              },
              openfda: {
                license: "CC0-1.0",
                identifier: { scheme: "fda-reg", value: "1" },
                provenance: {
                  ...companyRecord().provenance,
                  sourceUrl:
                    "https://api.fda.gov/device/registrationlisting.json",
                },
              },
              public_web: {
                provenance: {
                  ...companyRecord().provenance,
                  sourceUrl: "https://acme.example/company",
                },
              },
            }[providerKey] ?? {}),
          }),
        ],
        policies: POLICIES.map((policy) => ({
          ...policy,
          domain:
            providerKey === "openstreetmap"
              ? "overpass-api.de"
              : providerKey === "wikidata"
                ? "wikidata.org"
              : providerKey === "ted"
                ? "api.ted.europa.eu"
                : providerKey === "openfda"
                  ? "api.fda.gov"
                  : providerKey === "public_web"
                    ? "acme.example"
                : policy.domain,
        })),
        limits: {
          ...LIMITS,
          maxRecordBytes: 2_048,
          maxBatchBytes: 4_096,
        },
        now: NOW,
      }).rows[0]!;
      expect(row.ingestStatus).toBe("ACCEPTED");
      expect(row.sourcePolicySnapshot).toMatchObject({ minimizedFields: [] });
    },
  );

  it("rejects personal/contact fields before hashing or persistence", () => {
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

    expect(prepared.ingestStatus).toBe("REJECTED");
    expect(prepared.dispositionCode).toBe("PROVIDER_PAYLOAD_SCHEMA_INVALID");
    expect(JSON.stringify(prepared.payload)).not.toContain("named.person");
    expect(JSON.stringify(prepared.payload)).not.toContain("Must Not Persist");
  });

  it("rejects secret-shaped and non-semantic openFDA product codes", () => {
    for (const productCode of ["SECRET", "LLZ1", "AB"]) {
      const row = prepareRawSourceBatch({
        providerKey: "openfda",
        records: [
          companyRecord({
            externalId: "openfda:3004512345",
            identifier: { scheme: "fda-reg", value: "3004512345" },
            attributes: {
              fda: {
                registration_number: "3004512345",
                status_code: "1",
                product_codes: [productCode],
              },
              products: [productCode],
            },
            license: "CC0-1.0",
            provenance: {
              ...companyRecord().provenance,
              sourceUrl:
                "https://api.fda.gov/device/registrationlisting.json",
            },
          }),
        ],
        policies: POLICIES.map((policy) => ({
          ...policy,
          domain: "api.fda.gov",
        })),
        limits: { ...LIMITS, maxRecordBytes: 2_048, maxBatchBytes: 4_096 },
        now: NOW,
      }).rows[0]!;

      expect(row).toMatchObject({
        ingestStatus: "REJECTED",
        dispositionCode: "PROVIDER_PAYLOAD_SCHEMA_INVALID",
      });
      expect(JSON.stringify(row.payload)).not.toContain(productCode);
    }
  });

  it("rejects cyclic, over-deep, and accessor payloads without executing untrusted getters", () => {
    const cyclicAttributes: Record<string, unknown> = { products: ["pump"] };
    cyclicAttributes.self = cyclicAttributes;
    const cyclic = companyRecord({ attributes: cyclicAttributes });

    let nested: Record<string, unknown> = { value: "pump" };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    const overDeep = companyRecord({ attributes: nested });

    let getterCalls = 0;
    const accessor = companyRecord();
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "Getter GmbH";
      },
    });

    expect(() =>
      prepareRawSourceBatch({
        providerKey: "registry",
        records: [cyclic, overDeep, accessor],
        policies: POLICIES,
        limits: { ...LIMITS, maxRecordBytes: 8_192 },
        now: NOW,
      }),
    ).not.toThrow();
    const rows = prepareRawSourceBatch({
      providerKey: "registry",
      records: [cyclic, overDeep, accessor],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 8_192 },
      now: NOW,
    }).rows;
    expect(rows.map((row) => row.dispositionCode)).toEqual([
      "INVALID_JSON",
      "PROVIDER_PAYLOAD_SCHEMA_INVALID",
      "INVALID_JSON",
    ]);
    expect(getterCalls).toBe(0);
  });

  it("withholds free-text PublicWeb evidence behind a deterministic digest", () => {
    const row = prepareRawSourceBatch({
      providerKey: "public_web",
      records: [
        companyRecord({
          externalId: "acme.example",
          attributes: {
            products: ["pump"],
            keywords: ["industrial"],
            extraction_evidence: "Contact Jane Doe at person@example.test",
            extraction_confidence: 0.9,
            source_class: "public_intelligence",
          },
          provenance: {
            ...companyRecord().provenance,
            sourceUrl: "https://acme.example/company",
          },
        }),
      ],
      policies: POLICIES.map((policy) => ({
        ...policy,
        domain: "acme.example",
      })),
      limits: { ...LIMITS, maxRecordBytes: 2_048, maxBatchBytes: 4_096 },
      now: NOW,
    }).rows[0]!;
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      attributes: {
        products: ["pump"],
        keywords: ["industrial"],
        extraction_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        extraction_confidence: 0.9,
        source_class: "public_intelligence",
      },
    });
    expect(JSON.stringify(row.payload)).not.toMatch(/Jane Doe|person@example/u);
  });

  it.each([
    [
      "PII in products",
      "trade_fair",
      companyRecord({ attributes: { products: ["Jane Doe"] } }),
    ],
    [
      "credential marker in an allowed product token",
      "trade_fair",
      companyRecord({ attributes: { products: ["Bearer sk-secret-value"] } }),
    ],
    [
      "common local phone in an allowed product value",
      "public_web",
      companyRecord({
        attributes: {
          products: ["Call 555-0100"],
          keywords: ["industrial"],
          extraction_confidence: 0.9,
          extraction_evidence_digest: "b".repeat(64),
          source_class: "public_intelligence",
        },
      }),
    ],
    [
      "lowercase particle personal name in an allowed product value",
      "public_web",
      companyRecord({
        attributes: {
          products: ["alice van smith pump"],
          keywords: ["industrial"],
          extraction_confidence: 0.9,
          extraction_evidence_digest: "b".repeat(64),
          source_class: "public_intelligence",
        },
      }),
    ],
    [
      "email-shaped domain",
      "registry",
      companyRecord({ domain: "person@example.test" }),
    ],
    [
      "syntactically invalid domain",
      "registry",
      companyRecord({ domain: "not a domain" }),
    ],
    [
      "email-shaped externalId",
      "registry",
      companyRecord({ externalId: "person@example.test" }),
    ],
    [
      "local-phone externalId",
      "registry",
      companyRecord({ externalId: "555-0100" }),
    ],
    [
      "credential marker in externalId",
      "registry",
      companyRecord({ externalId: "bearer-secret" }),
    ],
    [
      "local-phone provider identifier",
      "registry",
      companyRecord({
        identifier: { scheme: "registry-id", value: "555-0100" },
      }),
    ],
    [
      "cross-provider identifier scheme",
      "registry",
      companyRecord({ identifier: { scheme: "fda-reg", value: "3004512345" } }),
    ],
    ["empty externalId", "registry", companyRecord({ externalId: "" })],
    [
      "unbounded externalId",
      "registry",
      companyRecord({ externalId: "x".repeat(257) }),
    ],
    [
      "credential URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://user:password@registry.example/company/1",
        },
      }),
    ],
    [
      "Wikidata externalId-to-QID mismatch",
      "wikidata",
      companyRecord({
        externalId: "wikidata:Q2",
        attributes: { wikidata_qid: "Q1", source_class: "company_registry" },
        license: "CC0-1.0",
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://www.wikidata.org/wiki/Q1",
        },
      }),
    ],
    [
      "TED identifier-to-winner mismatch",
      "ted",
      companyRecord({
        externalId: "ted:1:0",
        identifier: { scheme: "ted-natid:de", value: "DE222" },
        attributes: {
          ted: {
            publication_number: "1",
            publication_date: "2026-08-25",
            notice_type: "award",
            winner_identifier: "DE111",
          },
        },
        license: "CC BY 4.0",
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://api.ted.europa.eu/v3/notices/search",
        },
      }),
    ],
    [
      "openFDA identifier-to-registration mismatch",
      "openfda",
      companyRecord({
        externalId: "openfda:3004512345",
        identifier: { scheme: "fda-reg", value: "3004512345" },
        attributes: {
          fda: { registration_number: "999", product_codes: ["LLZ"] },
          products: ["LLZ"],
        },
        license: "CC0-1.0",
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://api.fda.gov/device/registrationlisting.json",
        },
      }),
    ],
    [
      "PublicWeb externalId-to-domain mismatch",
      "public_web",
      companyRecord({
        externalId: "other.example",
        domain: "acme.example",
        attributes: {
          products: ["pump"],
          keywords: ["industrial"],
          extraction_confidence: 0.9,
          extraction_evidence_digest: "b".repeat(64),
          source_class: "public_intelligence",
        },
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://acme.example/company",
        },
      }),
    ],
    [
      "local-phone URL path",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/company/555-0100",
        },
      }),
    ],
    [
      "query URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/company/1?token=secret",
        },
      }),
    ],
    [
      "fragment URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/company/1#person",
        },
      }),
    ],
    [
      "double-encoded email URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/person%2540example.test",
        },
      }),
    ],
    [
      "multi-encoded credential URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/api%25255Fkey%25253Dsecret",
        },
      }),
    ],
    [
      "residual percent-25 URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "https://registry.example/value%2525252525",
        },
      }),
    ],
    [
      "malformed content hash",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          contentHash: "not-sha256",
        },
      }),
    ],
    [
      "credential marker in company name",
      "registry",
      companyRecord({ name: "Bearer secret" }),
    ],
    [
      "explicit personal contact name",
      "registry",
      companyRecord({ name: "Jane Doe" }),
    ],
    [
      "non-HTTPS provenance URL",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          sourceUrl: "http://registry.example/company/1",
        },
      }),
    ],
    [
      "malformed observation timestamp",
      "registry",
      companyRecord({
        provenance: { ...companyRecord().provenance, fetchedAt: "tomorrow" },
      }),
    ],
    [
      "malformed parser version",
      "registry",
      companyRecord({
        provenance: {
          ...companyRecord().provenance,
          parserVersion: "free text version",
        },
      }),
    ],
    [
      "unknown sensitive key",
      "registry",
      companyRecord({
        attributes: { products: ["pump"], safe_note: "Bearer token-value" },
      }),
    ],
    [
      "wrong scalar type",
      "wikidata",
      companyRecord({ attributes: { wikidata_qid: 123, latitude: "52" } }),
    ],
    [
      "out-of-range coordinates",
      "wikidata",
      companyRecord({
        attributes: { wikidata_qid: "Q1", latitude: 91, longitude: 181 },
      }),
    ],
    [
      "invalid TED semantic codes",
      "ted",
      companyRecord({
        attributes: {
          ted: {
            publication_number: "free text number",
            publication_date: "2026-99-99",
            notice_type: "personal note",
            cpv: ["pump"],
            buyer_countries: ["Germany"],
          },
        },
      }),
    ],
    [
      "out-of-range extraction confidence",
      "public_web",
      companyRecord({
        attributes: {
          products: ["pump"],
          extraction_confidence: 2,
          extraction_evidence_digest: "b".repeat(64),
          source_class: "public_intelligence",
        },
      }),
    ],
    [
      "oversized array",
      "trade_fair",
      companyRecord({
        attributes: { products: Array.from({ length: 21 }, () => "pump") },
      }),
    ],
    [
      "oversized token",
      "trade_fair",
      companyRecord({ attributes: { products: ["x".repeat(81)] } }),
    ],
  ])("rejects %s with a value-free receipt", (_name, providerKey, value) => {
    const row = prepareRawSourceBatch({
      providerKey,
      records: [value],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 8_192, maxBatchBytes: 16_384 },
      now: NOW,
    }).rows[0]!;
    expect(row).toMatchObject({
      ingestStatus: "REJECTED",
      dispositionCode: "PROVIDER_PAYLOAD_SCHEMA_INVALID",
      externalId: null,
      sourceUrl: null,
      contentHash: null,
    });
    const serialized = JSON.stringify(row.payload);
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("secret-value");
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

  it.each([
    [undefined, "missing"],
    [null, "null"],
    [[], "empty"],
    ["discovery", "malformed"],
    [["enrichment"], "other-purpose"],
    [["discovery", 42], "mixed-type"],
  ])(
    "quarantines an approved policy with %s allowedPurpose (%s)",
    (allowedPurpose) => {
      const row = prepareRawSourceBatch({
        providerKey: "registry",
        records: [companyRecord()],
        policies: [{ ...POLICIES[0]!, allowedPurpose }],
        limits: LIMITS,
        now: NOW,
      }).rows[0]!;

      expect(row).toMatchObject({
        ingestStatus: "QUARANTINED",
        dispositionCode: "SOURCE_POLICY_PURPOSE_NOT_ALLOWED",
        externalId: null,
      });
      expect(row.sourcePolicySnapshot).toMatchObject({
        allowedPurpose: [],
      });
    },
  );

  it("derives every non-ACCEPTED persisted key from the final exact minimal receipt", () => {
    const rejected = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord({ unknown: "never persist" })],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const quarantined = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord()],
      policies: [{ ...POLICIES[0]!, reviewStatus: "SUSPENDED" }],
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;
    const oversized = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord()],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 32 },
      now: NOW,
    }).rows[0]!;

    for (const row of [rejected, quarantined, oversized]) {
      expect(row.ingestStatus).not.toBe("ACCEPTED");
      expect(row.ingestKey).toBe(`payload:${row.payloadHash}`);
      expect(row.payload).toEqual({
        _rawReceipt:
          row.ingestStatus === "REJECTED"
            ? "raw-source/rejected/v1"
            : "raw-source/quarantine/v1",
        reason: row.dispositionCode,
        originalPayloadHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        originalPayloadBytes: expect.any(Number),
      });
    }
  });

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
        id: "83000000-0000-4000-8000-000000000001",
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
      payload: {
        conflictWithRawId: "83000000-0000-4000-8000-000000000001",
      },
    });
    expect(drift.rows[0]!.ingestKey).toBe(
      `payload:${drift.rows[0]!.payloadHash}`,
    );
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

  it("treats the same numeric payload as a replay when PostgreSQL stores a different canonical digest", () => {
    const candidate = prepareRawSourceBatch({
      providerKey: "registry",
      records: [companyRecord({ revenueUsd: 1e-7 })],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0]!;

    expect(
      reconcileRawSourceBatch(
        [candidate],
        [
          {
            id: "raw-db-canonical",
            externalId: candidate.externalId,
            ingestKey: candidate.ingestKey,
            payloadHash: "b".repeat(64),
            payload: candidate.payload,
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
      "PROVIDER_PAYLOAD_SCHEMA_INVALID",
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
        companyRecord({
          attributes: {
            products: Array.from({ length: 20 }, () => "industrial pump"),
          },
        }),
      ],
      policies: POLICIES,
      limits: { ...LIMITS, maxRecordBytes: 100, maxBatchBytes: 4_000 },
      now: NOW,
    }).rows[0]!;
    expect(oversized.dispositionCode).toBe("PAYLOAD_TOO_LARGE");
    expect(JSON.stringify(oversized.payload)).not.toContain("industrial pump");

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
