import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AiTaskContract } from "../ai-tasks/task-contract";
import { validateImportedSkill } from "./imports/import-rules";
import {
  validateSkillArtifact,
  type SkillManifest,
  type SkillManifestIssueSeverity,
} from "./skill-manifest";

/**
 * 读取并校验技能包：
 * - `builtin/<pack_type>/<skill-name>/SKILL.md`（内置，pack-type 目录即真值）；
 * - `imported/<source-id>/<skill-name>/SKILL.md`（第三方衍生版，pack-type 取自
 *   frontmatter，来源溯源在目录上；额外过许可/NOTICE/安全扫描门）。
 * 生成脚本、校验脚本与 CI 单测共用同一加载器，保证三处判定完全一致。
 */

export interface BuiltinSkillRecord {
  readonly skillKey: string;
  readonly directory: string;
  readonly packTypeDirectory: string;
  readonly manifest: SkillManifest;
  readonly body: string;
  readonly sourceDigest: string;
}

/** 平台目录的统一记录：导入技能额外带 `sourceId`（内置技能没有该字段）。 */
export interface PlatformSkillRecord extends BuiltinSkillRecord {
  readonly sourceId?: string;
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

export interface PlatformSkillLoadResult {
  readonly records: readonly PlatformSkillRecord[];
  readonly issues: readonly BuiltinSkillIssue[];
}

function duplicateKeyIssues(
  records: readonly PlatformSkillRecord[],
  file: string,
): readonly BuiltinSkillIssue[] {
  const issues: BuiltinSkillIssue[] = [];
  const seen = new Map<string, string[]>();
  for (const record of records) {
    seen.set(record.skillKey, [...(seen.get(record.skillKey) ?? []), record.directory]);
  }
  for (const [skillKey, directories] of seen) {
    if (directories.length > 1) {
      issues.push({
        file,
        code: "SKILL_KEY_DUPLICATE",
        severity: "error",
        message: `skill key ${skillKey} is declared by ${directories.join(", ")}`,
      });
    }
  }
  return issues;
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
  issues.push(...duplicateKeyIssues(records, rootDirectory));

  return { records, issues };
}

export function loadImportedSkills(
  rootDirectory: string,
  resolveContract: (taskId: string) => AiTaskContract | undefined,
): { records: readonly PlatformSkillRecord[]; issues: readonly BuiltinSkillIssue[] } {
  const records: PlatformSkillRecord[] = [];
  const issues: BuiltinSkillIssue[] = [];

  for (const sourceId of readdirSync(rootDirectory).sort()) {
    const sourcePath = join(rootDirectory, sourceId);
    if (!statSync(sourcePath).isDirectory()) continue;
    for (const directory of readdirSync(sourcePath).sort()) {
      const directoryPath = join(sourcePath, directory);
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
      const result = validateSkillArtifact({ raw, directoryName: directory, resolveContract });
      for (const issue of result.issues) {
        issues.push({ file, ...issue });
      }
      if (!result.skill) continue;
      for (const issue of validateImportedSkill({
        sourceId,
        directory,
        manifest: result.skill.manifest,
        body: result.skill.body,
      })) {
        issues.push({ file, ...issue });
      }
      records.push({
        skillKey: result.skill.manifest.platform.skillKey,
        directory,
        packTypeDirectory: result.skill.manifest.platform.packType,
        manifest: result.skill.manifest,
        body: result.skill.body,
        sourceDigest: result.skill.sourceDigest,
        sourceId,
      });
    }
  }

  records.sort((left, right) => (left.skillKey < right.skillKey ? -1 : 1));
  issues.push(...duplicateKeyIssues(records, rootDirectory));

  return { records, issues };
}

/** 平台目录 = 内置 + 导入；跨两个根去重（同 key 不得出现两次）。 */
export function loadPlatformSkills(options: {
  readonly builtinRoot: string;
  readonly importedRoot?: string;
  readonly resolveContract: (taskId: string) => AiTaskContract | undefined;
}): PlatformSkillLoadResult {
  const builtin = loadBuiltinSkills(options.builtinRoot, options.resolveContract);
  const imported = options.importedRoot
    ? loadImportedSkills(options.importedRoot, options.resolveContract)
    : { records: [], issues: [] };
  const records: PlatformSkillRecord[] = [...builtin.records, ...imported.records];
  records.sort((left, right) => (left.skillKey < right.skillKey ? -1 : 1));
  const issues: BuiltinSkillIssue[] = [...builtin.issues, ...imported.issues];
  const builtinKeys = new Set(builtin.records.map((record) => record.skillKey));
  for (const record of imported.records) {
    if (builtinKeys.has(record.skillKey)) {
      issues.push({
        file: options.importedRoot ?? "imported",
        code: "SKILL_KEY_DUPLICATE",
        severity: "error",
        message: `skill key ${record.skillKey} is declared by both builtin and imported roots`,
      });
    }
  }
  return { records, issues };
}
