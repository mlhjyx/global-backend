/**
 * 评估学的规范化身份键（纯函数，无 I/O）。
 *
 * - candidateKey：evaluation_label 的集内唯一身份。候选引用三选一，
 *   优先级 canonical id > domain > name+country（与报告端点的标注匹配优先级一致）。
 * - coverageIdentityKey：coverage_estimate 的存证身份 = 口径 + 计数；同口径下
 *   计数不变则不追行，计数变化才 append 一行。
 */
import { createHash } from "node:crypto";

/**
 * 规范化候选身份键：`canonical:<uuid>` | `domain:<小写域名>` | `name:<归一名称>|<国家>`。
 */
export function candidateKey(entry: {
  canonicalCompanyId?: string | null;
  domain?: string | null;
  name?: string | null;
  country?: string | null;
}): string {
  if (entry.canonicalCompanyId) return `canonical:${entry.canonicalCompanyId.toLowerCase()}`;
  const domain = entry.domain?.trim().toLowerCase();
  if (domain) return `domain:${domain}`;
  const name = entry.name?.trim().replace(/\s+/gu, " ").toLowerCase();
  if (name) {
    const country = (entry.country ?? "").trim().toUpperCase();
    return `name:${name}|${country}`;
  }
  throw new Error("EVALUATION_LABEL_CANDIDATE_MISSING");
}

/** 覆盖估计的规范化身份键：口径 + 计数，计数变化才追新行。 */
export function coverageIdentityKey(input: {
  region: string;
  category: string;
  sourceA: string;
  sourceB: string;
  countA: number;
  countB: number;
  overlap: number;
}): string {
  const canonical = [
    "chapman/v1",
    input.region.trim().toLowerCase(),
    input.category.trim().toLowerCase(),
    input.sourceA,
    input.sourceB,
    String(input.countA),
    String(input.countB),
    String(input.overlap),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
