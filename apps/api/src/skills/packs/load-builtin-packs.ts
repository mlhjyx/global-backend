import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest } from "../../model-runtime/context-engine";
import { validateEvalManifest, type EvalManifest } from "../evals/eval-manifest";
import {
  PACK_TYPES,
  packManifestDigest,
  validatePackManifest,
  type PackManifest,
  type PackType,
  type PackValidationIssue,
} from "./pack-manifest";

/**
 * 读取 `skills/packs/content/<pack_type>/<pack-key-suffix>/pack.json + PACK.md` 并校验。
 * 生成脚本、校验脚本与 CI 单测共用；运行时只读生成目录，不做文件系统扫描（与 S0 技能一致）。
 */

export const PACK_CONTENT_MAX_CHARS = 2_000;

export interface BuiltinPackRecord {
  readonly packKey: string;
  readonly packType: PackType;
  readonly directory: string;
  readonly manifest: PackManifest;
  readonly content: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
  readonly sourceDigest: string;
  /** `evals/evals.json`（发布门的确定性评测清单）。 */
  readonly evals?: EvalManifest;
  readonly evalsDigest?: string;
}

export interface BuiltinPackIssue extends PackValidationIssue {
  readonly file: string;
}

export interface BuiltinPackLoadResult {
  readonly records: readonly BuiltinPackRecord[];
  readonly issues: readonly BuiltinPackIssue[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function loadBuiltinPacks(rootDirectory: string): BuiltinPackLoadResult {
  const records: BuiltinPackRecord[] = [];
  const issues: BuiltinPackIssue[] = [];

  for (const packType of PACK_TYPES) {
    const typeDirectory = join(rootDirectory, packType);
    if (!existsSync(typeDirectory) || !statSync(typeDirectory).isDirectory()) {
      issues.push({
        file: typeDirectory,
        code: "PACK_TYPE_DIRECTORY_MISSING",
        severity: "error",
        message: `pack type directory is required: ${packType}`,
      });
      continue;
    }
    for (const directory of readdirSync(typeDirectory).sort()) {
      const directoryPath = join(typeDirectory, directory);
      if (!statSync(directoryPath).isDirectory()) continue;
      const manifestFile = join(directoryPath, "pack.json");
      const contentFile = join(directoryPath, "PACK.md");
      if (!existsSync(manifestFile) || !existsSync(contentFile)) {
        issues.push({
          file: directoryPath,
          code: "PACK_FILES_MISSING",
          severity: "error",
          message: "pack directory must contain pack.json and PACK.md",
        });
        continue;
      }
      const manifestRaw = readFileSync(manifestFile, "utf8");
      const contentRaw = readFileSync(contentFile, "utf8");
      let candidate: unknown;
      try {
        candidate = JSON.parse(manifestRaw);
      } catch {
        issues.push({
          file: manifestFile,
          code: "PACK_JSON_INVALID",
          severity: "error",
          message: "pack.json is not valid JSON",
        });
        continue;
      }
      const validationIssues = validatePackManifest(candidate, { packType, directory });
      for (const issue of validationIssues) issues.push({ file: manifestFile, ...issue });
      if (validationIssues.some((issue) => issue.severity === "error")) continue;

      const content = contentRaw.trim();
      if (content.length === 0) {
        issues.push({
          file: contentFile,
          code: "PACK_CONTENT_EMPTY",
          severity: "error",
          message: "PACK.md must not be empty",
        });
        continue;
      }
      if (content.length > PACK_CONTENT_MAX_CHARS) {
        issues.push({
          file: contentFile,
          code: "PACK_CONTENT_TOO_LONG",
          severity: "error",
          message: `PACK.md exceeds ${PACK_CONTENT_MAX_CHARS} characters (strategy brief budget)`,
        });
        continue;
      }

      const evalsFile = join(directoryPath, "evals", "evals.json");
      let evals: EvalManifest | undefined;
      if (existsSync(evalsFile)) {
        let evalsCandidate: unknown;
        try {
          evalsCandidate = JSON.parse(readFileSync(evalsFile, "utf8"));
        } catch {
          issues.push({
            file: evalsFile,
            code: "PACK_EVALS_INVALID",
            severity: "error",
            message: "evals/evals.json is not valid JSON",
          });
          continue;
        }
        const evalIssues = validateEvalManifest(evalsCandidate);
        for (const issue of evalIssues) issues.push({ file: evalsFile, ...issue });
        if (evalIssues.some((issue) => issue.severity === "error")) continue;
        evals = evalsCandidate as EvalManifest;
      } else {
        issues.push({
          file: directoryPath,
          code: "PACK_EVALS_MISSING",
          severity: "warning",
          message: "pack has no evals/evals.json (publish gate will refuse it)",
        });
      }

      const manifest = candidate as PackManifest;
      records.push({
        packKey: manifest.packKey,
        packType,
        directory,
        manifest,
        content,
        manifestDigest: packManifestDigest(manifest),
        contentDigest: sha256(content),
        sourceDigest: sha256(`${manifestRaw}\u0000${contentRaw}`),
        ...(evals ? { evals, evalsDigest: canonicalDigest(evals) } : {}),
      });
    }
  }

  records.sort((left, right) => (left.packKey < right.packKey ? -1 : 1));
  const seen = new Map<string, string[]>();
  for (const record of records) {
    seen.set(record.packKey, [...(seen.get(record.packKey) ?? []), record.directory]);
  }
  for (const [packKey, directories] of seen) {
    if (directories.length > 1) {
      issues.push({
        file: rootDirectory,
        code: "PACK_KEY_DUPLICATE",
        severity: "error",
        message: `pack key ${packKey} is declared by ${directories.join(", ")}`,
      });
    }
  }

  return { records, issues };
}
