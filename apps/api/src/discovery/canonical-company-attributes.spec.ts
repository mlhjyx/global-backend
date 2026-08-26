import { describe, expect, it } from "vitest";
import * as canonicalAttributes from "./canonical-company-attributes";

const { sanitizeCanonicalCompanyAttributes } = canonicalAttributes;

type StoredFieldSanitizer = (field: string, value: unknown) => unknown;
const missingStoredFieldAdapter = Symbol("missing-stored-field-adapter");
const sanitizeStoredCompanyFieldEvidence = (
  canonicalAttributes as typeof canonicalAttributes & {
    sanitizeStoredCompanyFieldEvidence?: StoredFieldSanitizer;
  }
).sanitizeStoredCompanyFieldEvidence;
const storedCompanyFieldEvidenceFields = (
  canonicalAttributes as typeof canonicalAttributes & {
    STORED_COMPANY_FIELD_EVIDENCE_FIELDS?: readonly string[];
  }
).STORED_COMPANY_FIELD_EVIDENCE_FIELDS;

function sanitizeStored(field: string, value: unknown): unknown {
  return sanitizeStoredCompanyFieldEvidence
    ? sanitizeStoredCompanyFieldEvidence(field, value)
    : missingStoredFieldAdapter;
}

const semanticIdentifierCollisions = [
  "cpv",
  "fei_number",
  "isin",
  "k_number",
  "lei",
  "legal_form_code",
  "naics",
  "notice",
  "osm_id",
  "owner_operator_numbers",
  "parent_lei",
  "parent_qid",
  "product_code",
  "publication_number",
  "qid",
  "registration_number",
  "source",
  "ultimate_parent_lei",
  "wikidata_qid",
  "winner_identifier",
] as const;

describe("CanonicalCompany derived-attribute sanitizer parity", () => {
  it("keeps exact FDA product codes and controlled terms but rejects secret-shaped uppercase tokens", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        products: ["pump", "LLZ", "SECRET", "LLZ1", "AB"],
      }),
    ).toEqual({ products: ["pump", "LLZ"] });
  });

  it("preserves a legitimate numeric TED notice at its exact Canonical evidence path", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        intent: {
          events: [
            {
              type: "TENDER_PUBLISHED",
              at: "2026-08-26T00:00:00.000Z",
              strength: 0.9,
              evidence: {
                cpv: ["42122130"],
                notice: "123456-2026",
                source: "ted",
              },
            },
          ],
        },
      }),
    ).toEqual({
      intent: {
        events: [
          {
            type: "TENDER_PUBLISHED",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.9,
            evidence: {
              cpv: ["42122130"],
              notice: "123456-2026",
              source: "ted",
            },
          },
        ],
      },
    });
  });

  it("publishes the exact closed stored-company FieldEvidence contract mined from current writers", () => {
    expect(storedCompanyFieldEvidenceFields).toEqual([
      "attributes",
      "country",
      "digital_footprint.ad_pixels",
      "digital_footprint.email_provider",
      "digital_footprint.hiring_signal",
      "digital_footprint.is_advertiser",
      "digital_footprint.served_langs",
      "digital_footprint.served_markets",
      "digital_footprint.structured_org",
      "digital_footprint.structured_products",
      "digital_footprint.tech_platform",
      "domain",
      "employee_count",
      "gleif.entity_status",
      "gleif.is_subsidiary",
      "gleif.legal_form",
      "gleif.legal_form_code",
      "gleif.legal_name",
      "gleif.lei",
      "gleif.match_confidence",
      "gleif.parent_lei",
      "gleif.parent_name",
      "gleif.registered_city",
      "gleif.registered_country",
      "gleif.registration_status",
      "gleif.ultimate_parent_lei",
      "gleif.ultimate_parent_name",
      "identity",
      "industry",
      "intent.clearance",
      "intent.sources_sought",
      "intent.tender",
      "intent.website_change",
      "name",
      "region",
      "revenue_usd",
      "structured_harvest.careers_url",
      "structured_harvest.hiring_signal",
      "structured_harvest.site_sections",
      "structured_harvest.sitemap_url_count",
      "wikidata.country",
      "wikidata.employees",
      "wikidata.headquarters",
      "wikidata.inception_year",
      "wikidata.industries",
      "wikidata.isin",
      "wikidata.label",
      "wikidata.lei",
      "wikidata.match_confidence",
      "wikidata.parent_name",
      "wikidata.parent_qid",
      "wikidata.products",
      "wikidata.qid",
      "wikidata.stock_exchange",
      "wikidata.subsidiary_count",
      "wikidata.website",
    ]);
  });

  it("adapts every admitted stored field to its exact Canonical or column value shape", () => {
    const tender = {
      last_change_at: "2026-08-26T00:00:00.000Z",
      intent_score: 0.9,
      counts: { TENDER_PUBLISHED: 1 },
      events: [
        {
          type: "TENDER_PUBLISHED",
          at: "2026-08-26T00:00:00.000Z",
          strength: 0.9,
          evidence: {
            cpv: ["42122130"],
            notice: "123456-2026",
            source: "ted",
          },
        },
      ],
      _ts: "2026-08-26T00:00:00.000Z",
    };
    const clearance = {
      type: "FDA_CLEARANCE",
      at: "2026-08-26T00:00:00.000Z",
      strength: 0.85,
      evidence: {
        product_code: "LLZ",
        k_number: "K123456",
        device: "Industrial pump controller",
        source: "openfda",
      },
    };
    const sourcesSought = {
      events: [
        {
          type: "US_FED_SOURCES_SOUGHT",
          at: "2026-08-26T00:00:00.000Z",
          strength: 0.7,
          evidence: {
            naics: ["333914"],
            notice: "W912HQ-26-S-0001",
            source: "samgov",
          },
        },
      ],
    };
    const websiteChange = {
      last_change_at: "2026-08-26T00:00:00.000Z",
      intent_score: 0.6,
      counts: { PRODUCT_ADDED: 1 },
      events: [
        {
          type: "PRODUCT_ADDED",
          at: "2026-08-26T00:00:00.000Z",
          strength: 0.6,
          page_kind: "products",
          page_url: "https://acme.example/products/pump",
          evidence: { new_products: ["industrial pump"] },
        },
      ],
      _ts: "2026-08-26T00:00:00.000Z",
    };
    const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["attributes", { products: ["pump"] }, { products: ["pump"] }],
      ["country", "DE", "DE"],
      ["domain", "acme.example", "acme.example"],
      ["employee_count", 1250, 1250],
      ["industry", "Industrial machinery", "Industrial machinery"],
      ["name", "Acme Pump GmbH", "Acme Pump GmbH"],
      ["region", "Bavaria", "Bavaria"],
      ["revenue_usd", 12500000, 12500000],
      ["gleif.lei", "529900T8BM49AURSDO55", "529900T8BM49AURSDO55"],
      ["gleif.legal_name", "Acme Pump GmbH", "Acme Pump GmbH"],
      ["gleif.legal_form", "GmbH", "GmbH"],
      ["gleif.legal_form_code", "2HBR", "2HBR"],
      ["gleif.entity_status", "ACTIVE", "ACTIVE"],
      ["gleif.registration_status", "ISSUED", "ISSUED"],
      ["gleif.registered_country", "DE", "DE"],
      ["gleif.registered_city", "Munich", "Munich"],
      ["gleif.match_confidence", 0.98, 0.98],
      ["gleif.parent_lei", "5493001KJTIIGC8Y1R12", "5493001KJTIIGC8Y1R12"],
      ["gleif.parent_name", "Acme Holding SE", "Acme Holding SE"],
      ["gleif.is_subsidiary", true, true],
      [
        "gleif.ultimate_parent_lei",
        "213800D1EI4B9WTWWD28",
        "213800D1EI4B9WTWWD28",
      ],
      ["gleif.ultimate_parent_name", "Acme Group SE", "Acme Group SE"],
      ["wikidata.qid", "Q123", "Q123"],
      ["wikidata.label", "Acme Pump", "Acme Pump"],
      ["wikidata.website", "acme.example", "acme.example"],
      [
        "wikidata.industries",
        ["industrial machinery"],
        ["industrial machinery"],
      ],
      ["wikidata.products", ["pump"], ["pump"]],
      ["wikidata.employees", 1250, 1250],
      ["wikidata.inception_year", 1984, 1984],
      ["wikidata.parent_name", "Acme Holding", "Acme Holding"],
      ["wikidata.parent_qid", "Q456", "Q456"],
      ["wikidata.subsidiary_count", 4, 4],
      ["wikidata.lei", "529900T8BM49AURSDO55", "529900T8BM49AURSDO55"],
      ["wikidata.isin", "DE000BASF111", "DE000BASF111"],
      ["wikidata.country", "Germany", "Germany"],
      ["wikidata.headquarters", "Munich", "Munich"],
      [
        "wikidata.stock_exchange",
        "Frankfurt Stock Exchange",
        "Frankfurt Stock Exchange",
      ],
      ["wikidata.match_confidence", 0.96, 0.96],
      ["digital_footprint.tech_platform", ["shopify"], ["shopify"]],
      ["digital_footprint.ad_pixels", ["google_ads"], ["google_ads"]],
      ["digital_footprint.is_advertiser", true, true],
      ["digital_footprint.served_markets", ["DE", "US"], ["DE", "US"]],
      ["digital_footprint.served_langs", ["de", "en"], ["de", "en"]],
      [
        "digital_footprint.hiring_signal",
        { open_roles: 2, titles: ["Buyer"] },
        { open_roles: 2, titles: ["Buyer"] },
      ],
      [
        "digital_footprint.structured_org",
        { name: "Acme Pump GmbH", country: "DE" },
        { name: "Acme Pump GmbH", country: "DE" },
      ],
      [
        "digital_footprint.structured_products",
        ["industrial pump"],
        ["industrial pump"],
      ],
      ["digital_footprint.email_provider", "microsoft_365", "microsoft_365"],
      ["structured_harvest.sitemap_url_count", 42, 42],
      ["structured_harvest.site_sections", { products: 8 }, { products: 8 }],
      [
        "structured_harvest.careers_url",
        "https://acme.example/careers",
        "https://acme.example/careers",
      ],
      [
        "structured_harvest.hiring_signal",
        {
          source: "sitemap",
          open_roles: 2,
          titles: ["Buyer"],
          has_buying_role: true,
        },
        {
          source: "sitemap",
          open_roles: 2,
          titles: ["Buyer"],
          has_buying_role: true,
        },
      ],
      ["intent.tender", tender, tender],
      ["intent.clearance", clearance, clearance],
      ["intent.sources_sought", sourcesSought, sourcesSought],
      ["intent.website_change", websiteChange, websiteChange],
      [
        "identity",
        {
          name: "Acme Pump GmbH",
          country: "DE",
          source: "ted",
          notice: "123456-2026",
          attribution: "TED CC BY 4.0",
        },
        {
          name: "Acme Pump GmbH",
          country: "DE",
          source: "ted",
          notice: "123456-2026",
          attribution: "TED CC BY 4.0",
        },
      ],
    ];

    expect(cases.map(([field, value]) => sanitizeStored(field, value))).toEqual(
      cases.map(([, , expected]) => expected),
    );
  });

  it("fails closed for unknown stored paths and minimizes unsafe nested source values without suffix exemptions", () => {
    const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["source", "Call 555-0100 person@example.test Bearer secret", undefined],
      ["digital_footprint.source", "Call 555-0100", undefined],
      ["unknown.lei", "529900T8BM49AURSDO55", undefined],
      ["profile.intent.tender", { events: [] }, undefined],
      [
        "digital_footprint.structured_org",
        {
          name: "Acme Pump GmbH",
          source: "Call 555-0100 person@example.test Bearer secret",
        },
        { name: "Acme Pump GmbH" },
      ],
      [
        "identity",
        {
          name: "Acme Pump GmbH",
          country: "DE",
          source: "Call 555-0100 person@example.test Bearer secret",
          email: "person@example.test",
        },
        { name: "Acme Pump GmbH", country: "DE" },
      ],
    ];
    expect(cases.map(([field, value]) => sanitizeStored(field, value))).toEqual(
      cases.map(([, , expected]) => expected),
    );
  });

  it("applies one closed site-section key contract to Canonical and stored FieldEvidence values", () => {
    const sections = {
      products: 8,
      about: 2,
      ".well-known": 1,
      source: 1,
      notice: 1,
      contact: 1,
      "person@example.test": 1,
      "555-0100": 1,
      "٥٥٥-٠١٠٠": 1,
      "bearer-secret": 1,
      "%70roducts": 1,
      ["x".repeat(25)]: 1,
      Ａbout: 1,
    };
    const expectedBytes = '{".well-known":1,"about":2,"products":8}';

    expect(
      JSON.stringify(
        sanitizeStored("structured_harvest.site_sections", sections),
      ),
    ).toBe(expectedBytes);
    expect(
      JSON.stringify(
        sanitizeCanonicalCompanyAttributes({
          structured_harvest: { site_sections: sections },
        }),
      ),
    ).toBe('{"structured_harvest":{"site_sections":' + expectedBytes + "}}");
  });

  it("bounds site-section object width and integer counts at the real producer limits", () => {
    const twentyKeys = {
      ".well-known": 1,
      about: 1,
      blog: 1,
      careers: 1,
      company: 1,
      docs: 1,
      downloads: 1,
      events: 1,
      industries: 1,
      insights: 1,
      jobs: 1,
      news: 1,
      partners: 1,
      press: 1,
      products: 5000,
      publications: 1,
      resources: 1,
      services: 1,
      solutions: 1,
      support: 1,
    };
    expect(
      sanitizeStored("structured_harvest.site_sections", twentyKeys),
    ).toEqual(twentyKeys);
    expect(
      sanitizeStored("structured_harvest.site_sections", {
        ...twentyKeys,
        sustainability: 1,
      }),
    ).toBeUndefined();
    expect(
      sanitizeStored("structured_harvest.site_sections", {
        products: 5001,
        about: 0,
        careers: 1.5,
      }),
    ).toBeUndefined();
  });

  it("rejects Unicode-decimal local phones in ordinary retained scalar namespaces", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        digital_footprint: {
          safe: "industrial",
          nested: {
            name: "Acme ٥٥٥-٠١٠٠",
            url: "https://acme.example/company/٥٥٥-٠١٠٠",
          },
        },
      }),
    ).toEqual({ digital_footprint: { safe: "industrial" } });
  });

  it.each(
    semanticIdentifierCollisions.flatMap(
      (key) =>
        [
          [key, "Call 555-0100", "ASCII/local phone"],
          [key, "Call ٥٥٥-٠١٠٠", "Unicode/local phone"],
          [key, "Bearer secret", "secret marker"],
        ] as const,
    ),
  )(
    "withholds a %s collision carrying %s outside its owned full path",
    (key, unsafeValue) => {
      expect(
        sanitizeCanonicalCompanyAttributes({
          digital_footprint: {
            safe: "industrial",
            [key]: unsafeValue,
          },
        }),
      ).toEqual({ digital_footprint: { safe: "industrial" } });
    },
  );

  it("validates source, notice, and winner_identifier by their exact owned paths", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        digital_footprint: {
          safe: "industrial",
          source: "Call 555-0100",
        },
        structured_harvest: {
          hiring_signal: {
            source: "ats:greenhouse",
            open_roles: 2,
          },
        },
        ted: {
          publication_number: "123456-2026",
          cpv: ["42122130"],
          winner_identifier: "Call 555-0100",
        },
        intent: {
          events: [
            {
              type: "TENDER_PUBLISHED",
              at: "2026-08-26T00:00:00.000Z",
              strength: 0.9,
              evidence: {
                cpv: ["42122130"],
                notice: "Call ٥٥٥-٠١٠٠",
                source: "Bearer secret",
              },
            },
          ],
        },
      }),
    ).toEqual({
      digital_footprint: { safe: "industrial" },
      structured_harvest: {
        hiring_signal: {
          source: "ats:greenhouse",
          open_roles: 2,
        },
      },
      ted: {
        publication_number: "123456-2026",
        cpv: ["42122130"],
      },
      intent: {
        events: [
          {
            type: "TENDER_PUBLISHED",
            at: "2026-08-26T00:00:00.000Z",
            strength: 0.9,
            evidence: { cpv: ["42122130"] },
          },
        ],
      },
    });
  });

  it("preserves every currently owned identifier shape and closed source literal", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        wikidata_qid: "Q206894",
        osm_id: "relation/62422",
        ted: {
          publication_number: "123456-2026",
          cpv: ["42122130"],
          winner_identifier: "DE111",
        },
        fda: {
          registration_number: "3004512345",
          fei_number: "3012345678",
          owner_operator_numbers: ["10001234"],
          product_codes: ["LLZ"],
        },
        gleif: {
          lei: "529900T8BM49AURSDO55",
          legal_form_code: "8888",
          parent_lei: "5493001KJTIIGC8Y1R12",
          ultimate_parent_lei: "213800D1EI4B9WTWWD28",
        },
        wikidata: {
          qid: "Q123",
          parent_qid: "Q456",
          lei: "529900T8BM49AURSDO55",
          isin: "DE000BASF111",
        },
        structured_harvest: {
          hiring_signal: { source: "sitemap", open_roles: 1 },
        },
        intent: {
          events: [
            {
              type: "US_FED_SOURCES_SOUGHT",
              at: "2026-08-26T00:00:00.000Z",
              strength: 0.7,
              evidence: {
                naics: ["333914"],
                notice: "notice-1",
                source: "samgov",
              },
            },
            {
              type: "FDA_CLEARANCE",
              at: "2026-08-26T00:00:00.000Z",
              strength: 0.85,
              evidence: {
                product_code: "LLZ",
                k_number: "K123456",
                source: "openfda",
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      wikidata_qid: "Q206894",
      osm_id: "relation/62422",
      ted: { winner_identifier: "DE111" },
      fda: { registration_number: "3004512345" },
      gleif: { lei: "529900T8BM49AURSDO55" },
      wikidata: { qid: "Q123", isin: "DE000BASF111" },
      structured_harvest: { hiring_signal: { source: "sitemap" } },
      intent: {
        events: [
          { evidence: { notice: "notice-1", source: "samgov" } },
          { evidence: { k_number: "K123456", source: "openfda" } },
        ],
      },
    });
  });
});
