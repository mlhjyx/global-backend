// Test intent source-mined from tugjvnh@70885cdb; rewritten against current Raw Source contracts.
import { describe, expect, it, vi } from "vitest";
import {
  extractOrganizationIdentityAuthority,
  parseOrganizationIdentityAuthorityIdentifier,
  ORGANIZATION_IDENTITY_AUTHORITY_PROFILES,
  OrganizationIdentityAuthorityError,
} from "./organization-identity-authority";
import {
  GOVERNED_RAW_SOURCE_PROVIDER_KEYS,
  validateRawSourceProviderPayload,
} from "./raw-source-provider-schema";
import * as rawSourceProviderSchema from "./raw-source-provider-schema";

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
  it("parses only exact canonical authority output across every current producer path", () => {
    for (const providerKey of GOVERNED_RAW_SOURCE_PROVIDER_KEYS) {
      for (const produced of extractOrganizationIdentityAuthority(
        providerKey,
        validPayloads()[providerKey]!,
      )) {
        expect(parseOrganizationIdentityAuthorityIdentifier(produced)).toEqual(
          produced,
        );
      }
    }

    const registry = extractOrganizationIdentityAuthority(
      "registry",
      rawRecord({ identifier: { scheme: "registry-id", value: "de-12/34" } }),
    ).find((item) => item.scheme === "registry-id")!;
    const fda = extractOrganizationIdentityAuthority(
      "openfda",
      validPayloads().openfda,
    ).find((item) => item.scheme === "fda-reg")!;
    const malformed = [
      { ...registry, normalizedValue: "de1234", key: "registry-id:DE:de1234" },
      { ...registry, jurisdiction: "USA", key: "registry-id:USA:DE1234" },
      { ...registry, scheme: "forged", key: "forged:DE:DE1234" },
      { ...registry, validatorVersion: "registry-id-v999" },
      {
        ...registry,
        normalizerVersion: "organization-identity-authority/v999",
      },
      { ...registry, key: "registry-id:DE:OTHER" },
      { ...registry, providerKey: "directory" },
      { ...registry, extra: "unexpected" },
      {
        ...fda,
        normalizedValue: "1".repeat(33),
        key: `fda-reg:US:${"1".repeat(33)}`,
      },
      null,
      [],
    ];
    for (const candidate of malformed) {
      expect(
        parseOrganizationIdentityAuthorityIdentifier(candidate),
      ).toBeNull();
    }
  });

  it("rejects producer-unreachable structured output and parser hostiles without traps or echo", () => {
    const registry = extractOrganizationIdentityAuthority(
      "registry",
      rawRecord({ identifier: { scheme: "registry-id", value: "DE-12/34" } }),
    ).find((item) => item.scheme === "registry-id")!;
    const ted = extractOrganizationIdentityAuthority(
      "ted",
      validPayloads().ted,
    ).find((item) => item.scheme === "ted-natid")!;
    const unreachable = [
      { ...registry, normalizedValue: "Ä1", key: "registry-id:DE:Ä1" },
      {
        ...registry,
        normalizedValue: "A".repeat(81),
        key: `registry-id:DE:${"A".repeat(81)}`,
      },
      {
        ...ted,
        normalizedValue: "A".repeat(81),
        key: `ted-natid:DE:${"A".repeat(81)}`,
      },
    ];
    for (const candidate of unreachable) {
      expect(
        parseOrganizationIdentityAuthorityIdentifier(candidate),
      ).toBeNull();
    }

    const marker = "authority-parser-hostile-marker";
    let getterCalls = 0;
    const accessor = { ...registry };
    Object.defineProperty(accessor, "key", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(marker);
      },
    });
    const traps = {
      ownKeys: 0,
      getPrototypeOf: 0,
      getOwnPropertyDescriptor: 0,
    };
    const proxy = new Proxy(
      { ...registry },
      {
        ownKeys(target) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
        getPrototypeOf(target) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(target);
        },
        getOwnPropertyDescriptor(target, key) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    for (const candidate of [accessor, proxy]) {
      expect(
        parseOrganizationIdentityAuthorityIdentifier(candidate),
      ).toBeNull();
    }
    expect(getterCalls).toBe(0);
    expect(traps).toEqual({
      ownKeys: 0,
      getPrototypeOf: 0,
      getOwnPropertyDescriptor: 0,
    });
  });

  it("uses exact TED UTF-8 byte reachability and never rewrites submitted output fields", () => {
    const forty = "Ä".repeat(40);
    const fortyOne = "Ä".repeat(41);
    const tedPayload = (value: string) => ({
      ...validPayloads().ted,
      identifier: { scheme: "ted-natid:de", value },
      attributes: {
        ted: {
          publication_number: "1",
          publication_date: "2026-08-25",
          notice_type: "award",
          winner_identifier: value,
        },
      },
    });
    const produced = extractOrganizationIdentityAuthority(
      "ted",
      tedPayload(forty),
    );
    const ted = produced.find((item) => item.scheme === "ted-natid")!;
    expect(Buffer.byteLength(forty, "utf8")).toBe(80);
    expect(parseOrganizationIdentityAuthorityIdentifier(ted)).toEqual(ted);
    expect(() =>
      extractOrganizationIdentityAuthority("ted", tedPayload(fortyOne)),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
    expect(
      parseOrganizationIdentityAuthorityIdentifier({
        ...ted,
        normalizedValue: fortyOne,
        key: `ted-natid:DE:${fortyOne}`,
      }),
    ).toBeNull();

    const registry = extractOrganizationIdentityAuthority(
      "registry",
      rawRecord({ identifier: { scheme: "registry-id", value: "de-12/34" } }),
    ).find((item) => item.scheme === "registry-id")!;
    const domain = extractOrganizationIdentityAuthority(
      "registry",
      rawRecord(),
    ).find((item) => item.scheme === "domain")!;
    expect(
      parseOrganizationIdentityAuthorityIdentifier({
        ...registry,
        normalizedValue: "DE-12/34",
        key: registry.key,
      }),
    ).toBeNull();
    expect(
      parseOrganizationIdentityAuthorityIdentifier({
        ...domain,
        jurisdiction: "DE",
        normalizedValue: "WWW.Acme.Example",
        key: domain.key,
      }),
    ).toBeNull();
    for (const field of [
      "providerKey",
      "scheme",
      "jurisdiction",
      "normalizedValue",
      "validatorVersion",
      "normalizerVersion",
      "key",
    ] as const) {
      const mismatch = { ...registry, [field]: `${registry[field]}-mismatch` };
      expect(parseOrganizationIdentityAuthorityIdentifier(mismatch)).toBeNull();
    }
  });
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

  it("uses TED suffix jurisdiction or payload country, while rejecting a conflicting country", () => {
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
    expect(() =>
      extractOrganizationIdentityAuthority("ted", {
        ...validPayloads().ted,
        identifier: { scheme: "ted-natid:fr", value: "fr291499156" },
        attributes: {
          ted: {
            publication_number: "1",
            publication_date: "2026-08-25",
            notice_type: "award",
            winner_identifier: "fr291499156",
          },
        },
      }),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
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

  it("classifies unknown and provider-disallowed identifiers without conflating them with invalid values", () => {
    expect(() =>
      extractOrganizationIdentityAuthority("unknown", rawRecord()),
    ).toThrow(authorityError("IDENTITY_RAW_PAYLOAD_NOT_GOVERNED"));

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
      ).toThrow(authorityError("IDENTITY_IDENTIFIER_NOT_AUTHORIZED"));
    }

    expect(() =>
      extractOrganizationIdentityAuthority(
        "registry",
        rawRecord({
          identifier: { scheme: "unregistered-id", value: "DE1234" },
        }),
      ),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_NOT_AUTHORIZED"));
    expect(() =>
      extractOrganizationIdentityAuthority(
        "registry",
        rawRecord({ identifier: { scheme: "registry-id", value: "" } }),
      ),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
  });

  it("preflights hostile containers passively before Raw validation and never echoes their marker", () => {
    const marker = "hostile-container-marker";
    const ownAccessor = rawRecord();
    let getterCalls = 0;
    Object.defineProperty(ownAccessor, "name", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(marker);
      },
    });
    const symbol = Symbol("hostile-symbol");
    const withSymbol = rawRecord();
    Object.defineProperty(withSymbol, symbol, {
      value: marker,
      enumerable: true,
    });
    const productsWithHole = new Array<string>(2);
    productsWithHole[0] = "pump";
    const withHole = rawRecord({
      attributes: { products: productsWithHole },
    });
    const inherited = Object.create({
      get products() {
        getterCalls += 1;
        throw new Error(marker);
      },
    }) as Record<string, unknown>;
    const customPrototype = rawRecord({ attributes: inherited });
    const cyclic = rawRecord();
    (cyclic as { self?: unknown }).self = cyclic;
    const throwingProxy = new Proxy(rawRecord(), {
      getPrototypeOf() {
        throw new Error(marker);
      },
    });
    const revocable = Proxy.revocable(rawRecord(), {});
    revocable.revoke();

    for (const payload of [
      ownAccessor,
      withSymbol,
      withHole,
      customPrototype,
      cyclic,
      throwingProxy,
      revocable.proxy,
    ]) {
      try {
        extractOrganizationIdentityAuthority("registry", payload);
        throw new Error("expected hostile payload rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(OrganizationIdentityAuthorityError);
        expect(error).toMatchObject({ code: "IDENTITY_IDENTIFIER_INVALID" });
        expect(String(error)).not.toContain(marker);
      }
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects transparent object and array proxies before every reflection trap", () => {
    const objectTraps = {
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    };
    const objectProxy = new Proxy(rawRecord(), {
      getOwnPropertyDescriptor(target, property) {
        objectTraps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        objectTraps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        objectTraps.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    const arrayTraps = {
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    };
    const productsProxy = new Proxy(["pump"], {
      getOwnPropertyDescriptor(target, property) {
        arrayTraps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        arrayTraps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        arrayTraps.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
    });

    for (const payload of [
      objectProxy,
      rawRecord({ attributes: { products: productsProxy } }),
    ]) {
      expect(() =>
        extractOrganizationIdentityAuthority("registry", payload),
      ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
    }
    expect(objectTraps).toEqual({
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    });
    expect(arrayTraps).toEqual({
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    });
  });

  it("keeps unknown-provider membership ahead of hostile container preflight", () => {
    const traps = { getPrototypeOf: 0 };
    const payload = new Proxy(rawRecord(), {
      getPrototypeOf() {
        traps.getPrototypeOf += 1;
        throw new Error("unknown-hostile-marker");
      },
    });
    expect(() =>
      extractOrganizationIdentityAuthority("unknown", payload),
    ).toThrow(authorityError("IDENTITY_RAW_PAYLOAD_NOT_GOVERNED"));
    expect(traps).toEqual({ getPrototypeOf: 0 });
  });

  it("preserves Raw omission parity for undefined object fields while arrays remain dense and fail closed", () => {
    const payload = rawRecord({ externalId: undefined });
    expect(validateRawSourceProviderPayload("registry", payload)).toMatchObject(
      {
        ok: true,
      },
    );
    expect(extractOrganizationIdentityAuthority("registry", payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "domain",
          normalizedValue: "acme.example",
        }),
      ]),
    );
    expect(Object.hasOwn(payload, "externalId")).toBe(true);
    expect(payload.externalId).toBeUndefined();

    const arrayUndefined = rawRecord({
      attributes: { products: [undefined] },
    });
    expect(
      validateRawSourceProviderPayload("registry", arrayUndefined),
    ).toMatchObject({ ok: false });
    expect(() =>
      extractOrganizationIdentityAuthority("registry", arrayUndefined),
    ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
  });

  it("translates an unexpected Raw validator exception to the stable generic domain error", () => {
    const marker = "unexpected-validator-marker";
    const rawValidator = vi
      .spyOn(rawSourceProviderSchema, "validateRawSourceProviderPayload")
      .mockImplementation(() => {
        throw new Error(marker);
      });
    try {
      expect(() =>
        extractOrganizationIdentityAuthority("registry", rawRecord()),
      ).toThrow(authorityError("IDENTITY_IDENTIFIER_INVALID"));
      try {
        extractOrganizationIdentityAuthority("registry", rawRecord());
      } catch (error) {
        expect(String(error)).not.toContain(marker);
      }
    } finally {
      rawValidator.mockRestore();
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
