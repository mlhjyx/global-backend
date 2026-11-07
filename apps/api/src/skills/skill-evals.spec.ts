import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../ai-tasks/task-registry";
import type { ScreenResult } from "../sanctions/sanctions-screening.service";
import { validateEvalManifest, type EvalManifest } from "./evals/eval-manifest";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import type { PlatformSkillRecord } from "./load-builtin-skills";
import { runServiceSkillEvals, ServiceSkillEvalUnavailableError } from "./service-skill-evals";

/**
 * Golden Set 的 CI 零模型层（S1-4）：
 * ① 每个上架技能都带结构合规、断言词汇闭集的评测清单（≥5 例）；
 * ② service 技能逐用例真实执行 handler 并精确断言（模型技能不在此层执行，
 *    其清单进发布层回执流程）；
 * ③ 未声明的 handler 与模型技能不得混入确定性执行器。
 */
const BUILTIN_ROOT = join(import.meta.dirname, "builtin");
const IMPORTED_ROOT = join(import.meta.dirname, "imported");

const FAKE_SCREEN_RESULT: ScreenResult = {
  status: "clear",
  matches: [],
  listVersions: { "eu-consolidated": "2026-11-01" },
};

function evalFileFor(record: PlatformSkillRecord): string {
  return record.sourceId
    ? join(IMPORTED_ROOT, record.sourceId, record.directory, "evals/evals.json")
    : join(BUILTIN_ROOT, record.packTypeDirectory, record.directory, "evals/evals.json");
}

function readManifest(record: PlatformSkillRecord): EvalManifest {
  return JSON.parse(readFileSync(evalFileFor(record), "utf8")) as EvalManifest;
}

const serviceRecords = BUILTIN_SKILLS.filter(
  (record) => record.manifest.platform.skillKind === "service",
);
const modelRecords = BUILTIN_SKILLS.filter((record) => {
  const kind = record.manifest.platform.skillKind ?? "model_task";
  return kind === "model_task";
});

describe("shipped skill eval manifests", () => {
  it("validates structure and vocabulary for every shipped skill", () => {
    for (const record of BUILTIN_SKILLS) {
      const manifest = readManifest(record);
      expect(validateEvalManifest(manifest), record.skillKey).toEqual([]);
      expect(manifest.skillName, record.skillKey).toBe(record.skillKey);
      expect(manifest.evals.length, record.skillKey).toBeGreaterThanOrEqual(5);
    }
  });

  it("ships the two service skills and five model skills", () => {
    expect(serviceRecords.map((record) => record.skillKey).sort()).toEqual([
      "compliance.sanctions_screen",
      "quoting.incoterms_quote",
    ]);
    expect(modelRecords).toHaveLength(5);
  });
});

describe("deterministic eval execution", () => {
  it("passes every service skill's authored evals against the real handler", async () => {
    for (const record of serviceRecords) {
      const result = await runServiceSkillEvals(
        { manifest: record.manifest, evals: readManifest(record) },
        { sanctionsScreen: () => FAKE_SCREEN_RESULT },
      );
      expect(result.cases, record.skillKey).toHaveLength(5);
      const failed = result.cases.filter((entry) => !entry.ok);
      expect(failed, `${record.skillKey}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.passed, record.skillKey).toBe(true);
    }
  });

  it("fails the run when an assertion no longer matches the handler output", async () => {
    const record = serviceRecords.find(
      (candidate) => candidate.skillKey === "quoting.incoterms_quote",
    )!;
    const tampered: EvalManifest = {
      skillName: record.skillKey,
      evals: readManifest(record).evals.map((evalCase, index) =>
        index === 0
          ? {
              ...evalCase,
              assertions: [{ kind: "equals", path: "totalAmount", value: -1 }],
            }
          : evalCase,
      ),
    };
    const result = await runServiceSkillEvals({ manifest: record.manifest, evals: tampered });
    expect(result.passed).toBe(false);
    expect(result.cases[0].ok).toBe(false);
  });

  it("refuses model-task skills in the deterministic executor", async () => {
    const record = modelRecords[0];
    await expect(
      runServiceSkillEvals({
        manifest: record.manifest,
        evals: readManifest(record),
      }),
    ).rejects.toBeInstanceOf(ServiceSkillEvalUnavailableError);
  });

  it("fails closed when the sanctions index is not wired", async () => {
    const record = serviceRecords.find(
      (candidate) => candidate.skillKey === "compliance.sanctions_screen",
    )!;
    await expect(
      runServiceSkillEvals({ manifest: record.manifest, evals: readManifest(record) }),
    ).rejects.toThrow("SERVICE_SKILL_HANDLER_UNAVAILABLE");
  });
});

describe("service skill tool boundary (L1 red line)", () => {
  it("declares no tools and no model contract for service skills", () => {
    for (const record of serviceRecords) {
      expect(record.manifest.allowedTools, record.skillKey).toEqual([]);
      expect(record.manifest.platform.taskContractId, record.skillKey).toBeUndefined();
    }
  });

  it("binds each service skill to a registered handler whose risk and gate match", () => {
    for (const record of serviceRecords) {
      expect(record.manifest.platform.serviceHandler, record.skillKey).toBeDefined();
      expect(record.manifest.platform.humanGate, record.skillKey).toBe(
        record.skillKey === "quoting.incoterms_quote",
      );
      expect(record.manifest.platform.risk, record.skillKey).toBe(
        record.skillKey === "quoting.incoterms_quote" ? "medium" : "low",
      );
    }
  });
});

describe("model skill contracts", () => {
  it("keeps the five model skills bound to live task contracts", () => {
    for (const record of modelRecords) {
      const contract = getTask(record.manifest.platform.taskContractId!);
      expect(contract, record.skillKey).toBeDefined();
    }
  });
});
