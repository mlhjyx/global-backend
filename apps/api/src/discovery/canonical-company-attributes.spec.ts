import { describe, expect, it } from "vitest";
import { sanitizeCanonicalCompanyAttributes } from "./canonical-company-attributes";

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
    semanticIdentifierCollisions.flatMap((key) => [
      [key, "Call 555-0100", "ASCII/local phone"],
      [key, "Call ٥٥٥-٠١٠٠", "Unicode/local phone"],
      [key, "Bearer secret", "secret marker"],
    ] as const),
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
