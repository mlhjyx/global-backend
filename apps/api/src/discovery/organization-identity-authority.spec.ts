// Test intent source-mined from tugjvnh@70885cdb; rewritten against current Raw Source contracts.
import { describe, expect, it } from "vitest";
import {
  extractOrganizationIdentityAuthority,
  ORGANIZATION_IDENTITY_AUTHORITY_PROFILES,
  OrganizationIdentityAuthorityError,
} from "./organization-identity-authority";
import {
  GOVERNED_RAW_SOURCE_PROVIDER_KEYS,
  validateRawSourceProviderPayload,
} from "./raw-source-provider-schema";

const PROVENANCE = Object.freeze({
  sourceUrl: "https://registry.example/companies/1",
  fetchedAt: "2026-08-25T12:00:00.000Z",
  contentHash: "a".repeat(64),
  parserVersion: "registry/v1",
});

function rawRecord(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "company-1",
    name: "Acme GmbH",
    domain: "acme.example",
    country: "DE",
    attributes: { products: ["pump"], employee_band: "50-100" },
    provenance: PROVENANCE,
    ...overrides,
  };
}

function validPayloads(): Readonly<Record<string, Record<string, unknown>>> {
  return Object.freeze({
    registry: rawRecord({
      identifier: { scheme: "registry-id", value: "de-12/34" },
    }),
    directory: rawRecord({
      externalId: "directory:acme.example",
      attributes: {
        source_kind: "directory",
        source_directory: "registry.example",
        detail_url: "https://registry.example/company/1",
        source_class: "industry_data",
      },
    }),
    wikidata: rawRecord({
      externalId: "wikidata:Q1",
      attributes: {
        wikidata_qid: "Q1",
        latitude: 1,
        longitude: 2,
        source_class: "company_registry",
      },
      license: "CC0-1.0",
      provenance: {
        ...PROVENANCE,
        sourceUrl: "https://www.wikidata.org/wiki/Q1",
      },
    }),
    openstreetmap: rawRecord({
      externalId: "osm:node/1",
      attributes: {
        osm_id: "node/1",
        latitude: 52.5,
        longitude: 13.4,
        source_class: "industry_data",
      },
      license: "ODbL-1.0",
      provenance: {
        ...PROVENANCE,
        sourceUrl: "https://www.openstreetmap.org/node/1",
      },
    }),
    trade_fair: rawRecord({
      externalId: "fair-1:company-1",
      attributes: {
        stand: "A42",
        products: ["pump"],
        source_fair: "fair-1",
        source_class: "industry_data",
      },
    }),
    ted: rawRecord({
      externalId: "ted:1:0",
      identifier: { scheme: "ted-natid:de", value: "de291499156" },
      attributes: {
        ted: {
          publication_number: "1",
          publication_date: "2026-08-25",
          notice_type: "award",
          winner_identifier: "de291499156",
        },
      },
      license: "CC BY 4.0",
      provenance: {
        ...PROVENANCE,
        sourceUrl: "https://ted.europa.eu/en/notice/-/detail/1",
      },
    }),
    openfda: rawRecord({
      externalId: "openfda:3004512345",
      identifier: { scheme: "fda-reg", value: "3004512345" },
      attributes: {
        fda: { registration_number: "3004512345", product_codes: ["LLZ"] },
        products: ["LLZ"],
      },
      license: "CC0-1.0",
      provenance: {
        ...PROVENANCE,
        sourceUrl: "https://api.fda.gov/device/registrationlisting.json",
      },
    }),
    public_web: rawRecord({
      externalId: "acme.example",
      attributes: {
        products: ["pump"],
        keywords: ["industrial"],
        extraction_confidence: 0.9,
        extraction_evidence_digest: "b".repeat(64),
        source_class: "public_intelligence",
      },
      provenance: { ...PROVENANCE, sourceUrl: "https://acme.example/company" },
    }),
  });
}

function authorityError(code: string) {
  return expect.objectContaining({
    code,
  }) as OrganizationIdentityAuthorityError;
}

describe("governed Raw organization identity authority", () => {
  it("keeps authority profiles exactly aligned with the exported Raw provider list", () => {
    expect(GOVERNED_RAW_SOURCE_PROVIDER_KEYS).toEqual([
      "registry",
      "directory",
      "wikidata",
      "openstreetmap",
      "trade_fair",
      "ted",
      "openfda",
      "public_web",
    ]);
    expect(Object.keys(ORGANIZATION_IDENTITY_AUTHORITY_PROFILES)).toEqual(
      GOVERNED_RAW_SOURCE_PROVIDER_KEYS,
    );
    expect(Object.keys(ORGANIZATION_IDENTITY_AUTHORITY_PROFILES)).not.toContain(
      "gleif",
    );
    expect(Object.keys(ORGANIZATION_IDENTITY_AUTHORITY_PROFILES)).not.toContain(
      "sec_edgar",
    );
  });

  it("admits a representative current Raw payload for every governed provider", () => {
    for (const providerKey of GOVERNED_RAW_SOURCE_PROVIDER_KEYS) {
      const payload = validPayloads()[providerKey]!;
      expect(
        validateRawSourceProviderPayload(providerKey, payload),
        providerKey,
      ).toMatchObject({ ok: true });
      expect(
        extractOrganizationIdentityAuthority(providerKey, payload),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerKey,
            scheme: "domain",
            jurisdiction: "GLOBAL",
            normalizedValue: "acme.example",
          }),
        ]),
      );
    }
  });

  it("normalizes domains and identifiers, sorts keys, and removes duplicates", () => {
    const payload = rawRecord({
      domain: "www.acme.example",
      identifier: { scheme: "registry-id", value: "DE-12/34" },
    });
    const result = extractOrganizationIdentityAuthority("registry", payload);
    expect(result).toEqual([
      expect.objectContaining({
        scheme: "domain",
        jurisdiction: "GLOBAL",
        normalizedValue: "acme.example",
        key: "domain:GLOBAL:acme.example",
        validatorVersion: "domain-v1",
      }),
      expect.objectContaining({
        scheme: "registry-id",
        jurisdiction: "DE",
        normalizedValue: "DE1234",
        key: "registry-id:DE:DE1234",
        validatorVersion: "registry-id-v1",
      }),
    ]);
    expect(result.map((item) => item.key)).toEqual(
      [...result.map((item) => item.key)].sort(),
    );
  });

  it("does not invent name-country authority when a valid admitted record has no domain or identifier", () => {
    const { domain: _domain, ...withoutDomain } = rawRecord({
      attributes: { employees: 50 },
    });
    expect(
      extractOrganizationIdentityAuthority("registry", withoutDomain),
    ).toEqual([]);
  });

  it("only admits a checksum-valid GLOBAL LEI for registry", () => {
    const valid = extractOrganizationIdentityAuthority(
      "registry",
      rawRecord({
        identifier: { scheme: "lei", value: "529900T8BM49AURSDO55" },
      }),
    );
    expect(valid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "lei",
          jurisdiction: "GLOBAL",
          normalizedValue: "529900T8BM49AURSDO55",
          validatorVersion: "lei-v1",
        }),
      ]),
    );
    expect(() =>
      extractOrganizationIdentityAuthority(
        "registry",
        rawRecord({
          identifier: { scheme: "lei", value: "529900T8BM49AURSDO56" },
        }),
      ),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
  });

  it("uses GLOBAL for a registry identifier when the Raw payload has no country", () => {
    const { country: _country, ...withoutCountry } = rawRecord({
      identifier: { scheme: "registry-id", value: "AB-123" },
    });
    expect(
      extractOrganizationIdentityAuthority("registry", withoutCountry),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "registry-id",
          jurisdiction: "GLOBAL",
          normalizedValue: "AB123",
        }),
      ]),
    );
  });

  it("uses TED suffix jurisdiction or payload country, while refusing free-text and missing jurisdiction", () => {
    const fromSuffix = extractOrganizationIdentityAuthority(
      "ted",
      validPayloads().ted,
    );
    expect(fromSuffix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "ted-natid",
          jurisdiction: "DE",
          normalizedValue: "DE291499156",
          validatorVersion: "ted-natid-v1",
        }),
      ]),
    );
    const fromCountry = extractOrganizationIdentityAuthority(
      "ted",
      rawRecord({
        externalId: "ted:1:0",
        identifier: { scheme: "ted-natid", value: "de291499156" },
        attributes: {
          ted: {
            publication_number: "1",
            publication_date: "2026-08-25",
            notice_type: "award",
            winner_identifier: "de291499156",
          },
        },
        license: "CC BY 4.0",
        provenance: {
          ...PROVENANCE,
          sourceUrl: "https://ted.europa.eu/en/notice/-/detail/1",
        },
      }),
    );
    expect(fromCountry).toEqual(
      expect.arrayContaining([expect.objectContaining({ jurisdiction: "DE" })]),
    );
    for (const identifier of ["Call 555-0100", "Bearer secret"]) {
      const payload = validPayloads().ted;
      expect(() =>
        extractOrganizationIdentityAuthority("ted", {
          ...payload,
          identifier: { scheme: "ted-natid:de", value: identifier },
          attributes: {
            ted: {
              publication_number: "1",
              publication_date: "2026-08-25",
              notice_type: "award",
              winner_identifier: identifier,
            },
          },
        }),
      ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
    }
    expect(() => {
      const { country: _country, ...withoutCountry } = validPayloads().ted;
      return extractOrganizationIdentityAuthority("ted", {
        ...withoutCountry,
        identifier: { scheme: "ted-natid", value: "DE291499156" },
        attributes: {
          ted: {
            publication_number: "1",
            publication_date: "2026-08-25",
            notice_type: "award",
            winner_identifier: "DE291499156",
          },
        },
      });
    }).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
  });

  it("keeps FDA identifiers numeric and pinned to US", () => {
    const result = extractOrganizationIdentityAuthority(
      "openfda",
      validPayloads().openfda,
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "fda-reg",
          jurisdiction: "US",
          normalizedValue: "3004512345",
          validatorVersion: "fda-reg-v1",
        }),
      ]),
    );
    expect(() =>
      extractOrganizationIdentityAuthority("openfda", {
        ...validPayloads().openfda,
        externalId: "openfda:ABC",
        identifier: { scheme: "fda-reg", value: "ABC" },
        attributes: {
          fda: { registration_number: "ABC", product_codes: ["LLZ"] },
          products: ["LLZ"],
        },
      }),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
  });

  it("rejects identifier authority outside registry, TED, and FDA at the Raw boundary", () => {
    for (const providerKey of [
      "directory",
      "wikidata",
      "openstreetmap",
      "trade_fair",
      "public_web",
    ]) {
      expect(() =>
        extractOrganizationIdentityAuthority(providerKey, {
          ...validPayloads()[providerKey],
          identifier: { scheme: "registry-id", value: "DE1234" },
        }),
      ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
    }
  });

  it("fails closed before authority extraction for unknown, malformed, extra, accessor, and cyclic payloads without echoing data", () => {
    const rejectedValue = "untrusted-payload-marker";
    const cyclic = rawRecord();
    (cyclic as { self?: unknown }).self = cyclic;
    const accessor = rawRecord();
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get: () => {
        throw new Error(rejectedValue);
      },
    });
    for (const [providerKey, payload] of [
      ["unknown", rawRecord()],
      ["registry", null],
      ["registry", { ...rawRecord(), extra: rejectedValue }],
      ["registry", accessor],
      ["registry", cyclic],
    ] as const) {
      try {
        extractOrganizationIdentityAuthority(providerKey, payload);
        throw new Error("expected authority extraction to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(OrganizationIdentityAuthorityError);
        expect(String(error)).not.toContain(rejectedValue);
      }
    }
  });

  it("returns deeply frozen, byte-stable output without mutating the admitted payload", () => {
    const payload = rawRecord({
      identifier: { scheme: "registry-id", value: "DE-1234" },
    });
    const before = JSON.stringify(payload);
    const first = extractOrganizationIdentityAuthority("registry", payload);
    const second = extractOrganizationIdentityAuthority("registry", payload);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(payload)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    for (const item of first) expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION_IDENTITY_AUTHORITY_PROFILES)).toBe(
      true,
    );
    for (const profile of Object.values(
      ORGANIZATION_IDENTITY_AUTHORITY_PROFILES,
    )) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.identifierRules)).toBe(true);
      for (const rule of profile.identifierRules)
        expect(Object.isFrozen(rule)).toBe(true);
    }
  });
});
