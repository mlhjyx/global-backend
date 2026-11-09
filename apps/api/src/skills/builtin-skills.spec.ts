import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../ai-tasks/task-registry";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import { loadBuiltinSkills, loadPlatformSkills } from "./load-builtin-skills";
import { computeTaskContractDigest } from "./skill-manifest";

/**
 * 平台技能目录（builtin + imported）以 SKILL.md 为唯一真源；本 spec 保证：
 * ① on-disk 文件通过规范校验并与 task 契约一致；② 提交的生成物与 on-disk 完全一致
 * （改了 SKILL.md 忘记 `pnpm skills:generate` → 这里 RED）；③ 技能键唯一；
 * ④ 导入技能带合规溯源（catalog 快照登记 + NOTICE + 默认关闭）。
 */
const BUILTIN_ROOT = join(import.meta.dirname, "builtin");
const IMPORTED_ROOT = join(import.meta.dirname, "imported");
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const THIRD_PARTY_CATALOG = join(REPO_ROOT, "docs/governance/third-party-skills/THIRD_PARTY_SKILLS.json");

const EXPECTED_SKILL_KEYS = [
  "campaign.plan",
  "company.understanding.extract",
  "company.understanding.extract_offerings",
  "compliance.sanctions_screen",
  "discovery.qualify_fit",
  "discovery.quick_judge",
  "engage.reply_classify",
  "outreach.sequence_draft",
  "quoting.incoterms_quote",
  "research.account_research",
  "triage.lead_triage",
] as const;

describe("platform SKILL.md artifacts", () => {
  const loaded = loadPlatformSkills({
    builtinRoot: BUILTIN_ROOT,
    importedRoot: IMPORTED_ROOT,
    resolveContract: getTask,
  });

  it("validates against the manifests without errors", () => {
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("ships exactly the expected platform skills", () => {
    expect(loaded.records.map((record) => record.skillKey).sort()).toEqual([...EXPECTED_SKILL_KEYS]);
  });

  it("keeps the committed generated catalog in sync with the on-disk artifacts", () => {
    expect(BUILTIN_SKILLS).toEqual(loaded.records);
  });

  it("binds every model task skill to a live contract with a matching digest", () => {
    for (const record of loaded.records) {
      if (record.manifest.platform.skillKind !== "model_task") continue;
      const contract = getTask(record.manifest.platform.taskContractId);
      expect(contract, record.skillKey).toBeDefined();
      expect(record.manifest.platform.taskContractDigest, record.skillKey).toBe(
        computeTaskContractDigest(contract!),
      );
      expect(record.manifest.allowedTools, record.skillKey).toEqual(
        [...new Set(contract?.allowedTools ?? [])].sort(),
      );
    }
  });

  it("keeps builtin skills following their pack-type directory", () => {
    for (const record of loadBuiltinSkills(BUILTIN_ROOT, getTask).records) {
      expect(record.manifest.platform.packType, record.skillKey).toBe(record.packTypeDirectory);
    }
  });

  it("keeps imported skills compliant: provenance, license, disabled by default", () => {
    const catalog = JSON.parse(readFileSync(THIRD_PARTY_CATALOG, "utf8")) as {
      sources: { id: string }[];
      skills: { id: string; name: string; sourceId: string }[];
    };
    const imported = loaded.records.filter((record) => record.sourceId !== undefined);
    expect(imported.map((record) => record.skillKey).sort()).toEqual([
      "research.account_research",
      "triage.lead_triage",
    ]);
    for (const record of imported) {
      expect(record.manifest.license, record.skillKey).toBe("Apache-2.0");
      expect(record.manifest.platform.tenantDefault, record.skillKey).toBe("disabled");
      expect(record.body, record.skillKey).toContain("## NOTICE");
      const source = catalog.sources.find((entry) => entry.id === record.sourceId);
      expect(source, `${record.skillKey}: source ${record.sourceId}`).toBeDefined();
      const skill = catalog.skills.find(
        (entry) => entry.sourceId === record.sourceId && entry.name === record.directory,
      );
      expect(skill, `${record.skillKey}: ${record.sourceId}/${record.directory}`).toBeDefined();
      const evalFile = join(IMPORTED_ROOT, record.sourceId!, record.directory, "evals/evals.json");
      expect(existsSync(evalFile), record.skillKey).toBe(true);
    }
  });
});
