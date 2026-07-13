/**
 * BigQuery Google Patents 发明人身份源 L0 客户端（待办 3 · 替代被封的 EPO OPS）。
 *
 * 数据面：`patents-public-data.patents.publications`（Google Patents Public Data，IFI CLAIMS 谐调）。
 *   assignee_harmonized（申请人 = 公司，含 alpha-2 country_code）+ inventor_harmonized（发明人 = 具名技术买家）
 *   + publication_date（INT64 YYYYMMDD）。
 *
 * 🔴 合规红线（与 EPO OPS 一致，见 epo-ops.ts）：
 *  - 发明人 = 具名个人（GDPR）→ **数据最小化：只取 name**，adapter 层丢弃 inventor 的 country_code/其它字段。
 *  - 署名义务：`GOOGLE_PATENTS_LICENSE` 写入 field_evidence.license（provider 层）。
 *    ⚠️ ENABLE 前须按数据集元数据核实确切 license/attribution 文案（见设计 §合规）。
 *  - 成本护栏：`maximumBytesBilled` 硬顶——BigQuery 若预估扫描超顶即拒（fail-closed），护 1TB/月免费额度。
 *  - fail-safe：无 SA key / 无 project / 查询失败 / 超额 → 返空、不抛穿（单源不阻断其余，同 EPO/CH）。
 *
 * 鉴权：服务账号 JSON key（`GOOGLE_PATENTS_SA_JSON` 指向 gitignored key 文件；回退 `GOOGLE_APPLICATION_CREDENTIALS`）
 *   + 计费/配额 project（`GOOGLE_PATENTS_PROJECT`）。二者缺任一 → 天然 no-op（返空）。
 *
 * 纯逻辑（{@link assigneeLikeAnchor} / {@link normalizeRow}）与 I/O（{@link BigQueryPatentsClient}）分离，便于测试。
 */
import { BigQuery } from '@google-cloud/bigquery';

export const GOOGLE_PATENTS_LICENSE = 'CC-BY-4.0';
export const GOOGLE_PATENTS_ATTRIBUTION =
  'Google Patents Public Data by IFI CLAIMS Patent Services, licensed under CC BY 4.0.';

// publications 表无 assignee 分区/聚簇 → 每查按列全表扫描（只 SELECT 2 列压字节）。maximumBytesBilled 硬顶护额度。
const DEFAULT_MAX_GB = 200;
const BYTES_PER_GB = 1024 ** 3;
const MAX_ROWS_DEFAULT = 500;
const MAX_ROWS_CEIL = 2000;

// publication_date 为 INT64 YYYYMMDD（如 20200115）。
const yearToStart = (y: number): number => y * 10000 + 101; // Jan 01
const yearToEnd = (y: number): number => y * 10000 + 1231; // Dec 31

/**
 * assignee 归一预筛用停用词（法人后缀 + 无区分度虚词）——绝不作为锚（否则全表命中或锚到法人形式）。
 * 🔴 含**全拼**法人形式（Corporation/Limited/Aktiengesellschaft…）：否则「取最长 token」会选中它们
 *    （"Microsoft Corporation"→CORPORATION、"Siemens Aktiengesellschaft"→AKTIENGESELLSCHAFT），
 *    发出 `%CORPORATION%` 这种无区分度谓词，配合 LIMIT 可能一个发明人都返不回。
 */
const LEGAL_STOP = new Set([
  'GMBH', 'AG', 'INC', 'LLC', 'LTD', 'PLC', 'CORP', 'CO', 'SA', 'BV', 'OY', 'AB', 'AS', 'KG',
  'THE', 'AND', 'GROUP', 'HOLDING', 'HOLDINGS', 'COMPANY', 'INTERNATIONAL', 'SE', 'SRL', 'SPA',
  // 全拼法人形式（多语言）——注：tokenizer 已剥标点、并滤 <3 字符 token，故只列 ≥3 字母的全拼形式。
  'CORPORATION', 'INCORPORATED', 'LIMITED', 'AKTIENGESELLSCHAFT', 'GESELLSCHAFT', 'KABUSHIKI',
  'KAISHA', 'AKTIEBOLAG', 'SOCIETE', 'SOCIETA', 'LLP',
]);

export interface PatentApplicant {
  name: string;
  /** alpha-2 国别（供 provider 国别门）；非 alpha-2 或缺失 = undefined。 */
  country?: string;
}
export interface PatentInventor {
  /** 🔴 只 name（数据最小化，drop residence/country/其它）。 */
  name: string;
}
export interface PatentRecord {
  applicants: PatentApplicant[];
  inventors: PatentInventor[];
}

export interface PatentSearchOptions {
  fromYear: number;
  toYear: number;
  /** 每公司返回专利行上限（防大公司爆量 + 控字节；clamp 到 [1, {@link MAX_ROWS_CEIL}]）。 */
  maxRows?: number;
}

/**
 * 归一 assignee 前缀锚（SQL 宽预筛；provider 再做精确对齐 ≥0.9，故此处偏「宽」不「准」）。
 * 取最长的 ≥3 字母/数字 token（去法人后缀/虚词）；无合格 token → null（不查，返空）。
 * 🔴 只用于**预筛缩小行集**，绝不用于身份判定——判定在 provider 的 pickBestByName。
 */
export function assigneeLikeAnchor(companyName: string): string | null {
  const tokens = (companyName ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !LEGAL_STOP.has(t));
  if (!tokens.length) return null;
  const anchor = [...tokens].sort((a, b) => b.length - a.length)[0];
  // LIKE 通配转义（锚只含 [A-Z0-9]，仍防御式转义 %/_/\）。
  const escaped = anchor.replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}

/** maxRows clamp 成受控整数（内部值，直接内联进 SQL 安全）。 */
function clampMaxRows(n?: number): number {
  const v = Math.floor(Number(n ?? MAX_ROWS_DEFAULT));
  if (!Number.isFinite(v) || v < 1) return MAX_ROWS_DEFAULT;
  return Math.min(v, MAX_ROWS_CEIL);
}

/** 只 SELECT 需要列；WHERE 宽预筛 assignee + 日期范围 + 有发明人。maxRows 受控内联（非用户输入）。 */
function buildQuery(maxRows: number): string {
  return `
    SELECT
      ARRAY(
        SELECT AS STRUCT a.name AS name, a.country_code AS country
        FROM UNNEST(assignee_harmonized) a
        WHERE a.name IS NOT NULL AND a.name != ''
      ) AS applicants,
      ARRAY(
        SELECT AS STRUCT i.name AS name
        FROM UNNEST(inventor_harmonized) i
        WHERE i.name IS NOT NULL AND i.name != ''
      ) AS inventors
    FROM \`patents-public-data.patents.publications\`
    WHERE publication_date >= @fromDate
      AND publication_date <= @toDate
      AND ARRAY_LENGTH(inventor_harmonized) > 0
      AND EXISTS (
        SELECT 1 FROM UNNEST(assignee_harmonized) a
        WHERE UPPER(a.name) LIKE @assigneeLike
      )
    LIMIT ${maxRows}
  `;
}

/** 刷新批量读一行（assignee→inventor，仅 name）。喂 PatentCacheClient 落库。 */
export interface RefreshInventorRow {
  assigneeName: string;
  assigneeCountry?: string; // alpha-2 小写 或 undefined
  inventorName: string; // 🔴 仅 name（护栏⑥）
}

/** 刷新批量查：一条 LIKE ANY 覆盖**全部**排队 anchor（一次扫，绝不按 anchor 分片成 N 查）。护栏②④⑥ 全下推 SQL。 */
function buildRefreshQuery(): string {
  return `
    SELECT a.name AS assignee_name, a.country_code AS assignee_country, i.name AS inventor_name
    FROM \`patents-public-data.patents.publications\`,
         UNNEST(assignee_harmonized) a, UNNEST(inventor_harmonized) i
    WHERE publication_date BETWEEN @fromDate AND @toDate
      AND ARRAY_LENGTH(assignee_harmonized) = 1
      AND a.name IS NOT NULL AND a.name != '' AND i.name IS NOT NULL AND i.name != ''
      AND EXISTS (SELECT 1 FROM UNNEST(@anchors) anc WHERE UPPER(a.name) LIKE anc)
    GROUP BY assignee_name, assignee_country, inventor_name
  `;
}

/** BigQuery job 统计（statistics.totalBytesProcessed 供配额观测）。 */
interface BigQueryJobMeta {
  statistics?: {
    totalBytesProcessed?: string | number;
    query?: { totalBytesProcessed?: string | number };
  };
}

/** BigQuery 查询任务句柄的最小面。 */
export interface BigQueryJobLike {
  getQueryResults(): Promise<[Array<Record<string, unknown>>, ...unknown[]]>;
  /** 任务完成后刷新 metadata（createQueryJob 时 statistics 尚未含最终扫描字节）。 */
  getMetadata?(): Promise<[BigQueryJobMeta, ...unknown[]]>;
  metadata?: BigQueryJobMeta;
}

/** BigQuery client 的最小接口（便于测试注入，不绑死 @google-cloud/bigquery 具体形状）。 */
export interface BigQueryLike {
  query(opts: {
    query: string;
    params?: Record<string, unknown>;
    types?: Record<string, unknown>;
    maximumBytesBilled?: string;
  }): Promise<[Array<Record<string, unknown>>, ...unknown[]]>;
  /** 可选：真 BigQuery 支持——建任务后从 job.metadata 读实际扫描字节（配额告警/成本可观测）。测试 mock 可不实现（回退 query，bytes=null）。 */
  createQueryJob?(opts: {
    query: string;
    params?: Record<string, unknown>;
    types?: Record<string, unknown>;
    maximumBytesBilled?: string;
  }): Promise<[BigQueryJobLike, ...unknown[]]>;
}

/** 刷新扫描结果 + 实际扫描字节（bytesScanned=null 当客户端不暴露 job 统计，如测试 mock）。 */
export interface RefreshScanResult {
  rows: RefreshInventorRow[];
  bytesScanned: number | null;
}

/** BigQuery 行 → RefreshInventorRow（🔴 inventor 只留 name，护栏⑥）。 */
function mapRefreshRow(r: Record<string, unknown>): RefreshInventorRow {
  return {
    assigneeName: String(r.assignee_name ?? '').trim(),
    assigneeCountry: normCountry(r.assignee_country),
    inventorName: String(r.inventor_name ?? '').trim(), // 🔴 仅 name
  };
}

/** job metadata 里尽力取 totalBytesProcessed（query.* 优先，回退顶层）→ number 或 null。 */
function bytesFromMeta(meta?: BigQueryJobMeta): number | null {
  const raw = meta?.statistics?.query?.totalBytesProcessed ?? meta?.statistics?.totalBytesProcessed;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface BigQueryPatentsDeps {
  /** 测试注入用；生产走 env 惰性建真 client。 */
  makeClient?: () => BigQueryLike;
  maxGb?: number;
}

export class BigQueryPatentsClient {
  private client: BigQueryLike | null = null;

  constructor(private readonly deps: BigQueryPatentsDeps = {}) {}

  /** 惰性建 client：SA key 文件 + project 齐才建；缺任一 → null（fail-safe 空，同 EPO 无 creds）。 */
  private getClient(): BigQueryLike | null {
    if (this.client) return this.client;
    if (this.deps.makeClient) {
      this.client = this.deps.makeClient();
      return this.client;
    }
    const keyFile = process.env.GOOGLE_PATENTS_SA_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const projectId = process.env.GOOGLE_PATENTS_PROJECT;
    if (!keyFile || !projectId) return null;
    this.client = new BigQuery({ keyFilename: keyFile, projectId }) as unknown as BigQueryLike;
    return this.client;
  }

  private maxBytes(): string {
    const envGb = Number(process.env.GOOGLE_PATENTS_MAX_GB);
    // 显式判断而非 `|| DEFAULT`：运维设 =0（或负/NaN）都回落默认，但**有效正值**（含很小值）尊重运维意图。
    const maxGb = this.deps.maxGb ?? (Number.isFinite(envGb) && envGb > 0 ? envGb : DEFAULT_MAX_GB);
    return String(Math.floor(maxGb * BYTES_PER_GB));
  }

  /**
   * 按 assignee（公司名）查近 [fromYear, toYear] 专利 → {@link PatentRecord}[]。
   * 无锚/无 creds → 返空（天然 no-op）。查询错误/超额向上抛，由 provider 的 try/catch fail-safe 兜（不在此吞）。
   */
  async searchPatentsByAssignee(assignee: string, opts: PatentSearchOptions): Promise<PatentRecord[]> {
    const name = assignee?.trim();
    if (!name) return [];
    const anchor = assigneeLikeAnchor(name);
    if (!anchor) return [];
    const client = this.getClient();
    if (!client) return []; // 无 creds → 天然 no-op（同 EPO 无 key）
    const [rows] = await client.query({
      query: buildQuery(clampMaxRows(opts.maxRows)),
      params: {
        fromDate: yearToStart(opts.fromYear),
        toDate: yearToEnd(opts.toYear),
        assigneeLike: anchor,
      },
      types: { fromDate: 'INT64', toDate: 'INT64', assigneeLike: 'STRING' },
      maximumBytesBilled: this.maxBytes(),
    });
    return (rows ?? []).map(normalizeRow);
  }

  /**
   * 刷新批量读：给定 anchor 集，**一次扫描**拉回全部命中的 (assignee, country, inventor-name)。
   * 🔴 护栏②(独家申请人)/④(近5年)/⑥(仅 name) 全下推 SQL；maximumBytesBilled fail-closed 兜底。
   * 无 anchor/无 creds → 返空（天然 no-op）。查询错误向上抛，由调用方 fail-safe 兜。
   */
  async searchInventorsForAnchors(anchors: string[], opts: PatentSearchOptions): Promise<RefreshInventorRow[]> {
    return (await this.searchInventorsForAnchorsWithStats(anchors, opts)).rows;
  }

  /**
   * 同 {@link searchInventorsForAnchors}，但**带实际扫描字节**（配额观测/Step 9-A 证据）。
   * 真 BigQuery（暴露 createQueryJob）→ 建任务读 job.metadata.statistics.totalBytesProcessed；
   * 仅暴露 query 的 mock/旧客户端 → 回退 query，bytesScanned=null（行为与旧路径逐字一致，测试不破）。
   */
  async searchInventorsForAnchorsWithStats(anchors: string[], opts: PatentSearchOptions): Promise<RefreshScanResult> {
    const uniq = [...new Set(anchors.filter((a) => a && a.trim()))];
    if (!uniq.length) return { rows: [], bytesScanned: null };
    const client = this.getClient();
    if (!client) return { rows: [], bytesScanned: null };
    const queryOpts = {
      query: buildRefreshQuery(),
      params: { fromDate: yearToStart(opts.fromYear), toDate: yearToEnd(opts.toYear), anchors: uniq },
      types: { fromDate: 'INT64', toDate: 'INT64', anchors: ['STRING'] },
      maximumBytesBilled: this.maxBytes(),
    };
    let rawRows: Array<Record<string, unknown>>;
    let bytesScanned: number | null = null;
    if (client.createQueryJob) {
      const [job] = await client.createQueryJob(queryOpts);
      const [rows] = await job.getQueryResults();
      rawRows = rows ?? [];
      // createQueryJob 时 statistics 未含最终扫描字节 → 完成后刷新 metadata 取准确值（取不到则退回 job.metadata）。
      let meta = job.metadata;
      if (job.getMetadata) {
        try {
          const [refreshed] = await job.getMetadata();
          meta = refreshed;
        } catch {
          /* getMetadata 失败退回 job.metadata（bytesScanned 可能 null，不阻断落库） */
        }
      }
      bytesScanned = bytesFromMeta(meta);
    } else {
      const [rows] = await client.query(queryOpts);
      rawRows = rows ?? [];
    }
    const rows = rawRows.map(mapRefreshRow).filter((r) => r.assigneeName && r.inventorName);
    return { rows, bytesScanned };
  }
}

/** 归一国别码 → alpha-2 小写（非 alpha-2 → undefined，欠并方向）。 */
function normCountry(v: unknown): string | undefined {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : undefined;
}

/** BigQuery 行 → PatentRecord（🔴 inventor **只留 name**，丢 country_code 等 = 数据最小化）。 */
export function normalizeRow(row: Record<string, unknown>): PatentRecord {
  const applicants = Array.isArray(row.applicants)
    ? (row.applicants as Array<Record<string, unknown>>)
        .map((a) => ({ name: String(a?.name ?? '').trim(), country: normCountry(a?.country) }))
        .filter((a) => a.name)
    : [];
  const inventors = Array.isArray(row.inventors)
    ? (row.inventors as Array<Record<string, unknown>>)
        .map((i) => ({ name: String(i?.name ?? '').trim() })) // 🔴 只 name
        .filter((i) => i.name)
    : [];
  return { applicants, inventors };
}

/** 生产单例（env 驱动）。 */
export const bigqueryPatents = new BigQueryPatentsClient();
