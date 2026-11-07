import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../ai-tasks/task-registry";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import { loadBuiltinSkills } from "./load-builtin-skills";

/**
 * S0 的三个存量技能必须以 SKILL.md 为唯一真源；本 spec 保证：
 * ① on-disk 文件通过规范校验并与 task 契约一致；② 提交的生成物与 on-disk 完全一致
 * （改了 SKILL.md 忘记 `pnpm skills:generate` → 这里 RED）；③ 技能键唯一。
 */
const BUILTIN_ROOT = join(import.meta.dirname, "builtin");

const EXPECTED_SKILL_KEYS = [
  "company.understanding.extract",
  "company.understanding.extract_offerings",
  "discovery.qualify_fit",
] as const;

describe("builtin SKILL.md artifacts", () => {
  const loaded = loadBuiltinSkills(BUILTIN_ROOT, getTask);

  it("validates against the manifests without errors", () => {
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("ships exactly the three S0 skills", () => {
    expect(loaded.records.map((record) => record.skillKey).sort()).toEqual([...EXPECTED_SKILL_KEYS]);
  });

  it("keeps the committed generated catalog in sync with the on-disk artifacts", () => {
    expect(BUILTIN_SKILLS).toEqual(loaded.records);
  });

  it("binds every skill to a live task contract with a matching digest", () => {
    for (const record of loaded.records) {
      const contract = getTask(record.manifest.platform.taskContractId);
      expect(contract, record.skillKey).toBeDefined();
      expect(record.manifest.platform.taskContractDigest, record.skillKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(record.manifest.allowedTools, record.skillKey).toEqual(
        [...new Set(contract?.allowedTools ?? [])].sort(),
      );
    }
  });

  it("follows the pack-type directory", () => {
    for (const record of loaded.records) {
      expect(record.manifest.platform.packType, record.skillKey).toBe(record.packTypeDirectory);
    }
  });
});
