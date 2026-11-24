/**
 * L0 生态互补狙击 + 竞品替换狙击 + 客户种子 CSV 解析（Batch 1.2-B）。
 *
 * 三条高意图获客通道：
 *  1. 竞品替换狙击（competitor_brands[]）：定位正在经销/安装头部竞品（如 LONGi/Jinko/Trina）的
 *     海外分销商/EPC，直接切入「二供 / 高效 HJT 溢价替换」场景；
 *  2. 互补生态发现（ecosystem_brands[]）：按互补上游伙伴（如逆变器/支架/储能 SMA/Fronius/Sungrow/K2）
 *     反向抓取已通过认证的下游安装商与工程总包商；
 *  3. 客户种子 CSV 导入（parseCustomerSeedCsv）：零依赖 RFC-4180 安全解析 + CWE-1236 公式中和，
 *     为 Exa `findSimilar` Lookalike 扩展与已有客户去重提供确定性种子列表。
 */
import { normalizeDomain } from './identity';
import { lookupCountryIso } from './vocab';

export interface EcosystemSniperInput {
  competitorBrands?: readonly string[];
  ecosystemBrands?: readonly string[];
  buyerRoleTerms?: readonly string[];
  countryHint?: string;
  maxQueries?: number;
}

const DEFAULT_COMPETITOR_ROLE_TERMS = ['distributor', 'wholesaler', 'EPC'];
const DEFAULT_ECOSYSTEM_ROLE_TERMS = ['certified installer', 'partner', 'EPC'];

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.trim().replace(/\s+/gu, ' ');
    if (trimmed.length < 2 || trimmed.length > 80) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** 构造竞品替换 + 互补生态狙击查询串（有界去重，避免查询爆炸）。 */
export function buildEcosystemSniperQueries(input: EcosystemSniperInput): string[] {
  const maxQueries = Math.max(1, Math.min(12, input.maxQueries ?? 6));
  const competitors = uniqueNonEmpty(input.competitorBrands);
  const ecosystems = uniqueNonEmpty(input.ecosystemBrands);
  const roleTerms = uniqueNonEmpty(input.buyerRoleTerms);
  const countrySuffix = input.countryHint?.trim() ? ` ${input.countryHint.trim()}` : '';

  const compRole = roleTerms.length > 0
    ? roleTerms.slice(0, 2).join(' OR ')
    : DEFAULT_COMPETITOR_ROLE_TERMS.slice(0, 2).join(' OR ');
  const ecoRole = roleTerms.length > 0
    ? roleTerms[0]!
    : DEFAULT_ECOSYSTEM_ROLE_TERMS[0]!;

  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (query: string): void => {
    const normalized = query.trim();
    if (!normalized || seen.has(normalized.toLowerCase()) || queries.length >= maxQueries) return;
    seen.add(normalized.toLowerCase());
    queries.push(normalized);
  };

  for (const brand of competitors) {
    push(`"${brand}" (${compRole})${countrySuffix}`);
  }
  for (const brand of ecosystems) {
    push(`"${brand}" ${ecoRole}${countrySuffix}`);
  }
  return queries;
}

export interface CustomerSeedRow {
  readonly domain: string;
  readonly companyName?: string;
  readonly country?: string;
}

const FORMULA_LEAD_RE = /^[\t\r ]*[=+\-@]+/u;
const SEED_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** 剥离 CSV 单元格可能携带的电子表格公式注入前缀（CWE-1236）。 */
function sanitizeCsvCell(raw: string): string {
  return raw.trim().replace(FORMULA_LEAD_RE, '').trim();
}

/** 轻量 RFC-4180 CSV 行切分器（支持双引号字段与转义双引号，支持逗号/分号分隔）。 */
function parseCsvRows(csvText: string): string[][] {
  const cleaned = csvText.replace(/^\uFEFF/u, '');
  const firstLine = cleaned.split(/\r?\n/u, 1)[0] ?? '';
  const delimiter =
    firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < cleaned.length; index += 1) {
    const ch = cleaned[index]!;
    if (inQuotes) {
      if (ch === '"' && cleaned[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && cleaned[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
  return rows;
}

const DOMAIN_HEADERS = new Set(['domain', 'website', 'url', 'homepage', 'site', '官网', '域名', '网址']);
const NAME_HEADERS = new Set(['company', 'company_name', 'companyname', 'name', '公司', '公司名', '企业名称']);
const COUNTRY_HEADERS = new Set(['country', 'country_code', 'market', 'iso', '国家', '市场']);

function detectHeaderIndexes(headerRow: readonly string[]): {
  hasHeader: boolean;
  domainIdx: number;
  nameIdx: number;
  countryIdx: number;
} {
  const normalized = headerRow.map((cell) => cell.trim().toLowerCase().replace(/[\s-]+/gu, '_'));
  const domainIdx = normalized.findIndex((cell) => DOMAIN_HEADERS.has(cell));
  const nameIdx = normalized.findIndex((cell) => NAME_HEADERS.has(cell));
  const countryIdx = normalized.findIndex((cell) => COUNTRY_HEADERS.has(cell));
  if (domainIdx >= 0 || nameIdx >= 0 || countryIdx >= 0) {
    return {
      hasHeader: true,
      domainIdx: domainIdx >= 0 ? domainIdx : 0,
      nameIdx,
      countryIdx,
    };
  }
  return { hasHeader: false, domainIdx: 0, nameIdx: 1, countryIdx: 2 };
}

function resolveSeedCountry(raw: string): string | undefined {
  const cleaned = sanitizeCsvCell(raw);
  if (!cleaned) return undefined;
  if (/^[A-Za-z]{2}$/u.test(cleaned)) return cleaned.toUpperCase();
  return lookupCountryIso(cleaned) ?? undefined;
}

/**
 * 解析卖方上传的已有客户/目标种子 CSV（每行至少包含有效域名），按域名去重并限制上限。
 */
export function parseCustomerSeedCsv(csvText: string, maxRows = 500): CustomerSeedRow[] {
  if (typeof csvText !== 'string' || !csvText.trim()) return [];
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return [];

  const header = detectHeaderIndexes(rows[0]!);
  const dataRows = header.hasHeader ? rows.slice(1) : rows;
  const out: CustomerSeedRow[] = [];
  const seen = new Set<string>();

  for (const row of dataRows) {
    if (out.length >= maxRows) break;
    const rawDomain = sanitizeCsvCell(row[header.domainIdx] ?? '');
    const domain = normalizeDomain(rawDomain);
    if (!domain || !SEED_DOMAIN_RE.test(domain) || seen.has(domain)) continue;
    seen.add(domain);
    const rawName = header.nameIdx >= 0 ? sanitizeCsvCell(row[header.nameIdx] ?? '') : '';
    const country = header.countryIdx >= 0 ? resolveSeedCountry(row[header.countryIdx] ?? '') : undefined;
    out.push({
      domain,
      ...(rawName ? { companyName: rawName.slice(0, 200) } : {}),
      ...(country ? { country } : {}),
    });
  }
  return out;
}
