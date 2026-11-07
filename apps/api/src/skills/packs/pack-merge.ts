import {
  PACK_PRIORITY_ORDER,
  type ComplianceRule,
  type PackManifest,
  type PriorityClass,
} from "./pack-manifest";

/**
 * 确定性冲突裁决（PRD §7.11.7 的一个可实现子集；设计 §5.2）。
 *
 * - 排序：优先级（高→低）→ 效果强度（forbid > require_approval > mask > limit）→ packKey 字典序 → rule id。
 * - `forbid` 是吸收态：同作用域内更高优先级的 forbid 使低层的较弱效果被拒绝（记录 rejected，不静默丢弃）。
 * - 同优先级：更严格的效果胜出；同等强度并存。
 * - 作用域 = `appliesTo` 的规范序列化；无 appliesTo 目标视为全局作用域（v1 schema 要求至少一个目标）。
 */

const EFFECT_STRENGTH = {
  forbid: 4,
  require_approval: 3,
  mask: 2,
  limit: 1,
} as const;

export interface RankedComplianceRule {
  readonly rule: ComplianceRule;
  readonly packKey: string;
  readonly packVersion: string;
  readonly priorityClass: PriorityClass;
  readonly rank: number;
}

export type RejectedReason = "higher_priority_forbid" | "stricter_effect_wins";

export interface RejectedComplianceRule extends RankedComplianceRule {
  readonly reason: RejectedReason;
  readonly blockedBy: string;
}

export interface ComplianceMergeResult {
  readonly effective: readonly RankedComplianceRule[];
  readonly rejected: readonly RejectedComplianceRule[];
}

export function priorityRank(priorityClass: PriorityClass): number {
  const rank = PACK_PRIORITY_ORDER.indexOf(priorityClass);
  return rank < 0 ? PACK_PRIORITY_ORDER.length : rank;
}

function scopeKey(rule: ComplianceRule): string {
  const appliesTo = rule.appliesTo;
  return JSON.stringify({
    skills: [...(appliesTo.skills ?? [])].sort(),
    tools: [...(appliesTo.tools ?? [])].sort(),
    phases: [...(appliesTo.phases ?? [])].sort(),
  });
}

function rankedRules(packs: readonly PackManifest[]): RankedComplianceRule[] {
  const ranked: RankedComplianceRule[] = [];
  for (const pack of packs) {
    if (pack.packType !== "compliance") continue;
    for (const rule of pack.rules as readonly ComplianceRule[]) {
      ranked.push({
        rule,
        packKey: pack.packKey,
        packVersion: pack.version,
        priorityClass: pack.priorityClass,
        rank: priorityRank(pack.priorityClass),
      });
    }
  }
  ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      EFFECT_STRENGTH[right.rule.effect] - EFFECT_STRENGTH[left.rule.effect] ||
      (left.packKey < right.packKey ? -1 : left.packKey > right.packKey ? 1 : 0) ||
      (left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0),
  );
  return ranked;
}

export function mergeComplianceRules(
  packs: readonly PackManifest[],
): ComplianceMergeResult {
  const accepted: RankedComplianceRule[] = [];
  const rejected: RejectedComplianceRule[] = [];
  const acceptedByScope = new Map<string, RankedComplianceRule[]>();

  for (const candidate of rankedRules(packs)) {
    const scope = scopeKey(candidate.rule);
    const blockers = acceptedByScope.get(scope) ?? [];
    const strength = EFFECT_STRENGTH[candidate.rule.effect];
    const blocker = blockers.find(
      (existing) => EFFECT_STRENGTH[existing.rule.effect] > strength,
    );
    if (blocker) {
      rejected.push({
        ...candidate,
        reason:
          blocker.rank < candidate.rank && blocker.rule.effect === "forbid"
            ? "higher_priority_forbid"
            : "stricter_effect_wins",
        blockedBy: `${blocker.packKey}#${blocker.rule.id}`,
      });
      continue;
    }
    accepted.push(candidate);
    acceptedByScope.set(scope, [...blockers, candidate]);
  }

  return { effective: accepted, rejected };
}
