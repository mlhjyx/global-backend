import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ComplianceMergeResult, RankedComplianceRule, RejectedComplianceRule } from "./pack-merge";
import type { PackManifest } from "./pack-manifest";

/**
 * 策略简报的确定性渲染（设计 §5.4）：固定模板、固定顺序、固定上限（2000 字）。
 * 台账里的 `rulesDigest` 覆盖「生效规则 + 被拒规则 + 内容摘要」，供策略快照寻址。
 */

export const STRATEGY_BRIEF_MAX_CHARS = 2_000;

export interface StrategyContextSelectors {
  readonly industries?: readonly string[];
  readonly markets?: readonly string[];
  readonly motions?: readonly string[];
}

export interface StrategyContentBlock {
  readonly packKey: string;
  readonly packType: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly content: string;
}

export interface StrategyDigestInput {
  readonly effective: readonly RankedComplianceRule[];
  readonly rejected: readonly RejectedComplianceRule[];
  readonly contents: readonly StrategyContentBlock[];
}

export function strategyRulesDigest(input: StrategyDigestInput): string {
  return canonicalDigest({
    effective: input.effective.map((entry) => ({
      packKey: entry.packKey,
      version: entry.packVersion,
      priorityClass: entry.priorityClass,
      ruleId: entry.rule.id,
      effect: entry.rule.effect,
      appliesTo: entry.rule.appliesTo,
      condition: entry.rule.condition ?? null,
    })),
    rejected: input.rejected.map((entry) => ({
      packKey: entry.packKey,
      version: entry.packVersion,
      ruleId: entry.rule.id,
      reason: entry.reason,
      blockedBy: entry.blockedBy,
    })),
    contents: input.contents.map((block) => ({
      packKey: block.packKey,
      version: block.version,
      contentDigest: block.contentDigest,
    })),
  });
}

function selectorLine(selectors: StrategyContextSelectors): string {
  const part = (label: string, values: readonly string[] | undefined): string =>
    `${label}=${values && values.length > 0 ? values.join(",") : "*"}`;
  return [
    part("industries", selectors.industries),
    part("markets", selectors.markets),
    part("motions", selectors.motions),
  ].join("; ");
}

function ruleLine(entry: RankedComplianceRule): string {
  return `- [${entry.rule.effect}] ${entry.packKey}@${entry.packVersion}#${entry.rule.id}: ${entry.rule.rationale}`;
}

export function renderStrategyBrief(input: {
  skillKey: string;
  selectors: StrategyContextSelectors;
  merge: ComplianceMergeResult;
  contents: readonly StrategyContentBlock[];
}): string {
  const header = [
    `# Strategy for ${input.skillKey}`,
    `Selectors: ${selectorLine(input.selectors)}`,
    `Packs: ${input.contents.map((block) => `${block.packKey}@${block.version}`).join(", ") || "(none)"}`,
  ];

  const rules = input.merge.effective.map(ruleLine);
  if (input.merge.rejected.length > 0) {
    rules.push(
      ...input.merge.rejected.map(
        (entry) => `- [rejected:${entry.reason}] ${entry.packKey}#${entry.rule.id} (blocked by ${entry.blockedBy})`,
      ),
    );
  }

  const lines: string[] = [...header];
  if (rules.length > 0) {
    lines.push("## Rules (priority order)", ...rules);
  }
  for (const block of input.contents) {
    lines.push(`## Pack content: ${block.packKey}@${block.version}`, block.content);
  }

  let brief = lines.join("\n");
  if (brief.length > STRATEGY_BRIEF_MAX_CHARS) {
    brief = `${brief.slice(0, STRATEGY_BRIEF_MAX_CHARS - 1)}…`;
  }
  return brief;
}

export function packMatchesSelectors(
  manifest: PackManifest,
  selectors: StrategyContextSelectors,
): boolean {
  const tags = manifest.tags;
  if (!tags) return true; // 无标签 = 通用包（合规/数据源边界等）
  const intersects = (
    packValues: readonly string[] | undefined,
    selected: readonly string[] | undefined,
  ): boolean =>
    packValues !== undefined &&
    selected !== undefined &&
    packValues.some((value) => selected.includes(value));
  const anyTagged =
    (tags.industries?.length ?? 0) + (tags.markets?.length ?? 0) + (tags.motions?.length ?? 0) > 0;
  if (!anyTagged) return true;
  return (
    intersects(tags.industries, selectors.industries) ||
    intersects(tags.markets, selectors.markets) ||
    intersects(tags.motions, selectors.motions)
  );
}
