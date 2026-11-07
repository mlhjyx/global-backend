import { describe, expect, it } from "vitest";
import { validatePackManifest, type PackValidationIssue } from "./pack-manifest";

const COMPLIANCE_CONTEXT = { packType: "compliance", directory: "eu_dual_use_screen" } as const;

function compliancePack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packKey: "compliance.eu_dual_use_screen",
    packType: "compliance",
    version: "1.0.0",
    title: "欧盟双用途复核",
    description: "合规护栏示例",
    priorityClass: "compliance",
    owner: "OWN-BUYER-BE",
    license: "Proprietary",
    rules: [
      {
        id: "r1",
        effect: "require_approval",
        appliesTo: { phases: ["create"] },
        rationale: "对外材料需人工复核",
        sources: [{ label: "internal policy" }],
      },
    ],
    sources: [{ label: "internal policy", retrievedAt: "2026-11-08" }],
    exitPlan: "review annually",
    ...overrides,
  };
}

function codes(issues: readonly PackValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("validatePackManifest", () => {
  it("accepts a well-formed compliance pack", () => {
    expect(validatePackManifest(compliancePack(), COMPLIANCE_CONTEXT)).toEqual([]);
  });

  it("rejects unknown pack types and schema violations", () => {
    expect(codes(validatePackManifest(compliancePack(), { packType: "mystery", directory: "x" }))).toContain(
      "PACK_TYPE_INVALID",
    );
    expect(
      codes(
        validatePackManifest(
          compliancePack({ rules: [{ id: "r1", effect: "allow" }] }),
          COMPLIANCE_CONTEXT,
        ),
      ),
    ).toContain("PACK_SCHEMA_INVALID");
    expect(
      codes(validatePackManifest(compliancePack({ sources: [] }), COMPLIANCE_CONTEXT)),
    ).toContain("PACK_SCHEMA_INVALID");
    expect(
      codes(validatePackManifest(compliancePack({ surprise: true }), COMPLIANCE_CONTEXT)),
    ).toContain("PACK_SCHEMA_INVALID");
  });

  it("enforces the pack-key convention and directory match", () => {
    expect(
      codes(
        validatePackManifest(
          compliancePack({ packKey: "growth_motion.eu_dual_use_screen" }),
          COMPLIANCE_CONTEXT,
        ),
      ),
    ).toContain("PACK_KEY_INVALID");
    expect(
      codes(
        validatePackManifest(compliancePack(), { packType: "compliance", directory: "other" }),
      ),
    ).toContain("PACK_KEY_DIRECTORY_MISMATCH");
  });

  it("requires a notice for non-proprietary content", () => {
    expect(
      codes(
        validatePackManifest(
          compliancePack({ license: "Apache-2.0" }),
          COMPLIANCE_CONTEXT,
        ),
      ),
    ).toContain("PACK_NOTICE_MISSING");
    expect(
      validatePackManifest(
        compliancePack({
          license: "Apache-2.0",
          notice: "Derived summary of anthropics/knowledge-work-plugins (Apache-2.0), rewritten.",
        }),
        COMPLIANCE_CONTEXT,
      ),
    ).toEqual([]);
  });

  it("rejects duplicate rule ids", () => {
    const pack = compliancePack();
    const rules = pack["rules"] as unknown[];
    pack["rules"] = [rules[0], rules[0]];
    expect(codes(validatePackManifest(pack, COMPLIANCE_CONTEXT))).toContain(
      "PACK_RULE_ID_DUPLICATE",
    );
  });

  it("validates the other three pack types against their own rules", () => {
    const dataSource = {
      packKey: "data_source.public_web_only",
      packType: "data_source",
      version: "1.0.0",
      title: "公开源",
      description: "数据源边界",
      priorityClass: "channel_data_content_expert",
      owner: "OWN",
      license: "Proprietary",
      rules: [
        {
          id: "d1",
          sourceId: "searxng.search",
          category: "search",
          allowedUse: ["discovery"],
          license: "self-hosted",
          piiClass: "public_organization",
          approval: "none",
        },
      ],
      sources: [{ label: "internal" }],
      exitPlan: "review",
    };
    expect(validatePackManifest(dataSource, { packType: "data_source", directory: "public_web_only" })).toEqual([]);
    expect(
      codes(
        validatePackManifest(
          { ...dataSource, rules: [{ id: "d1", sourceId: "x" }] },
          { packType: "data_source", directory: "public_web_only" },
        ),
      ),
    ).toContain("PACK_SCHEMA_INVALID");

    const growthMotion = {
      packKey: "growth_motion.dach_distributor",
      packType: "growth_motion",
      version: "1.0.0",
      title: "动作包",
      description: "获客动作",
      priorityClass: "growth_motion",
      tags: { markets: ["DE"] },
      owner: "OWN",
      license: "Proprietary",
      rules: [
        {
          id: "g1",
          motion: "distributor_discovery",
          stage: "qualify",
          playbook: [{ step: "check", guidance: "read impressum" }],
          kpis: ["fit pass rate"],
          guardrails: ["no send"],
        },
      ],
      sources: [{ label: "internal" }],
      exitPlan: "review",
    };
    expect(
      validatePackManifest(growthMotion, { packType: "growth_motion", directory: "dach_distributor" }),
    ).toEqual([]);

    const industry = {
      packKey: "industry.metal_fabrication",
      packType: "industry",
      version: "1.0.0",
      title: "行业",
      description: "行业词表",
      priorityClass: "industry",
      owner: "OWN",
      license: "Proprietary",
      rules: [
        {
          id: "i1",
          taxonomy: { scheme: "ISIC", codes: ["C25"] },
          buyerRoles: ["MD"],
          terminology: ["Lohnfertigung"],
          regulations: [],
        },
      ],
      sources: [{ label: "internal" }],
      exitPlan: "review",
    };
    expect(
      validatePackManifest(industry, { packType: "industry", directory: "metal_fabrication" }),
    ).toEqual([]);
  });

  it("warns about content-only packs without tags", () => {
    const contentOnly = {
      packKey: "growth_motion.pricing",
      packType: "growth_motion",
      version: "1.0.0",
      title: "定价",
      description: "内容包",
      priorityClass: "growth_motion",
      owner: "OWN",
      license: "MIT",
      notice: "Derived summary of coreyhaines31/marketingskills pricing (MIT), rewritten.",
      rules: [],
      sources: [{ label: "internal" }],
      exitPlan: "review",
    };
    const issues = validatePackManifest(contentOnly, { packType: "growth_motion", directory: "pricing" });
    expect(codes(issues)).toEqual(["PACK_CONTENT_ONLY_WITHOUT_TAGS"]);
    expect(issues[0].severity).toBe("warning");
  });
});
