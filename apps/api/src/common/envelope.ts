/**
 * 统一响应信封（收口④定稿，contracts README「约定」+ PRD 11.15 错误模型）：
 * - 单资源/命令结果：`{ data: T }`
 * - 列表：`{ data: T[], page: { next_cursor, has_more } }`
 * - 错误：`{ error: { code, message, details? } }`（GlobalHttpExceptionFilter 归一，不在此处）
 *
 * 协议键（data/page/error 及 page 内键）用 snake_case，与事件 envelope（PRD 11.10）
 * 和 contracts README 的既有约定对齐；资源字段维持 as-built camelCase（DTO 层）。
 * 例外：/health 不套信封——基础设施探针，非业务读路径。
 */

export interface PageInfo {
  next_cursor: string | null;
  has_more: boolean;
}

export interface Enveloped<T> {
  data: T;
}

export interface PageEnveloped<T> {
  data: T[];
  page: PageInfo;
}

export function envelope<T>(data: T): Enveloped<T> {
  return { data };
}

/** 服务层内部分页形状（camelCase）→ 协议 snake_case 的唯一映射点。 */
export function pageEnvelope<T>(
  data: T[],
  page: { nextCursor: string | null; hasMore: boolean },
): PageEnveloped<T> {
  return { data, page: { next_cursor: page.nextCursor, has_more: page.hasMore } };
}
