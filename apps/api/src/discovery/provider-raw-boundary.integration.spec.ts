import { describe, expect, it } from "vitest";
import { mapDirectoryCompanyToRecord } from "./providers/directory.provider";
import { mapEstablishmentToRecord } from "./providers/openfda.provider";
import { mapOsmPlaceToRecord } from "./providers/osm.provider";
import { mapPublicWebCompanyToRecord } from "./providers/public-web.provider";
import { mapNoticeToRecords } from "./providers/ted.provider";
import { mapTradeFairExhibitorToRecord } from "./providers/trade-fair.provider";
import { mapWikidataCompanyToRecord } from "./providers/wikidata.provider";
import {
  prepareRawSourceBatch,
  type RawSourcePolicySnapshot,
} from "./raw-source-ingestion";

const NOW = "2026-08-25T12:00:00.000Z";
const LIMITS = {
  maxRecordBytes: 16_384,
  maxBatchBytes: 128_000,
  defaultRetentionDays: 30,
};

function policies(domain: string): RawSourcePolicySnapshot[] {
  return [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      domain,
      retentionDays: 90,
      reviewStatus: "APPROVED",
      allowedPurpose: ["discovery"],
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    },
  ];
}

function prepare(providerKey: string, record: unknown, policyDomain: string) {
  return prepareRawSourceBatch({
    providerKey,
    records: [record],
    policies: policies(policyDomain),
    limits: LIMITS,
    now: new Date(NOW),
  }).rows[0]!;
}

describe("actual provider mapper output → governed Raw boundary", () => {
  it("keeps Directory consumer output intact while withholding listing prose from Raw", () => {
    const mapped = mapDirectoryCompanyToRecord({
      company: {
        name: "Johnson Controls",
        website: "https://johnsoncontrols.example/",
        location: "Milwaukee, Wisconsin",
        detail_url: "https://directory.example/members/johnson-controls",
      },
      listKind: "association_members",
      pageUrl: "https://directory.example/members",
      sourceClass: "industry_data",
    });
    expect(mapped.attributes).toMatchObject({
      listing_location: "Milwaukee, Wisconsin",
      source_kind: "association_members",
    });

    const row = prepare("directory", mapped, "directory.example");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "Johnson Controls",
      attributes: expect.objectContaining({
        source_directory: "directory.example",
        source_class: "industry_data",
      }),
    });
    expect(JSON.stringify(row.payload)).not.toContain("Milwaukee");

    const withoutWebsite = mapDirectoryCompanyToRecord({
      company: { name: "Parker Hannifin" },
      listKind: "association_members",
      pageUrl: "https://directory.example/members",
      sourceClass: "industry_data",
    });
    expect(
      prepare("directory", withoutWebsite, "directory.example"),
    ).toMatchObject({
      ingestStatus: "ACCEPTED",
      externalId: expect.stringMatching(
        /^directory:directory\.example:parker-hannifin$/u,
      ),
    });
  });

  it("keeps openFDA fit/intent mapper facts while Raw stores only structured codes", () => {
    const mapped = mapEstablishmentToRecord(
      {
        registrationNumber: "3004512345",
        feiNumber: "3004512345",
        name: "Parker Hannifin",
        country: "US",
        city: "Cleveland",
        stateCode: "OH",
        statusCode: "1",
        establishmentTypes: ["Manufacture Medical Device"],
        initialImporter: false,
        productCodes: ["LLZ"],
        deviceFacts: {
          deviceName: "Industrial Pump System",
          deviceClass: "2",
          medicalSpecialtyDescription: "Radiology",
          regulationNumber: "892.2050",
        },
        deviceNames: ["Industrial Pump System"],
        ownerOperatorNumbers: ["9012345"],
        createdDate: "2009-03-01",
      },
      NOW,
    );
    expect(mapped).toMatchObject({
      industry: "Radiology",
      attributes: {
        products: ["Industrial Pump System"],
        fda: expect.objectContaining({
          city: "Cleveland",
          disclaimer: expect.any(String),
        }),
      },
    });

    const row = prepare("openfda", mapped, "api.fda.gov");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "Parker Hannifin",
      license: "CC0-1.0",
      attributes: {
        products: ["LLZ"],
        fda: expect.objectContaining({ product_codes: ["LLZ"] }),
      },
    });
    expect(JSON.stringify(row.payload)).not.toMatch(
      /Cleveland|Radiology|disclaimer|device_facts/u,
    );
  });

  it("keeps OSM consumer location/tags while Raw stores only coordinates and OSM id", () => {
    const mapped = mapOsmPlaceToRecord({
      place: {
        osmId: "node/1",
        name: "General Dynamics",
        website: "https://generaldynamics.example/",
        countryCode: "US",
        city: "Reston",
        latitude: 38.95,
        longitude: -77.35,
        tags: { operator: "General Dynamics", phone: "555-0100" },
      },
      sourceClass: "industry_data",
      fetchedAt: NOW,
    });
    expect(mapped.attributes).toMatchObject({
      city: "Reston",
      osm_tags: expect.any(Object),
    });

    const row = prepare("openstreetmap", mapped, "overpass-api.de");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "General Dynamics",
      license: "ODbL-1.0",
      attributes: {
        osm_id: "node/1",
        latitude: 38.95,
        longitude: -77.35,
        source_class: "industry_data",
      },
      provenance: {
        sourceUrl: "https://overpass-api.de/api/interpreter",
      },
    });
    expect(JSON.stringify(row.payload)).not.toMatch(/Reston|555-0100/u);
  });

  it("keeps PublicWeb consumer industry/evidence while Raw stores digest and controlled terms", () => {
    const mapped = mapPublicWebCompanyToRecord({
      domain: "acme.example",
      homeUrl: "https://acme.example/",
      sourceText: "Acme industrial pump systems",
      extracted: {
        is_company_site: true,
        name: "Acme Industrial",
        country: "DE",
        industry: "Industrial machinery",
        employee_count: 120,
        products: ["industrial pump"],
        keywords: ["industrial"],
        evidence: "Free-form evidence must stay outside Raw",
        confidence: 0.9,
      },
      sourceClass: "public_intelligence",
      fetchedAt: NOW,
    });
    expect(mapped).toMatchObject({
      industry: "Industrial machinery",
      attributes: { extraction_evidence: expect.any(String) },
    });

    const row = prepare("public_web", mapped, "acme.example");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      attributes: expect.objectContaining({
        products: ["industrial pump"],
        extraction_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    });
    expect(JSON.stringify(row.payload)).not.toMatch(
      /Free-form evidence|Industrial machinery/u,
    );
  });

  it("keeps TED attribution/buyer consumer fields while Raw stores structured notice facts", () => {
    const mapped = mapNoticeToRecords(
      {
        publicationNumber: "123456-2026",
        publicationDate: "2026-08-25+02:00",
        noticeType: "can-standard",
        formType: "result",
        cpvCodes: ["42122000"],
        buyerNames: ["City of Munich"],
        buyerCountries: ["DEU"],
        winners: [
          {
            name: "Johnson Controls",
            country: "DEU",
            city: "Berlin",
            identifier: "DE111",
            internetAddress: "https://johnsoncontrols.example/",
          },
        ],
      },
      NOW,
    )[0]!;
    expect(mapped.attributes).toMatchObject({
      ted: expect.objectContaining({
        buyer_names: ["City of Munich"],
        winner_city: "Berlin",
        attribution: expect.any(String),
      }),
    });

    const row = prepare("ted", mapped, "api.ted.europa.eu");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "Johnson Controls",
      license: "CC BY 4.0",
      attributes: {
        ted: expect.objectContaining({
          publication_number: "123456-2026",
          cpv: ["42122000"],
        }),
      },
      provenance: {
        sourceUrl: "https://api.ted.europa.eu/v3/notices/search",
      },
    });
    expect(JSON.stringify(row.payload)).not.toMatch(
      /City of Munich|Berlin|attribution/u,
    );
  });

  it("keeps TradeFair contact/description consumer output while Raw withholds it", () => {
    const mapped = mapTradeFairExhibitorToRecord({
      fair: {
        slug: "fair-2026",
        name: "Industrial Fair 2026",
        exhibitorUrl: "https://fair.example/exhibitors",
      },
      exhibitor: {
        externalId: "ex-1",
        companyName: "Parker Hannifin",
        website: "https://parker.example/",
        country: "US",
        email: "sales@parker.example",
        phone: "555-0100",
        stand: "A42",
        products: ["industrial pump"],
        description: "Free-form company description",
        hiring: true,
      },
      sourceClass: "industry_data",
      fetchedAt: NOW,
    });
    expect(mapped.attributes).toMatchObject({
      public_email: "sales@parker.example",
      public_phone: "555-0100",
      description: "Free-form company description",
      source_fair_name: "Industrial Fair 2026",
    });

    const row = prepare("trade_fair", mapped, "fair.example");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "Parker Hannifin",
      attributes: expect.objectContaining({
        products: ["industrial pump"],
        source_fair: "fair-2026",
      }),
    });
    expect(JSON.stringify(row.payload)).not.toMatch(
      /sales@|555-0100|Free-form company description|Industrial Fair 2026/u,
    );
  });

  it("keeps Wikidata mapper provenance contract while Raw normalizes its digest/license", () => {
    const mapped = mapWikidataCompanyToRecord({
      company: {
        qid: "Q123",
        name: "General Dynamics",
        website: "https://generaldynamics.example/",
        countryCode: "US",
        employees: 10_000,
        latitude: 38.95,
        longitude: -77.35,
      },
      sourceClass: "company_registry",
      fetchedAt: NOW,
    });
    expect(mapped).toMatchObject({
      provenance: {
        sourceUrl: "https://www.wikidata.org/wiki/Q123",
        contentHash: "Q123",
      },
    });
    expect(mapped.license).toBeUndefined();

    const row = prepare("wikidata", mapped, "www.wikidata.org");
    expect(row.ingestStatus).toBe("ACCEPTED");
    expect(row.payload).toMatchObject({
      name: "General Dynamics",
      license: "CC0-1.0",
      provenance: {
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });
});
