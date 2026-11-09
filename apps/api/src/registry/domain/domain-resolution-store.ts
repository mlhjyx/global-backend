/**
 * 域名解析证据存储契约（ch03 §3.9.4 表 `company_domain_resolution`，执行面批次 3a）。
 *
 * 不变量（与迁移里的 CHECK/约束一一对应，存储层再守一遍）：
 *  - 业务唯一键 (workspace, company, candidateDomain, route)：重复写入是幂等更新；
 *  - 只有 status='VERIFIED' 的行可以被选中（selected=true）；
 *  - 同一公司至多一行被选中：selectVerified 在事务内「先清旧选中、再选新行」，
 *    Prisma 实现用 company 级 advisory lock 串行化（迁移里没有可表达于 datamodel 的
 *    部分唯一索引）；
 *  - selected/verifiedAt 只经 selectVerified 落库，upsert 永不直接置选中位。
 */

export const DOMAIN_RESOLUTION_STATUSES = [
  'PENDING',
  'VERIFIED',
  'AMBIGUOUS',
  'REJECTED',
  'NOT_FOUND',
] as const;

export type DomainResolutionStatus = (typeof DOMAIN_RESOLUTION_STATUSES)[number];

export const DOMAIN_RESOLUTION_ROUTES = [
  'source_field',
  'search',
  'wikidata_p856',
  'ct_log',
  'cc_index',
  'sitemap_hint',
  'manual',
  'none',
] as const;

export type DomainResolutionRoute = (typeof DOMAIN_RESOLUTION_ROUTES)[number];

export interface DomainResolutionRow {
  id: string;
  workspaceId: string;
  companyId: string;
  candidateDomain: string;
  route: DomainResolutionRoute;
  routeRank: number;
  status: DomainResolutionStatus;
  matchType: string | null;
  confidence: number | null;
  evidenceUrl: string | null;
  evidenceHash: string | null;
  evidenceJson: Record<string, unknown> | null;
  extractorVersion: string | null;
  selected: boolean;
  verifiedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainResolutionUpsert {
  candidateDomain: string;
  route: DomainResolutionRoute;
  routeRank: number;
  status: DomainResolutionStatus;
  matchType?: string | null;
  confidence?: number | null;
  evidenceUrl?: string | null;
  evidenceHash?: string | null;
  evidenceJson?: Record<string, unknown> | null;
  extractorVersion?: string | null;
  verifiedAt?: string | null;
  expiresAt?: string | null;
}

export interface DomainResolutionStore {
  /** 按业务唯一键幂等写入/更新（从不置 selected）。 */
  upsert(
    workspaceId: string,
    companyId: string,
    input: DomainResolutionUpsert,
    nowIso: string,
  ): Promise<{ id: string; inserted: boolean }>;
  /** 选中一行 VERIFIED（同事务清掉该公司的旧选中）。 */
  selectVerified(workspaceId: string, companyId: string, resolutionId: string, nowIso: string): Promise<void>;
  /**
   * 清掉该公司的选中行（证据过期/撤销、或选中行要被改判为终态之前必须先清）。
   * 迁移 CHECK 不允许 selected=true 的非 VERIFIED 行，因此改判前不清会直接 23514。
   * 返回被清掉的行数。
   */
  clearSelected(workspaceId: string, companyId: string, nowIso: string): Promise<number>;
  listForCompany(workspaceId: string, companyId: string): Promise<DomainResolutionRow[]>;
}

export class DomainResolutionStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainResolutionStoreError';
    this.code = code;
  }
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** upsert 入参校验（fail closed；RLS/约束之外的语义闸门）。 */
export function validateResolutionUpsert(input: DomainResolutionUpsert): void {
  if (!DOMAIN.test(input.candidateDomain)) {
    throw new DomainResolutionStoreError(
      'RESOLUTION_DOMAIN_INVALID',
      `候选域名不合法：${input.candidateDomain}`,
    );
  }
  if (!DOMAIN_RESOLUTION_STATUSES.includes(input.status)) {
    throw new DomainResolutionStoreError('RESOLUTION_STATUS_INVALID', `状态非法：${input.status}`);
  }
  if (!Number.isInteger(input.routeRank) || input.routeRank < 0) {
    throw new DomainResolutionStoreError('RESOLUTION_RANK_INVALID', `routeRank 非法：${input.routeRank}`);
  }
  if (
    input.confidence !== undefined &&
    input.confidence !== null &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100)
  ) {
    throw new DomainResolutionStoreError('RESOLUTION_CONFIDENCE_INVALID', `置信分越界：${input.confidence}`);
  }
  if (input.status === 'VERIFIED' && input.verifiedAt == null) {
    throw new DomainResolutionStoreError(
      'RESOLUTION_VERIFIED_AT_REQUIRED',
      'VERIFIED 行必须带 verifiedAt',
    );
  }
}
