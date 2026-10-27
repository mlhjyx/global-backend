/**
 * BI-15（交付闭环设计 §7）：建议联系路径 = 确定性规则。
 *
 * 优先级固定：供应商入驻页 > 询盘表单 > 联系页 > Impressum 页。
 * 公司 LinkedIn / X 页不是联系路径（BI-14：只作为公司事实展示），不进建议。
 * `legal_note` 是固定合规文案（条文待法务确认）：官网公开入口、未验证投递。
 */

export const SUGGESTED_CONTACT_LEGAL_NOTE =
  '官网公开入口，未验证投递；首次联系请用询盘表单或电话说明来意，邮件广告需事先同意';

/** 建议顺序即设计 §7 的优先级；kind 与 company_contact_point 的数据库 CHECK 一致。 */
export const SUGGESTED_CONTACT_PATH_KINDS = Object.freeze([
  'supplier_page',
  'contact_form',
  'contact_page',
  'impressum_page',
] as const);

export interface ContactPointLike {
  readonly kind: string;
  readonly value: string;
  readonly status?: string;
}

export interface SuggestedContactPath {
  readonly kind: string;
  readonly url: string;
  readonly legal_note: string;
}

function priority(kind: string): number {
  return SUGGESTED_CONTACT_PATH_KINDS.indexOf(kind as (typeof SUGGESTED_CONTACT_PATH_KINDS)[number]);
}

/**
 * The company's own suggested contact path: the highest-priority admissible point,
 * ties broken by URL so the answer never depends on row order. INVALID and
 * non-https points are never suggested. Null when no path qualifies.
 */
export function suggestedContactPath(
  points: readonly ContactPointLike[],
): SuggestedContactPath | null {
  const admissible = points
    .filter(
      (point) =>
        priority(point.kind) >= 0 &&
        point.status !== 'INVALID' &&
        typeof point.value === 'string' &&
        point.value.startsWith('https://'),
    )
    .sort((left, right) => priority(left.kind) - priority(right.kind) || left.value.localeCompare(right.value));
  const best = admissible[0];
  if (!best) return null;
  return Object.freeze({
    kind: best.kind,
    url: best.value,
    legal_note: SUGGESTED_CONTACT_LEGAL_NOTE,
  });
}
