/**
 * 用户产品选择标记（selectedByUser / selectedAt）的唯一读写口径。
 *
 * 标记存在 Offering.attributes（现有 JSON 列，无迁移）。任何**整体替换** attributes 的
 * 写入者（理解重抽取 persistOfferings）都必须先读出旧标记再合并回去，否则用户勾选/
 * 取消的意图会被静默抹掉，ICP 生成的产品输入随之漂移。
 */

export interface OfferingSelectionMarker {
  selectedByUser: boolean;
  selectedAt?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readSelectionMarker(attributes: unknown): OfferingSelectionMarker | null {
  if (!isPlainRecord(attributes) || typeof attributes.selectedByUser !== 'boolean') return null;
  return {
    selectedByUser: attributes.selectedByUser,
    ...(typeof attributes.selectedAt === 'string' ? { selectedAt: attributes.selectedAt } : {}),
  };
}

/** Merge a marker into an attribute object that is about to be written. */
export function withSelectionMarker(
  attributes: unknown,
  selectedByUser: boolean,
  selectedAt: string,
): Record<string, unknown> {
  return {
    ...(isPlainRecord(attributes) ? attributes : {}),
    selectedByUser,
    selectedAt,
  };
}

/**
 * Extraction rewrites attributes wholesale; merge the previous marker back so a re-run
 * cannot erase user intent. Undefined extraction leaves the existing column untouched.
 */
export function mergeSelectionMarker(
  extracted: unknown,
  marker: OfferingSelectionMarker | null | undefined,
): unknown {
  if (!marker || !isPlainRecord(extracted)) return extracted;
  return { ...extracted, ...marker };
}
