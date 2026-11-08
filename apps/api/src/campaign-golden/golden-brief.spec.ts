import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_BRIEF_SCHEMA_VERSION,
  loadGoldenBriefs,
  parseGoldenBriefAsset,
  type GoldenBriefAsset,
} from "./golden-brief";

const ASSETS_DIR = join(import.meta.dirname, "../../../../evals/golden-campaign-briefs");

const VALID_ASSET = {
  schemaVersion: GOLDEN_BRIEF_SCHEMA_VERSION,
  id: "99-test-brief",
  brief: {
    industry: "test industry",
    country: "DE",
    objective: "测试目标",
    icpSummary: "测试 ICP",
    budgetCapMicros: 1_000_000,
    language: "de",
  },
  expectations: {
    planSchemaVersion: "campaign-plan/v0",
    requiredFields: ["goal.objective"],
    forbiddenFields: ["motions.0.send"],
    forbiddenContent: ["proforma"],
    budgetRespect: { currency: "USD" },
    decisionPolicy: { maxReplansMax: 2 },
    motionTypes: ["discovery"],
  },
};

function issuesOf(mutate: (candidate: Record<string, unknown>) => void): readonly string[] {
  const candidate = JSON.parse(JSON.stringify(VALID_ASSET)) as Record<string, unknown>;
  mutate(candidate);
  return parseGoldenBriefAsset(candidate).issues.map((issue) => issue.message);
}

describe("parseGoldenBriefAsset", () => {
  it("accepts the documented shape", () => {
    const parsed = parseGoldenBriefAsset(VALID_ASSET);
    expect(parsed.issues).toEqual([]);
    expect(parsed.asset?.id).toBe("99-test-brief");
  });

  it("rejects unknown fields at every level", () => {
    expect(issuesOf((asset) => (asset["extra"] = true)).join()).toContain("unknown field: extra");
    expect(
      issuesOf((asset) => ((asset["brief"] as Record<string, unknown>)["pii"] = "x")).join(),
    ).toContain("unknown brief field: pii");
    expect(
      issuesOf(
        (asset) => ((asset["expectations"] as Record<string, unknown>)["extra"] = 1),
      ).join(),
    ).toContain("unknown expectations field: extra");
  });

  it("validates ids, countries, budgets and languages", () => {
    expect(issuesOf((asset) => (asset["id"] = "bad id")).join()).toContain("id must match");
    expect(
      issuesOf((asset) => ((asset["brief"] as Record<string, unknown>)["country"] = "de")).join(),
    ).toContain("two-letter ISO country code");
    expect(
      issuesOf((asset) => ((asset["brief"] as Record<string, unknown>)["budgetCapMicros"] = 0)).join(),
    ).toContain("positive integer");
    expect(
      issuesOf((asset) => ((asset["brief"] as Record<string, unknown>)["language"] = "DEU")).join(),
    ).toContain("language tag");
  });

  it("validates expectations (regexes compile, arrays non-empty)", () => {
    expect(
      issuesOf(
        (asset) =>
          ((asset["expectations"] as Record<string, unknown>)["forbiddenContent"] = ["("]),
      ).join(),
    ).toContain("invalid regex");
    expect(
      issuesOf((asset) => ((asset["expectations"] as Record<string, unknown>)["requiredFields"] = [])).join(),
    ).toContain("must not be empty");
  });
});

describe("shipped golden campaign briefs", () => {
  const loaded = loadGoldenBriefs(ASSETS_DIR);

  it("loads the six first-batch briefs without issues", () => {
    expect(loaded.issues).toEqual([]);
    expect(loaded.assets.map((asset: GoldenBriefAsset) => asset.id).sort()).toEqual([
      "01-de-thermoforming-medical",
      "02-de-thermoforming-automotive",
      "03-us-electronics-ems",
      "04-us-electronics-industrial-controls",
      "05-de-industrial-parts-hydraulics",
      "06-de-industrial-parts-bearings",
    ]);
  });

  it("keeps the first batch within the approved content scope (DE/US, no tenants or persons)", () => {
    for (const asset of loaded.assets) {
      expect(["DE", "US"]).toContain(asset.brief.country);
      expect(asset.brief.budgetCapMicros).toBeGreaterThan(0);
      expect(asset.brief.icpSummary.length).toBeLessThanOrEqual(500);
    }
    const byCountry = loaded.assets.reduce<Record<string, number>>((acc, asset) => {
      acc[asset.brief.country] = (acc[asset.brief.country] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCountry).toEqual({ DE: 4, US: 2 });
  });

  it("every brief forbids send/document semantics and allows bounded replans", () => {
    for (const asset of loaded.assets) {
      expect(asset.expectations.forbiddenFields).toContain("motions.0.send");
      expect(asset.expectations.motionTypes).toEqual(["discovery"]);
      expect(asset.expectations.decisionPolicy?.maxReplansMax).toBe(2);
      expect(asset.expectations.forbiddenContent?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("rejects a directory with duplicate ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-briefs-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(VALID_ASSET));
      writeFileSync(join(dir, "b.json"), JSON.stringify(VALID_ASSET));
      const result = loadGoldenBriefs(dir);
      expect(result.issues.map((issue) => issue.message).join()).toContain("duplicate golden brief id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports broken JSON files without dropping the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-briefs-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(VALID_ASSET));
      writeFileSync(join(dir, "b.json"), "{broken");
      const result = loadGoldenBriefs(dir);
      expect(result.assets).toHaveLength(1);
      expect(result.issues.map((issue) => issue.message).join()).toContain("invalid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
