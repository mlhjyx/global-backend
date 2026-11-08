import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../generated/builtin-skill-catalog";
import type { PlatformSkillRecord } from "../load-builtin-skills";
import { validateEvalManifest, type EvalManifest } from "../evals/eval-manifest";
import {
  runStep13DeterministicEvals,
  STEP13_GUARD_SKILLS,
  type Step13GuardSkill,
} from "./step13-skill-evals";

/**
 * M2 步 13-1 Golden Set 的零模型断言层（CI 阻断）：
 * ① 两个 S2 技能各带 8–12 条用例，其中 ≥8 条模型层（发布层回执跑）、≥1 条确定性层；
 * ② 确定性层逐条真实执行技能守卫并精确断言（不调模型、无密钥）；
 * ③ 设计 §7 的负向 1/2/4/5（GROUNDING_REQUIRED / 页脚缺失 / AUTO_REPLY≠POSITIVE /
 *    低置信升级）各自有具名用例，且断言被篡改时整组会红。
 */

const BUILTIN_ROOT = join(import.meta.dirname, "..", "builtin");

function step13EvalFileFor(record: PlatformSkillRecord): string {
  return join(BUILTIN_ROOT, record.packTypeDirectory, record.directory, "evals/evals.json");
}

function recordOf(skillKey: Step13GuardSkill): PlatformSkillRecord {
  const record = BUILTIN_SKILLS.find((candidate) => candidate.skillKey === skillKey);
  if (!record) throw new Error(`missing skill ${skillKey}`);
  return record;
}

function readManifest(record: PlatformSkillRecord): EvalManifest {
  return JSON.parse(readFileSync(step13EvalFileFor(record), "utf8")) as EvalManifest;
}

function tierOf(evalCase: { tier?: unknown }): string {
  return typeof evalCase.tier === "string" ? evalCase.tier : "model";
}

describe("step-13 golden set shape", () => {
  it("ships both S2 skills with 8-12 cases each and a model-tier majority", () => {
    for (const skillKey of STEP13_GUARD_SKILLS) {
      const record = recordOf(skillKey);
      const manifest = readManifest(record);
      expect(manifest.skillName, skillKey).toBe(skillKey);
      expect(validateEvalManifest(manifest), skillKey).toEqual([]);
      expect(manifest.evals.length, skillKey).toBeGreaterThanOrEqual(8);
      expect(manifest.evals.length, skillKey).toBeLessThanOrEqual(12);
      const modelCases = manifest.evals.filter(
        (evalCase) => tierOf(evalCase as { tier?: unknown }) === "model",
      );
      const deterministicCases = manifest.evals.filter(
        (evalCase) => tierOf(evalCase as { tier?: unknown }) === "deterministic",
      );
      expect(modelCases.length, skillKey).toBeGreaterThanOrEqual(8);
      expect(deterministicCases.length, skillKey).toBeGreaterThanOrEqual(1);
    }
  });

  it("names the negative cases the step-13 design requires and keeps them in the CI layer (§7 1/2/4/5)", () => {
    const required: Record<Step13GuardSkill, string[]> = {
      "outreach.sequence_draft": ["grounding-required", "footer-missing"], // §7-1 不接地拒稿 / §7-2 缺页脚
      "engage.reply_classify": ["ooo-classified-positive", "low-confidence-escalation"], // §7-4 / §7-5
    };
    for (const [skillKey, ids] of Object.entries(required) as [Step13GuardSkill, string[]][]) {
      const evals = readManifest(recordOf(skillKey)).evals;
      for (const id of ids) {
        const evalCase = evals.find((candidate) => String(candidate.id) === id);
        expect(evalCase, `${skillKey}:${id}`).toBeDefined();
        // 只认 id 不够：负向用例必须留在确定性层（改 tier 会让它两层都不跑）。
        expect(evalCase?.tier, `${skillKey}:${id}`).toBe("deterministic");
      }
    }
  });
});

describe("step-13 deterministic layer (zero model)", () => {
  it("passes every deterministic case against the real guards", async () => {
    for (const skillKey of STEP13_GUARD_SKILLS) {
      const record = recordOf(skillKey);
      const result = await runStep13DeterministicEvals(skillKey, readManifest(record));
      expect(result.executed, skillKey).toBeGreaterThanOrEqual(1);
      const failed = result.cases.filter((entry) => !entry.ok);
      expect(failed, `${skillKey}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.passed, skillKey).toBe(true);
    }
  });

  it("fails the group when a deterministic assertion no longer matches the guards", async () => {
    const record = recordOf("outreach.sequence_draft");
    const manifest = readManifest(record);
    const tampered: EvalManifest = {
      skillName: manifest.skillName,
      evals: manifest.evals.map((evalCase) =>
        evalCase.id === "grounding-required"
          ? { ...evalCase, assertions: [{ kind: "equals", path: "status", value: "DRAFT" }] }
          : evalCase,
      ),
    };
    const result = await runStep13DeterministicEvals("outreach.sequence_draft", tampered);
    expect(result.passed).toBe(false);
    const failedIds = result.cases.filter((entry) => !entry.ok).map((entry) => entry.id);
    expect(failedIds).toEqual(["grounding-required"]);
  });

  it("refuses skills without a step-13 deterministic executor", async () => {
    await expect(
      runStep13DeterministicEvals("discovery.qualify_fit", {
        skillName: "discovery.qualify_fit",
        evals: [],
      }),
    ).rejects.toThrow("has no step-13 deterministic executor");
  });
});
