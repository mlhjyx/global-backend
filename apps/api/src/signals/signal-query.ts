import { createHash } from 'node:crypto';

/**
 * ingest-once 的拉取键（收口⑤）：
 *  - queryFingerprint：规范化查询参数（码/国别排序去重大写、默认值填充）→ sha256——**跨 workspace 同参 ICP
 *    共享同一次外部拉取**的判定键；provider 参与指纹，绝不跨源撞键。
 *  - windowKey：对齐的 UTC 时间桶起点 ISO（默认 6h，env SIGNAL_INGEST_WINDOW_MS）——「同一时间窗只拉取一次」
 *    的可测定义（写回 docs/architecture §5）。
 */

export const DEFAULT_INGEST_WINDOW_MS = 6 * 3600_000;

export const TED_DEFAULT_SINCE_DAYS = 30; // 开放招标 = 有效需求窗口（与旧 projectTenders 默认一致）
export const TED_DEFAULT_MAX_RECORDS = 100; // 有界样本（绝不 grind 全量）
export const FDA_DEFAULT_SINCE_DAYS = 365; // 清关比招标稀疏 → 更宽窗口
export const FDA_DEFAULT_MAX_RECORDS = 200;

export interface CanonicalTedSpec {
  provider: 'ted';
  kind: 'contract';
  cpvCodes: string[];
  buyerCountries: string[]; // ISO-3（TED buyer-country 查询格式）
  sinceDays: number;
  maxRecords: number;
}

export interface CanonicalFdaSpec {
  provider: 'openfda';
  kind: '510k';
  productCodes: string[];
  applicantCountries: string[]; // alpha-2；空=不限国别（全美市场语义）
  sinceDays: number;
  maxRecords: number;
}

export type CanonicalQuerySpec = CanonicalTedSpec | CanonicalFdaSpec;

/** 排序去重大写（指纹的序/重复/大小写无关性由此保证）。 */
function normList(v: string[] | undefined): string[] {
  return [...new Set((v ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
}

export function canonicalTedSpec(input: {
  cpvCodes: string[];
  buyerCountries: string[];
  sinceDays?: number;
  maxRecords?: number;
}): CanonicalTedSpec {
  return {
    provider: 'ted',
    kind: 'contract',
    cpvCodes: normList(input.cpvCodes),
    buyerCountries: normList(input.buyerCountries),
    sinceDays: input.sinceDays ?? TED_DEFAULT_SINCE_DAYS,
    maxRecords: input.maxRecords ?? TED_DEFAULT_MAX_RECORDS,
  };
}

export function canonicalFdaSpec(input: {
  productCodes: string[];
  applicantCountries?: string[];
  sinceDays?: number;
  maxRecords?: number;
}): CanonicalFdaSpec {
  return {
    provider: 'openfda',
    kind: '510k',
    productCodes: normList(input.productCodes),
    applicantCountries: normList(input.applicantCountries),
    sinceDays: input.sinceDays ?? FDA_DEFAULT_SINCE_DAYS,
    maxRecords: input.maxRecords ?? FDA_DEFAULT_MAX_RECORDS,
  };
}

/** sha256 hex——各字段以 '|' 拼接（数组先规范化），provider/kind 在首位保证跨源不撞键。 */
export function queryFingerprint(spec: CanonicalQuerySpec): string {
  const parts =
    spec.provider === 'ted'
      ? [spec.provider, spec.kind, spec.cpvCodes.join(','), spec.buyerCountries.join(','), String(spec.sinceDays), String(spec.maxRecords)]
      : [spec.provider, spec.kind, spec.productCodes.join(','), spec.applicantCountries.join(','), String(spec.sinceDays), String(spec.maxRecords)];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** 时间窗宽度：env SIGNAL_INGEST_WINDOW_MS（非法/非正回退默认 6h——0/负值会令所有时刻同桶或除零）。 */
export function ingestWindowMs(): number {
  const raw = process.env.SIGNAL_INGEST_WINDOW_MS;
  if (!raw) return DEFAULT_INGEST_WINDOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INGEST_WINDOW_MS;
}

/** 时间桶键 = 对齐桶起点的 ISO（UTC）。同窗同键 → signal_ingest 唯一约束挡重复拉取。 */
export function windowKeyFor(nowMs: number, windowMs: number = ingestWindowMs()): string {
  return new Date(Math.floor(nowMs / windowMs) * windowMs).toISOString();
}
