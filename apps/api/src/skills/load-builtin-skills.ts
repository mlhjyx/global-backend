import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AiTaskContract } from "../ai-tasks/task-contract";
import {
  validateSkillArtifact,
  type SkillManifest,
  type SkillManifestIssueSeverity,
} from "./skill-manifest";

/**
 * 读取 `skills/builtin/<pack_type>/<skill-name>/SKILL.md` 并逐一校验。生成脚本、
 * 校验脚本与 CI 单测共用同一个加载器，保证三处的判定完全一致。
 */

export interface BuiltinSkillRecord {
  readonly skillKey: string;
  readonly directory: string;
  readonly packTypeDirectory: string;
  readonly manifest: SkillManifest;
  readonly body: string;
  readonly sourceDigest: string;
}

export interface BuiltinSkillIssue {
  readonly file: string;
  readonly code: string;
  readonly severity: SkillManifestIssueSeverity;
  readonly message: string;
}

export interface BuiltinSkillLoadResult {
  readonly records: readonly BuiltinSkillRecord[];
  readonly issues: readonly BuiltinSkillIssue[];
}

export function loadBuiltinSkills(
  rootDirectory: string,
  resolveContract: (taskId: string) => AiTaskContract | undefined,
): BuiltinSkillLoadResult {
  const records: BuiltinSkillRecord[] = [];
  const issues: BuiltinSkillIssue[] = [];

  for (const packTypeDirectory of readdirSync(rootDirectory).sort()) {
    const packPath = join(rootDirectory, packTypeDirectory);
    if (!statSync(packPath).isDirectory()) continue;
    for (const directory of readdirSync(packPath).sort()) {
      const directoryPath = join(packPath, directory);
      if (!statSync(directoryPath).isDirectory()) continue;
      const file = join(directoryPath, "SKILL.md");
      if (!existsSync(file)) {
        issues.push({
          file: directoryPath,
          code: "SKILL_FILE_MISSING",
          severity: "error",
          message: "skill directory must contain SKILL.md",
        });
        continue;
      }
      const raw = readFileSync(file, "utf8");
      const result = validateSkillArtifact({
        raw,
        directoryName: directory,
        packTypeDirectory,
        resolveContract,
      });
      for (const issue of result.issues) {
        issues.push({ file, ...issue });
      }
      if (result.skill) {
        records.push({
          skillKey: result.skill.manifest.platform.skillKey,
          directory,
          packTypeDirectory,
          manifest: result.skill.manifest,
          body: result.skill.body,
          sourceDigest: result.skill.sourceDigest,
        });
      }
    }
  }

  records.sort((left, right) => (left.skillKey < right.skillKey ? -1 : 1));
  const seen = new Map<string, string[]>();
  for (const record of records) {
    seen.set(record.skillKey, [...(seen.get(record.skillKey) ?? []), record.directory]);
  }
  for (const [skillKey, directories] of seen) {
    if (directories.length > 1) {
      issues.push({
        file: rootDirectory,
        code: "SKILL_KEY_DUPLICATE",
        severity: "error",
        message: `skill key ${skillKey} is declared by ${directories.join(", ")}`,
      });
    }
  }

  return { records, issues };
}
