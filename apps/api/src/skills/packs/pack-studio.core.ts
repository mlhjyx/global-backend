import { canonicalDigest } from "../../model-runtime/context-engine";
import { mergeComplianceRules } from "./pack-merge";
import {
  PACK_TYPES,
  validatePackManifest,
  type PackManifest,
  type PackType,
  type PackValidationIssue,
} from "./pack-manifest";

/**
 * Pack Studio 的纯逻辑（可单测）：草稿校验报告、发布门与简报差异。
 * 数据库读写在各 service 内，本模块不触碰 IO。
 */

export interface DraftValidationReport {
  readonly manifestDigest: string;
  readonly issues: readonly PackValidationIssue[];
  readonly validatedAt: string;
}

export class PackDraftInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "PackDraftInputError";
  }
}

export function packTypeOfKey(packKey: string): { packType: PackType; directory: string } {
  const [prefix, ...rest] = packKey.split(".");
  if (!PACK_TYPES.includes(prefix as PackType) || rest.length === 0) {
    throw new PackDraftInputError(
      "PACK_KEY_INVALID",
      `packKey must be <type>.<name> with type in ${PACK_TYPES.join("|")}`,
    );
  }
  return { packType: prefix as PackType, directory: rest.join(".") };
}

export function validateDraft(packKey: string, manifest: unknown): DraftValidationReport {
  const { packType, directory } = packTypeOfKey(packKey);
  const issues = [...validatePackManifest(manifest, { packType, directory })];
  if (issues.every((issue) => issue.severity !== "error")) {
    // 冲突模拟：单包内部规则先自证（跨包冲突在 dry-run 全量解析时暴露）。
    const merge = mergeComplianceRules([manifest as PackManifest]);
    for (const rejected of merge.rejected) {
      issues.push({
        code: "PACK_RULE_CONFLICT",
        severity: "error",
        message: `rule ${rejected.rule.id} is rejected by ${rejected.blockedBy} (${rejected.reason})`,
      });
    }
  }
  return {
    manifestDigest: canonicalDigest(manifest),
    issues,
    validatedAt: new Date().toISOString(),
  };
}

export interface PublishReceipt {
  readonly subjectDigest: string;
  readonly evalManifestDigest: string;
  readonly tier: "deterministic" | "model";
  readonly passed: boolean;
  readonly createdAt: Date;
}

export interface PublishGateInput {
  readonly manifestDigest: string;
  readonly evalManifestDigest: string | null;
  readonly receipts: readonly PublishReceipt[];
  readonly now?: Date;
  readonly maxAgeDays?: number;
}

export type PublishBlocker =
  | "DRAFT_NOT_VALIDATED"
  | "EVAL_MANIFEST_REQUIRED"
  | "EVAL_RECEIPT_MISSING"
  | "EVAL_RECEIPT_FAILED"
  | "EVAL_RECEIPT_STALE";

export function publishBlockers(input: PublishGateInput): readonly PublishBlocker[] {
  const now = input.now ?? new Date();
  const maxAgeMs = (input.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  if (!input.evalManifestDigest) return ["EVAL_MANIFEST_REQUIRED"];
  const matching = input.receipts.filter(
    (receipt) =>
      receipt.subjectDigest === input.manifestDigest &&
      receipt.evalManifestDigest === input.evalManifestDigest,
  );
  if (matching.length === 0) return ["EVAL_RECEIPT_MISSING"];
  const passing = matching.filter((receipt) => receipt.passed);
  if (passing.length === 0) return ["EVAL_RECEIPT_FAILED"];
  const fresh = passing.filter(
    (receipt) => now.getTime() - receipt.createdAt.getTime() <= maxAgeMs,
  );
  if (fresh.length === 0) return ["EVAL_RECEIPT_STALE"];
  return [];
}

export interface BriefDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export function diffBriefs(before: string, after: string): BriefDiff {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  return {
    added: after.split("\n").filter((line) => !beforeLines.has(line)),
    removed: before.split("\n").filter((line) => !afterLines.has(line)),
  };
}
