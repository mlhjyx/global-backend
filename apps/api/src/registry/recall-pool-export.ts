/**
 * 召回审计的 run 产出池导出（ch03 §3.17.5，执行面批次 3b）。
 *
 * 审计的第二段输入：一次 run 实际产出的公司池，键回注册身份（scheme + regNumber），
 * 供 `recall-audit.mjs` 的 `--pool` 使用（匹配口径 = 注册号键，见 recall-audit.ts 的 v0 声明）。
 *
 * 语义边界：
 *  - 池只取「该 run 的物化结果」：discovery_company_materialization_outcome 里
 *    canonical_company_id 非空的记录，去重到公司；联系人数取 canonical_contact 计数
 *    （contactFound = 计数 > 0，与 recall-audit 的 hasContact 口径一致）。
 *  - 注册身份只从 registry_frame 类提供者的 externalId（`scheme:number`）解析；
 *    其他提供者的 externalId 不是注册号，宁缺毋滥（未命中的池行不参与召回匹配）。
 *  - 导出只做选择、去重与规范化排序，不做抽样与匹配；sha256 与 runId 一起构成可复算指纹。
 */
import { createHash } from 'node:crypto';

export const RECALL_POOL_EXPORT_SCHEMA = 'recall-pool-export/v1';

/** 其 externalId 是 `scheme:number` 注册身份的本地提供者（闭集；新提供者先在此登记）。 */
export const REGISTRY_POOL_PROVIDER_KEYS: readonly string[] = ['registry_frame'];

/** 物化查询的原始行；`loadRunPoolSourceRows` 产出，`buildRecallPoolExport` 消费。 */
export interface RecallPoolSourceRow {
  companyId: string;
  name: string;
  domain: string | null;
  registryScheme: string | null;
  registryNumber: string | null;
  contacts: number;
}

/** 与 recall-audit.ts 的 `RecallPoolRecord` 对齐（可直接喂 `--pool`）。 */
export interface RecallPoolExportRow {
  name: string;
  registryScheme: string | null;
  registryNumber: string | null;
  domain: string | null;
  contactFound: boolean;
  contacts: number;
}

export interface RecallPoolExportManifest {
  runId: string | null;
  workspaceId: string | null;
  /** 导出池的规范哈希（排序后逐行 JSON 的 sha256），与 runId 一起可复算。 */
  sha256: string;
  rowCount: number;
  exportedAt: string;
}

export interface RecallPoolExport {
  schemaVersion: typeof RECALL_POOL_EXPORT_SCHEMA;
  manifest: RecallPoolExportManifest;
  pool: RecallPoolExportRow[];
}

export class RecallPoolExportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecallPoolExportError';
    this.code = code;
  }
}

const EXTERNAL_ID = /^([a-z][a-z0-9_]{0,39}):([A-Za-z0-9][A-Za-z0-9.-]{0,63})$/u;

/** `registry_frame` 提供者的 externalId（`fr_siren:529990001`）→ 注册身份；否则 null。 */
export function parseRegistryExternalId(
  externalId: string | null | undefined,
): { scheme: string; number: string } | null {
  if (!externalId) return null;
  const match = EXTERNAL_ID.exec(externalId);
  if (!match) return null;
  return { scheme: match[1]!, number: match[2]! };
}

function poolKey(row: RecallPoolExportRow, companyId: string | null): string {
  return row.registryScheme && row.registryNumber
    ? `reg\u0001${row.registryScheme}\u0001${row.registryNumber}`
    : `company\u0001${companyId ?? row.name}`;
}

function canonicalRow(row: RecallPoolExportRow): string {
  return JSON.stringify([
    row.registryScheme ?? '',
    row.registryNumber ?? '',
    row.domain ?? '',
    row.contacts,
    row.name,
  ]);
}

export function buildRecallPoolExport(input: {
  rows: readonly RecallPoolSourceRow[];
  runId?: string | null;
  workspaceId?: string | null;
  exportedAt: string;
}): RecallPoolExport {
  if (!Number.isFinite(Date.parse(input.exportedAt))) {
    throw new RecallPoolExportError('EXPORTED_AT_INVALID', `exportedAt 非 ISO 时间：${input.exportedAt}`);
  }
  const merged = new Map<string, { row: RecallPoolExportRow; companyId: string }>();
  for (const source of input.rows) {
    if (!source.companyId) {
      throw new RecallPoolExportError('POOL_ROW_INVALID', '池行缺少 companyId');
    }
    if (!Number.isInteger(source.contacts) || source.contacts < 0) {
      throw new RecallPoolExportError('POOL_ROW_INVALID', `contacts 非非负整数：${source.contacts}`);
    }
    const row: RecallPoolExportRow = {
      name: source.name,
      registryScheme: source.registryScheme,
      registryNumber: source.registryNumber,
      domain: source.domain && source.domain.trim() ? source.domain.trim().toLowerCase() : null,
      contactFound: source.contacts > 0,
      contacts: source.contacts,
    };
    // 同一注册身份的多行（理论上不该有）合并：任一有域名即算有域名，联系人数取最大。
    const key = poolKey(row, source.companyId);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { row, companyId: source.companyId });
      continue;
    }
    existing.row = {
      ...existing.row,
      domain: existing.row.domain ?? row.domain,
      contacts: Math.max(existing.row.contacts, row.contacts),
      contactFound: existing.row.contactFound || row.contactFound,
    };
  }
  const pool = [...merged.values()]
    .map((entry) => entry.row)
    .sort((a, b) => canonicalRow(a).localeCompare(canonicalRow(b)));
  const sha256 = createHash('sha256')
    .update(pool.map((row) => canonicalRow(row)).join('\n'))
    .digest('hex');
  return {
    schemaVersion: RECALL_POOL_EXPORT_SCHEMA,
    manifest: {
      runId: input.runId ?? null,
      workspaceId: input.workspaceId ?? null,
      sha256,
      rowCount: pool.length,
      exportedAt: input.exportedAt,
    },
    pool,
  };
}
