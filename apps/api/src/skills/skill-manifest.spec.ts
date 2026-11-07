import { describe, expect, it } from "vitest";
import type { AiTaskContract } from "../ai-tasks/task-contract";
import {
  computeTaskContractDigest,
  validateSkillArtifact,
  type SkillArtifactInput,
} from "./skill-manifest";

const contract: AiTaskContract = {
  id: "demo.task",
  description: "抽取演示事实。只依据给定文本。",
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["result"],
    properties: { result: { type: "string", maxLength: 100 } },
  },
  model: "demo-model",
  acceptsModelSubstitute: true,
  risk: "medium",
  humanGate: true,
  allowedTools: ["crawl4ai.fetch"],
  maxCostCents: 20,
  maxOutputTokens: 8_192,
  timeoutMs: 180_000,
};

const DIGEST = computeTaskContractDigest(contract);

function artifact(overrides: Partial<SkillArtifactInput> = {}, platform: Record<string, string> = {}): SkillArtifactInput {
  const metadata: Record<string, string> = {
    "platform.skill-key": "demo.skill",
    "platform.version": "1.0.0",
    "platform.pack-type": "growth_motion",
    "platform.task-contract": "demo.task",
    "platform.task-contract-digest": DIGEST,
    "platform.risk": "medium",
    "platform.human-gate": "true",
    "platform.budget-cents": "20",
    ...platform,
  };
  const lines = [
    "name: demo-skill",
    "description: 抽取演示事实。只依据给定文本。",
    "license: Proprietary",
    "allowed-tools: crawl4ai.fetch",
    "metadata:",
    ...Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
  ];
  return {
    raw: `---\n${lines.join("\n")}\n---\n\n# 演示技能\n\n只用于测试。\n`,
    directoryName: "demo-skill",
    packTypeDirectory: "growth_motion",
    resolveContract: () => contract,
    ...overrides,
  };
}

function codes(input: SkillArtifactInput): string[] {
  return validateSkillArtifact(input).issues.map((issue) => issue.code);
}

describe("computeTaskContractDigest", () => {
  it("is stable and covers the behavior-relevant contract fields", () => {
    expect(computeTaskContractDigest(contract)).toBe(DIGEST);
    expect(computeTaskContractDigest({ ...contract })).toBe(DIGEST);
  });

  it("changes when prompt text, tools, schema, budget or gates change", () => {
    const variants: AiTaskContract[] = [
      { ...contract, description: "另一段提示词。" },
      { ...contract, allowedTools: ["searxng.search"] },
      { ...contract, outputSchema: { type: "object" } },
      { ...contract, maxCostCents: 21 },
      { ...contract, maxOutputTokens: 4_096 },
      { ...contract, risk: "low" },
      { ...contract, humanGate: false },
      { ...contract, acceptsModelSubstitute: undefined },
    ];
    for (const variant of variants) {
      expect(computeTaskContractDigest(variant)).not.toBe(DIGEST);
    }
  });

  it("ignores the deployment-level model string", () => {
    expect(computeTaskContractDigest({ ...contract, model: "another-model" })).toBe(DIGEST);
  });
});

describe("validateSkillArtifact", () => {
  it("accepts a standard-compliant artifact bound to its task contract", () => {
    const result = validateSkillArtifact(artifact());
    expect(result.issues).toEqual([]);
    expect(result.skill?.manifest.name).toBe("demo-skill");
    expect(result.skill?.manifest.allowedTools).toEqual(["crawl4ai.fetch"]);
    expect(result.skill?.manifest.platform.skillKey).toBe("demo.skill");
    expect(result.skill?.body).toBe("# 演示技能\n\n只用于测试。");
    expect(result.skill?.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts an artifact without allowed-tools when the contract allows no tools", () => {
    const pure = { ...contract, allowedTools: [] as string[] };
    const input = artifact({ resolveContract: () => pure });
    input.raw = input.raw.replace("allowed-tools: crawl4ai.fetch\n", "");
    input.raw = input.raw.replace(
      `"${DIGEST}"`,
      `"${computeTaskContractDigest(pure)}"`,
    );
    expect(validateSkillArtifact(input).issues).toEqual([]);
  });

  it("enforces the standard name rules and the directory match", () => {
    const input = artifact();
    input.raw = input.raw.replace("name: demo-skill", "name: Demo-Skill");
    expect(codes(input)).toContain("SKILL_NAME_INVALID");

    const mismatched = artifact({ directoryName: "other-directory" });
    expect(codes(mismatched)).toContain("SKILL_NAME_DIRECTORY_MISMATCH");
  });

  it("requires license and bounds description/compatibility", () => {
    const noLicense = artifact();
    noLicense.raw = noLicense.raw.replace("license: Proprietary\n", "");
    expect(codes(noLicense)).toContain("SKILL_LICENSE_MISSING");

    const longDescription = artifact();
    longDescription.raw = longDescription.raw.replace(
      "description: 抽取演示事实。只依据给定文本。",
      `description: ${"长".repeat(1_025)}`,
    );
    expect(codes(longDescription)).toContain("SKILL_DESCRIPTION_INVALID");

    const longCompatibility = artifact();
    longCompatibility.raw = longCompatibility.raw.replace(
      "license: Proprietary",
      `license: Proprietary\ncompatibility: ${"x".repeat(501)}`,
    );
    expect(codes(longCompatibility)).toContain("SKILL_COMPATIBILITY_INVALID");
  });

  it("keeps metadata a string-to-string map", () => {
    const input = artifact();
    input.raw = input.raw.replace(`"1.0.0"`, "1.0.0");
    // 未加引号的 1.0.0 会被解析成字符串（非数字），这里改一个真正的非字符串值：
    input.raw = input.raw.replace(`"20"`, "20");
    expect(codes(input)).toContain("SKILL_METADATA_INVALID");
  });

  it("requires every platform extension field and validates values", () => {
    const missing = artifact({}, {}); // ensure defaults
    missing.raw = missing.raw.replace(`  platform.pack-type: "growth_motion"\n`, "");
    expect(codes(missing)).toContain("SKILL_PLATFORM_FIELD_MISSING");

    const badVersion = artifact({}, { "platform.version": "1.0" });
    expect(codes(badVersion)).toContain("SKILL_PLATFORM_VALUE_INVALID");

    const badPackType = artifact({}, { "platform.pack-type": "mystery" });
    expect(codes(badPackType)).toContain("SKILL_PACK_TYPE_INVALID");

    const badKey = artifact({}, { "platform.skill-key": "Demo Skill" });
    expect(codes(badKey)).toContain("SKILL_PLATFORM_VALUE_INVALID");
  });

  it("fails closed when the bound task contract is unknown", () => {
    expect(codes(artifact({ resolveContract: () => undefined }))).toContain("SKILL_TASK_UNKNOWN");
  });

  it("fails closed on contract digest drift", () => {
    const input = artifact({}, { "platform.task-contract-digest": "0".repeat(64) });
    expect(codes(input)).toContain("SKILL_CONTRACT_DIGEST_MISMATCH");
  });

  it("keeps the tool whitelist identical to the task contract", () => {
    const extraTool = artifact();
    extraTool.raw = extraTool.raw.replace(
      "allowed-tools: crawl4ai.fetch",
      "allowed-tools: crawl4ai.fetch searxng.search",
    );
    expect(codes(extraTool)).toContain("SKILL_ALLOWED_TOOLS_CONTRACT_MISMATCH");

    const missingTool = artifact();
    missingTool.raw = missingTool.raw.replace("allowed-tools: crawl4ai.fetch\n", "");
    expect(codes(missingTool)).toContain("SKILL_ALLOWED_TOOLS_CONTRACT_MISMATCH");
  });

  it("checks optional human-readable fields against the contract", () => {
    expect(codes(artifact({}, { "platform.risk": "low" }))).toContain(
      "SKILL_RISK_CONTRACT_MISMATCH",
    );
    expect(codes(artifact({}, { "platform.human-gate": "false" }))).toContain(
      "SKILL_HUMAN_GATE_CONTRACT_MISMATCH",
    );
    expect(codes(artifact({}, { "platform.budget-cents": "21" }))).toContain(
      "SKILL_BUDGET_CONTRACT_MISMATCH",
    );
  });

  it("requires a non-empty markdown body", () => {
    const input = artifact();
    input.raw = input.raw.slice(0, input.raw.indexOf("---\n\n# 演示技能")) + "---\n\n\n";
    expect(codes(input)).toContain("SKILL_BODY_INVALID");
  });
});
