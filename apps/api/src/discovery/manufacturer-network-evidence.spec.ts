import { describe, expect, it } from "vitest";
import {
  readManufacturerNetworkEvidence,
  currentManufacturerEvidence,
  parseManufacturerDetail,
} from "./manufacturer-network-evidence";
import {
  readManufacturerNetworkSources,
  manufacturerIndependence,
  manufacturerSourceForUrl,
} from "./manufacturer-network-sources";
import {
  currentEvidenceBundle,
  entriesFromStoredAttributes,
} from "./evidence-bundle";
import { prepareJudgeCall } from "./judgment/judge-run";
import { validateEvidence } from "./judgment/evidence-validate";
import { CRITERION_IDS } from "./judgment/fit-rubric";
import {
  COMPANY_INPUT,
  CONFIG,
  EVIDENCE,
  NOW,
  PAGE_URL,
  POLICY_ROW,
  SPAN,
  TEXT,
  WS,
  COMPANY,
} from "./manufacturer-network.test-fixture";
const parse = (text = TEXT) =>
  parseManufacturerDetail({
    text,
    source: CONFIG.sources[0]!,
    company: COMPANY_INPUT,
  });
describe("manufacturer closed source/evidence contracts", () => {
  it("accepts a deterministic named detail with country, website and relationship", () =>
    expect(parse()).toMatchObject({ spans: [SPAN] }));
  it.each([
    TEXT.replace("Country: Germany", "Country: France"),
    TEXT.replace("https://acme.example/", "https://wrong.example/"),
    TEXT.replace("# Acme Pumps GmbH", "# Other Pumps GmbH"),
    TEXT.replace(SPAN, "Distributor"),
    TEXT.replace(SPAN, "Branches\nDistributors"),
  ])("keeps unverifiable identity/role UNKNOWN", (text) =>
    expect(parse(text)).toBeUndefined(),
  );
  it("does not infer independence from distinct domains", () =>
    expect(
      manufacturerIndependence(
        { ...CONFIG, independenceAttestations: [] },
        CONFIG.sources[0]!,
        { workspaceId: WS, companyId: COMPANY, domain: "acme.example" },
        NOW,
      ),
    ).toBeUndefined());
  it.each([
    { ...POLICY_ROW, reviewStatus: "SUSPENDED" },
    { ...POLICY_ROW, allowedPaths: null },
    { ...POLICY_ROW, allowedPurpose: ["discovery"] },
    { ...POLICY_ROW, termsStatus: "UNREVIEWED" },
    { ...POLICY_ROW, disallowedPaths: ["/en/locations"] },
  ])("requires current explicit source/path/purpose review", (p) =>
    expect(
      manufacturerSourceForUrl(PAGE_URL, CONFIG.sources, [p], NOW),
    ).toBeUndefined(),
  );
  it("rejects unknown source/template fields", () =>
    expect(
      readManufacturerNetworkSources({
        ...CONFIG,
        sources: [{ ...CONFIG.sources[0], templateId: "freeform/v1" }],
      }),
    ).toBeUndefined());
  it("rejects forged PII-bearing evidence and unknown business schema fields", () => {
    expect(
      readManufacturerNetworkEvidence({
        ...EVIDENCE,
        spans: ["Contact Jane at jane@acme.example"],
      }),
    ).toBeUndefined();
    expect(
      readManufacturerNetworkEvidence({ ...EVIDENCE, attested: true }),
    ).toBeUndefined();
  });
  it.each([
    { ...COMPANY_INPUT, id: WS },
    { ...COMPANY_INPUT, country: "FR" },
    { ...COMPANY_INPUT, domain: "other.example" },
  ])("scopes evidence to the exact target", (co) =>
    expect(currentManufacturerEvidence(EVIDENCE, co, NOW)).toBeUndefined(),
  );
  it("does not refresh original capture time on replay", () =>
    expect(
      currentManufacturerEvidence(
        EVIDENCE,
        COMPANY_INPUT,
        new Date("2026-11-22T00:00:00.000Z"),
      ),
    ).toBeUndefined());
});
describe("manufacturer explicit negative status", () => {
  it.each([
    "Acme Pumps GmbH is no longer an authorized AESSEAL distributor.",
    "Acme Pumps GmbH is not an authorized AESSEAL distributor.",
    "Status: Revoked\n" + SPAN,
    "Status: Expired\n" + SPAN,
  ])(
    "does not infer current relationship from revoked/expired/negated page",
    (relation) => expect(parse(TEXT.replace(SPAN, relation))).toBeUndefined(),
  );
  it("honors a narrower suspended www policy", () =>
    expect(
      manufacturerSourceForUrl(
        PAGE_URL.replace("https://", "https://www."),
        CONFIG.sources,
        [
          POLICY_ROW,
          {
            ...POLICY_ROW,
            id: WS,
            domain: "www.manufacturer.example",
            reviewStatus: "SUSPENDED",
          },
        ],
        NOW,
      ),
    ).toBeUndefined());
});

describe("manufacturer qualified view and exact page quotes", () => {
  it("raw/canonical namespaces cannot fabricate T2", () =>
    expect(
      entriesFromStoredAttributes({
        manufacturer_network: { evidence: EVIDENCE },
      }),
    ).toEqual([]));
  it("adds T2 only from the verified explicit company field", () => {
    const bundle = currentEvidenceBundle(
      { ...COMPANY_INPUT, manufacturerEvidence: EVIDENCE } as never,
      NOW,
    );
    expect(
      bundle.entries.find((e) => e.source_key === "manufacturer_network"),
    ).toMatchObject({ tier: "T2", source_page: PAGE_URL });
  });
  it("exposes bounded verified spans in the actual judge input", () => {
    const p = prepareJudgeCall(
      { procurement_scenario: { id: "distribution" } } as never,
      { ...COMPANY_INPUT, manufacturerEvidence: EVIDENCE } as never,
      { now: NOW.toISOString() },
    );
    expect(p.snapshotText).toContain(SPAN);
    expect(p.urlPolicy(PAGE_URL).allowed).toBe(true);
    expect(p.urlPolicy(PAGE_URL + "/other").allowed).toBe(false);
  });
  it("cannot cite a first-party quote as if it were on the manufacturer page", () => {
    const criteria = CRITERION_IDS.map((id) => ({
      id,
      label: "yes",
      score: 1,
      rationale: "",
      evidence: [
        {
          kind: "directory",
          url: PAGE_URL,
          span: "We sell industrial pumps from our own warehouse.",
        },
      ],
    }));
    const report = validateEvidence(
      criteria as never,
      {
        now: NOW.toISOString(),
        snapshotFetchedAt: NOW.toISOString(),
        snapshotText: "We sell industrial pumps from our own warehouse.",
        urlPolicy: () => ({ allowed: true }),
        manufacturerEvidence: EVIDENCE,
      } as never,
      NOW,
    );
    expect(report.byCriterion.C2_ROLE.hasValidEvidence).toBe(false);
  });
});

describe("manufacturer company-only page spans", () => {
  it.each([
    "Contact person: Alice Example",
    "Managing Director: Alice Example",
    "Ansprechpartner: Alice Example",
  ])("withholds person-labelled relation lines", (label) => {
    expect(parse(TEXT.replace(SPAN, SPAN + " " + label))).toBeUndefined();
    expect(
      readManufacturerNetworkEvidence({
        ...EVIDENCE,
        spans: [SPAN + " " + label],
      }),
    ).toBeUndefined();
  });
});

describe("manufacturer single-company detail boundary", () => {
  it("does not treat a multi-company directory as a target detail artifact", () =>
    expect(
      parse(
        TEXT +
          "\n\n## Other Distribution GmbH\nCountry: Germany\nhttps://other.example/\nOther Distribution GmbH is an authorized AESSEAL distributor.",
      ),
    ).toBeUndefined());
});

describe("manufacturer target country scope", () => {
  it("does not use a later Germany navigation value for a France target profile", () =>
    expect(
      parse(TEXT.replace("Country: Germany", "Country: France") + "\nGermany"),
    ).toBeUndefined());
});
