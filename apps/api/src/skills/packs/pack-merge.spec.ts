import { describe, expect, it } from "vitest";
import { mergeComplianceRules } from "./pack-merge";
import type { ComplianceRule, PackManifest } from "./pack-manifest";

function rule(id: string, effect: ComplianceRule["effect"], phase = "create"): ComplianceRule {
  return {
    id,
    effect,
    appliesTo: { phases: [phase] },
    rationale: `rule ${id}`,
    sources: [{ label: "test" }],
  };
}

function pack(
  packKey: string,
  priorityClass: PackManifest["priorityClass"],
  rules: ComplianceRule[],
): PackManifest {
  return {
    packKey,
    packType: "compliance",
    version: "1.0.0",
    title: packKey,
    description: "test pack",
    priorityClass,
    owner: "OWN",
    license: "Proprietary",
    rules,
    sources: [{ label: "test" }],
    exitPlan: "test",
  };
}

describe("mergeComplianceRules", () => {
  it("lets a higher-priority forbid absorb a lower-priority weaker rule", () => {
    const result = mergeComplianceRules([
      pack("compliance.high", "compliance", [rule("f", "forbid")]),
      pack("compliance.low", "growth_motion", [rule("a", "require_approval")]),
    ]);
    expect(result.effective.map((entry) => entry.rule.id)).toEqual(["f"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      rule: { id: "a" },
      reason: "higher_priority_forbid",
      blockedBy: "compliance.high#f",
    });
  });

  it("keeps same-priority stricter effects and rejects the weaker one deterministically", () => {
    const result = mergeComplianceRules([
      pack("compliance.b_lower_key", "compliance", [rule("approve", "require_approval")]),
      pack("compliance.a_higher_key", "compliance", [rule("forbid", "forbid")]),
    ]);
    expect(result.effective.map((entry) => entry.rule.id)).toEqual(["forbid"]);
    expect(result.rejected[0]).toMatchObject({
      rule: { id: "approve" },
      reason: "stricter_effect_wins",
    });
  });

  it("keeps every rule that targets a different scope", () => {
    const result = mergeComplianceRules([
      pack("compliance.a", "compliance", [rule("forbid-create", "forbid", "create")]),
      pack("compliance.b", "compliance", [rule("approve-research", "require_approval", "research")]),
    ]);
    expect(result.effective).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it("keeps equal-strength rules side by side", () => {
    const result = mergeComplianceRules([
      pack("compliance.a", "compliance", [rule("f1", "forbid")]),
      pack("compliance.b", "compliance", [rule("f2", "forbid")]),
    ]);
    expect(result.effective.map((entry) => entry.rule.id).sort()).toEqual(["f1", "f2"]);
    expect(result.rejected).toEqual([]);
  });

  it("ignores non-compliance packs", () => {
    const dataSource: PackManifest = {
      packKey: "data_source.x",
      packType: "data_source",
      version: "1.0.0",
      title: "x",
      description: "x",
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
      sources: [{ label: "test" }],
      exitPlan: "test",
    };
    expect(mergeComplianceRules([dataSource])).toEqual({ effective: [], rejected: [] });
  });
});
