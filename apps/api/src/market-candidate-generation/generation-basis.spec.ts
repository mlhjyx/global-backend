import { describe, expect, it } from "vitest";
import {
  assertGenerationInput,
  buildGenerationBasis,
  normalizeGenerationPrepare,
} from "./generation-basis";
const W = "11111111-1111-4111-8111-111111111111",
  C = "22222222-2222-4222-8222-222222222222";
const O = "33333333-3333-4333-8333-333333333333",
  K = "44444444-4444-4444-8444-444444444444",
  I = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-20T12:00:00.000Z"),
  context = { workspaceId: W, companyId: C };
function rows() {
  return {
    company: {
      id: C,
      workspaceId: W,
      version: 1,
      name: "Fixture seller",
      website: "https://seller.example.test",
      industry: null,
      industryCode: null,
      summary: "capacity unknown",
      targetMarkets: [] as string[],
      deletedAt: null,
      businessEmail: "never-input",
      publicContacts: [{ value: "never-input" }],
    },
    offerings: [
      {
        id: O,
        workspaceId: W,
        companyId: C,
        name: "Component",
        description: "conditional supply",
        attributes: { n: 7, a: "原值" },
        sourceUrl: "never-input",
        evidence: "never-input",
        confidence: 0.9,
      },
    ],
    claims: [
      {
        id: K,
        workspaceId: W,
        companyId: C,
        version: 1,
        status: "APPROVED",
        type: "capability",
        statement: "Original capacity is not verified",
        validUntil: null,
        verifiedAt: new Date("2026-11-20T00:00:00.000Z"),
        verificationMethod: "manual",
        verifiedBy: "never-input",
        verificationProof: { value: "never-input" },
      },
    ],
  };
}
const expectedMaterial = {
  schemaVersion: "market-candidate-generation-input/v1",
  company: {
    id: C,
    version: 1,
    name: "Fixture seller",
    website: "https://seller.example.test",
    industry: null,
    industryCode: null,
    summary: "capacity unknown",
    declaredTargetMarkets: [],
  },
  offerings: [
    {
      basisKey: `OFFERING:${O}`,
      sourceId: O,
      usedFieldsDigest:
        "eb5a973b9c6ddc885b91e21e3c033b48d4a6dae662ed9aabc78c1825bda1bd88",
      name: "Component",
      description: "conditional supply",
      attributesCanonicalJson: '{"a":"原值","n":7}',
    },
  ],
  claims: [
    {
      basisKey: `CLAIM:${K}`,
      sourceId: K,
      usedFieldsDigest:
        "828a4d9794249471e5dd1827bc41fd7854dd69875e53fe901dc3e43e45ada192",
      version: 1,
      status: "APPROVED",
      type: "capability",
      statement: "Original capacity is not verified",
      validUntil: null,
      verifiedAt: "2026-11-20T00:00:00.000Z",
      verificationMethod: "manual",
    },
  ],
};
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;

describe("generation basis uses complete selected server material, never an imported candidate", () => {
  it("maps every selected actual field, canonicalizes complete attributes and excludes unselected contact/proof fields", () => {
    const input = rows(),
      before = structuredClone(input),
      result = buildGenerationBasis(context, input, NOW);
    expect(result.inputMaterial).toEqual(expectedMaterial);
    expect(input).toEqual(before);
    expect(JSON.stringify(result.inputMaterial)).not.toContain("never-input");
    expect(result.descriptors.company).toEqual({ companyId: C, version: 1 });
    expect(result.descriptors.sources.map((s) => s.key)).toEqual([
      `CLAIM:${K}`,
      `OFFERING:${O}`,
    ]);
    expect(result.sources).toEqual([
      { kind: "CLAIM", sourceId: K },
      { kind: "OFFERING", sourceId: O },
    ]);
    expect(result.inputMaterialDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("normalizes intent UUIDs, de-duplicates references by kind and sorts without requiring country or a promoted product", () => {
    expect(
      normalizeGenerationPrepare({
        intentId: I.toUpperCase(),
        offeringIds: [O.toUpperCase(), O],
        claimIds: [K, K],
      }),
    ).toEqual({ intentId: I, offeringIds: [O], claimIds: [K] });
    expect(normalizeGenerationPrepare({ intentId: I })).toEqual({
      intentId: I,
    });
    expect(
      normalizeGenerationPrepare({
        intentId: I,
        offeringIds: [],
        claimIds: [],
      }),
    ).toEqual({ intentId: I, offeringIds: [], claimIds: [] });
  });
  it.each([
    { intentId: I, candidates: [] },
    { intentId: I, actor: W },
    { intentId: I, country: "DE" },
    { intentId: I, offeringIds: ["fake"] },
    { intentId: I, claimIds: [K], verified: true },
  ])("rejects undeclared input or fake source identity %#", (input) => {
    expect(() => normalizeGenerationPrepare(input)).toThrow();
  });
  it("rejects 201 distinct references after normalization but permits duplicate intent references within the actual 200 bound", () => {
    expect(() =>
      normalizeGenerationPrepare({
        intentId: I,
        offeringIds: Array.from({ length: 200 }, (_, i) => id(i + 1)),
        claimIds: [K],
      }),
    ).toThrow();
    expect(
      normalizeGenerationPrepare({
        intentId: I,
        offeringIds: Array(201).fill(O),
        claimIds: [K],
      }).offeringIds,
    ).toEqual([O]);
  });
  it("does not execute getters or accept sparse/proxied request arrays", () => {
    let reads = 0;
    const value = {};
    Object.defineProperty(value, "intentId", {
      enumerable: true,
      get() {
        reads++;
        return I;
      },
    });
    expect(() => normalizeGenerationPrepare(value)).toThrow();
    expect(reads).toBe(0);
    expect(() =>
      normalizeGenerationPrepare({ intentId: I, offeringIds: new Array(1) }),
    ).toThrow();
    expect(() =>
      normalizeGenerationPrepare(new Proxy({ intentId: I }, {})),
    ).toThrow();
  });
  it("requires existing supply and an actually APPROVED, unexpired claim rather than generating an empty success", () => {
    const input = rows();
    expect(() =>
      buildGenerationBasis(context, { ...input, offerings: [] }, NOW),
    ).toThrow();
    expect(() =>
      buildGenerationBasis(context, { ...input, claims: [] }, NOW),
    ).toThrow(/NO_APPROVED_CLAIMS/u);
    expect(() =>
      buildGenerationBasis(
        context,
        { ...input, claims: [{ ...input.claims[0], status: "EXTRACTED" }] },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      buildGenerationBasis(
        context,
        {
          ...input,
          claims: [
            {
              ...input.claims[0],
              validUntil: new Date("2026-11-19T00:00:00.000Z"),
            },
          ],
        },
        NOW,
      ),
    ).toThrow();
  });
  it("rejects a deleted or cross-workspace/company source rather than silently filtering it", () => {
    const input = rows();
    expect(() =>
      buildGenerationBasis(
        context,
        { ...input, company: { ...input.company, deletedAt: NOW } },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      buildGenerationBasis(
        context,
        { ...input, offerings: [{ ...input.offerings[0], workspaceId: I }] },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      buildGenerationBasis(
        context,
        { ...input, claims: [{ ...input.claims[0], companyId: I }] },
        NOW,
      ),
    ).toThrow();
  });
  it("accepts exactly 200 source references and rejects 201 without truncating the returned material", () => {
    const input = rows();
    const offerings = Array.from({ length: 199 }, (_, i) => ({
      ...input.offerings[0],
      id: id(i + 1),
    }));
    const result = buildGenerationBasis(context, { ...input, offerings }, NOW);
    expect(result.inputMaterial.offerings).toHaveLength(199);
    expect(result.descriptors.sources).toHaveLength(200);
    expect(() =>
      buildGenerationBasis(
        context,
        {
          ...input,
          offerings: [...offerings, { ...input.offerings[0], id: id(200) }],
        },
        NOW,
      ),
    ).toThrow();
  });
  it("measures the complete canonical UTF8 wrapper at exactly 262144 bytes, not just statement strings", () => {
    const input = rows();
    const independent = structuredClone(expectedMaterial);
    independent.company.summary = "";
    const pad = 262144 - Buffer.byteLength(JSON.stringify(independent), "utf8");
    input.company.summary = "a".repeat(pad);
    const result = buildGenerationBasis(context, input, NOW);
    expect(
      Buffer.byteLength(JSON.stringify(result.inputMaterial), "utf8"),
    ).toBe(262144);
    expect(result.inputMaterial.company.summary).toHaveLength(pad);
    input.company.summary += "a";
    expect(() => buildGenerationBasis(context, input, NOW)).toThrow();
  });
  it("charges Chinese, escaping and every complete attribute value to the input limit without summarizing or slicing", () => {
    const input = rows();
    input.company.summary = "中".repeat(90000);
    expect(() => buildGenerationBasis(context, input, NOW)).toThrow();
    const compact = rows();
    compact.offerings[0].attributes = {
      n: 7,
      a: (String.fromCharCode(34, 92, 10) + "原").repeat(50),
    };
    const result = buildGenerationBasis(context, compact, NOW);
    expect(
      JSON.parse(result.inputMaterial.offerings[0].attributesCanonicalJson!),
    ).toEqual(compact.offerings[0].attributes);
  });
  it("retains empty declared markets and rejects 257 values instead of preselecting or dropping them", () => {
    expect(
      buildGenerationBasis(context, rows(), NOW).inputMaterial.company
        .declaredTargetMarkets,
    ).toEqual([]);
    const input = rows();
    input.company.targetMarkets = Array(257).fill("seller-declared");
    expect(() => buildGenerationBasis(context, input, NOW)).toThrow();
  });
  it("binds used-field and full-input digests to actual inputs, but not unselected private metadata", () => {
    const input = rows(),
      before = buildGenerationBasis(context, input, NOW);
    const changed = rows();
    changed.offerings[0].attributes.n = 8;
    expect(
      buildGenerationBasis(context, changed, NOW).inputMaterialDigest,
    ).not.toBe(before.inputMaterialDigest);
    input.company.businessEmail = "other-private";
    input.claims[0].verifiedBy = "other-private";
    input.offerings[0].sourceUrl = "other-private";
    expect(buildGenerationBasis(context, input, NOW).inputMaterialDigest).toBe(
      before.inputMaterialDigest,
    );
    const company = rows();
    company.company.summary += " changed";
    expect(
      buildGenerationBasis(context, company, NOW).inputMaterialDigest,
    ).not.toBe(before.inputMaterialDigest);
  });
  it("validates the closed actual input schema and fails closed on a schema compiler error", () => {
    expect(assertGenerationInput(expectedMaterial)).toEqual(expectedMaterial);
    expect(() =>
      assertGenerationInput({
        ...expectedMaterial,
        privateField: "not-allowed",
      }),
    ).toThrow();
    expect(() =>
      assertGenerationInput(expectedMaterial, {
        type: "not-a-json-schema-type",
      }),
    ).toThrow("MODEL_OUTPUT_SCHEMA_INVALID");
    const forged = structuredClone(expectedMaterial);
    forged.offerings[0].usedFieldsDigest = "f".repeat(64);
    expect(() => assertGenerationInput(forged)).toThrow();
  });
});
