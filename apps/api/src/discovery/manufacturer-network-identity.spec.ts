import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./company-suppression-gate", () => ({
  companyMayUseExternalProcessing: vi.fn(async () => true),
}));
import { companyMayUseExternalProcessing } from "./company-suppression-gate";
import {
  loadReviewedManufacturerLegalNames,
  manufacturerIdentityValueSha256,
} from "./manufacturer-network-identity";
import {
  WS,
  COMPANY,
  NOW,
  COMPANY_INPUT,
} from "./manufacturer-network.test-fixture";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const value = "Acme Industrial Supplies GmbH";
const reference = {
  fieldEvidenceId: ID,
  valueSha256: manufacturerIdentityValueSha256(value),
};
function harness(
  patch: Record<string, unknown> = {},
  companyPatch: Record<string, unknown> = {},
) {
  const row = {
    id: ID,
    value,
    field: "website_profile.legal_name",
    providerKey: "website_profile",
    sourceUrl: "https://acme.example/impressum",
    license: "public",
    allowedActions: ["display", "match"],
    dataClass: "green",
    fetchedAt: new Date("2026-11-19T00:00:00.000Z"),
    ...patch,
  };
  const tx = {
    canonicalCompany: {
      findFirst: vi.fn(async () => ({ ...COMPANY_INPUT, ...companyPatch })),
    },
    fieldEvidence: { findMany: vi.fn(async () => [row]) },
    sourcePolicy: {
      findUnique: vi.fn(async () => ({
        sourceType: "gov_registry",
        reviewStatus: "APPROVED",
        termsStatus: "REVIEWED_OK",
        allowedPurpose: ["enrichment"],
      })),
    },
  };
  return { tx, row };
}
const subject = {
  workspaceId: WS,
  companyId: COMPANY,
  domain: "acme.example",
  country: "DE",
};
beforeEach(() =>
  vi.mocked(companyMayUseExternalProcessing).mockResolvedValue(true),
);
describe("reviewed independent manufacturer target legal names", () => {
  it("pins original UTF-8 value hashing without JSON or normalization", () => {
    expect(manufacturerIdentityValueSha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(manufacturerIdentityValueSha256("Acme GmbH")).not.toBe(
      manufacturerIdentityValueSha256('"Acme GmbH"'),
    );
  });
  it("dereferences exact scoped green own-site field, never a bare alias", async () => {
    const { tx } = harness();
    expect(
      await loadReviewedManufacturerLegalNames(
        tx as never,
        subject,
        [reference],
        NOW,
      ),
    ).toEqual([{ value, reference, fetchedAt: "2026-11-19T00:00:00.000Z" }]);
    expect(tx.fieldEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WS,
          entityType: "company",
          entityId: COMPANY,
          id: { in: [ID] },
        }),
      }),
    );
    expect(
      await loadReviewedManufacturerLegalNames(tx as never, subject, [], NOW),
    ).toBeUndefined();
  });
  it.each([
    { value: "Changed legal name GmbH" },
    { dataClass: "red" },
    { allowedActions: ["display"] },
    { license: "sandbox" },
    { sourceUrl: "https://manufacturer.example/target" },
    { providerKey: "manufacturer_network" },
    { field: "attributes" },
    { fetchedAt: new Date("2026-10-01T00:00:00.000Z") },
    { fetchedAt: new Date("2026-11-21T00:00:00.000Z") },
    { sourceUrl: null },
    { value: 42 },
  ])(
    "rejects drift, rights, publisher-self-identity and stale/future fields",
    async (patch) => {
      const { tx } = harness(patch);
      expect(
        await loadReviewedManufacturerLegalNames(
          tx as never,
          subject,
          [reference],
          NOW,
        ),
      ).toBeUndefined();
    },
  );
  it.each([{ domain: "wrong.example" }, { country: "FR" }])(
    "requires current canonical domain/country binding",
    async (patch) => {
      const { tx } = harness({}, patch);
      expect(
        await loadReviewedManufacturerLegalNames(
          tx as never,
          subject,
          [reference],
          NOW,
        ),
      ).toBeUndefined();
    },
  );
  it("requires an unsuppressed target and an existing reference", async () => {
    const { tx } = harness();
    vi.mocked(companyMayUseExternalProcessing).mockResolvedValue(false);
    expect(
      await loadReviewedManufacturerLegalNames(
        tx as never,
        subject,
        [reference],
        NOW,
      ),
    ).toBeUndefined();
    vi.mocked(companyMayUseExternalProcessing).mockResolvedValue(true);
    tx.fieldEvidence.findMany.mockResolvedValue([]);
    expect(
      await loadReviewedManufacturerLegalNames(
        tx as never,
        subject,
        [reference],
        NOW,
      ),
    ).toBeUndefined();
  });
  it("permits an explicitly approved independent GLEIF legal record only with matching country", async () => {
    const { tx } = harness(
      {
        field: "gleif.legal_name",
        providerKey: "gleif",
        sourceUrl: "https://search.gleif.org/record/acme",
      },
      { attributes: { gleif: { registered_country: "DE" } } },
    );
    expect(
      await loadReviewedManufacturerLegalNames(
        tx as never,
        subject,
        [reference],
        NOW,
      ),
    ).toHaveLength(1);
    tx.sourcePolicy.findUnique.mockResolvedValue({
      sourceType: "gov_registry",
      reviewStatus: "SUSPENDED",
      termsStatus: "REVIEWED_OK",
      allowedPurpose: ["enrichment"],
    });
    expect(
      await loadReviewedManufacturerLegalNames(
        tx as never,
        subject,
        [reference],
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("whole legal name formatting equality", () => {
  it("normalizes complete names only and never drops words or legal forms", async () => {
    const { manufacturerNameKey } =
      await import("./manufacturer-network-sources");
    expect(manufacturerNameKey("Alpine Industrial Supply GMBH")).toBe(
      manufacturerNameKey("Alpine IndustrialSupply GmbH"),
    );
    expect(manufacturerNameKey("Alpine")).not.toBe(
      manufacturerNameKey("Alpine IndustrialSupply GmbH"),
    );
    expect(manufacturerNameKey("Alpine IndustrialSupply AG")).not.toBe(
      manufacturerNameKey("Alpine IndustrialSupply GmbH"),
    );
  });
});
