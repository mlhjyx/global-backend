/**
 * M1 导入通道（import）：CSV 解析、列映射与行校验（纯函数，零 DB）。
 *
 * - RFC4180（引号/转义/换行），`,` 与 `;` 自动识别，BOM 容忍；
 * - 行数上限 5000、单元格 ≤2000 字符；列映射至少要有「公司名」列；
 * - 域名统一从 website/domain 列取 host（https 化）。
 */

export const IMPORT_MAX_ROWS = 5000;
const MAX_CELL = 2000;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export class ImportCsvError extends Error {
  readonly code = 'IMPORT_CSV_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ImportCsvError';
  }
}

function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/gu) ?? []).length;
  const commas = (headerLine.match(/,/gu) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^\uFEFF/u, '');
  if (clean.trim().length === 0) throw new ImportCsvError('CSV is empty');
  const firstLine = clean.split(/\r?\n/u)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const headerRow = (rows.shift() ?? []).map((value) => value.trim());
  if (headerRow.length === 0 || headerRow.every((value) => value.length === 0)) {
    throw new ImportCsvError('CSV needs a header row');
  }
  if (headerRow.some((value) => value.length === 0)) throw new ImportCsvError('CSV header has an empty column');
  // 表头会被当作对象键：拒绝原型链相关的保留名（防原型污染/意外覆盖）。
  const reserved = new Set(['__proto__', 'prototype', 'constructor']);
  if (headerRow.some((value) => reserved.has(value.toLowerCase()))) {
    throw new ImportCsvError('CSV header contains a reserved column name');
  }
  if (new Set(headerRow).size !== headerRow.length) throw new ImportCsvError('CSV header has duplicate columns');
  if (rows.length > IMPORT_MAX_ROWS) throw new ImportCsvError(`CSV has more than ${IMPORT_MAX_ROWS} rows`);

  const trimmed = rows.filter((values) => values.some((value) => value.trim().length > 0));
  for (const values of trimmed) {
    if (values.length > 64) throw new ImportCsvError('CSV row has too many columns');
    for (const value of values) {
      if (value.length > MAX_CELL) throw new ImportCsvError(`CSV cell exceeds ${MAX_CELL} chars`);
    }
  }
  return { headers: headerRow, rows: trimmed };
}

export interface ImportMapping {
  /** 公司名列（必填，按表头名指定）。 */
  name: string;
  domain?: string;
  website?: string;
  country?: string;
  industry?: string;
}

export function validateImportMapping(headers: readonly string[], raw: unknown): ImportMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ImportCsvError('mapping must be an object');
  const record = raw as Record<string, unknown>;
  const byName = new Map(headers.map((header) => [header.toLowerCase(), header]));
  const pick = (value: unknown, field: string, required: boolean): string | undefined => {
    if (value === undefined || value === null || value === '') {
      if (required) throw new ImportCsvError(`mapping.${field} is required`);
      return undefined;
    }
    if (typeof value !== 'string') throw new ImportCsvError(`mapping.${field} must be a header name`);
    const header = byName.get(value.toLowerCase());
    if (!header) throw new ImportCsvError(`mapping.${field} names an unknown column: ${value}`);
    return header;
  };
  return {
    name: pick(record.name, 'name', true)!,
    ...(pick(record.domain, 'domain', false) ? { domain: pick(record.domain, 'domain', false)! } : {}),
    ...(pick(record.website, 'website', false) ? { website: pick(record.website, 'website', false)! } : {}),
    ...(pick(record.country, 'country', false) ? { country: pick(record.country, 'country', false)! } : {}),
    ...(pick(record.industry, 'industry', false) ? { industry: pick(record.industry, 'industry', false)! } : {}),
  };
}

export interface ImportRow {
  rowNumber: number;
  name: string;
  domain?: string;
  country?: string;
  industry?: string;
  raw: Record<string, string>;
}

export interface ImportRowsResult {
  rows: ImportRow[];
  invalid: Array<{ rowNumber: number; reason: string }>;
}

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z]+:\/\//iu.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase();
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

export function buildImportRows(
  headers: readonly string[],
  rows: readonly string[][],
  mapping: ImportMapping,
): ImportRowsResult {
  const columnIndex = new Map(headers.map((header, index) => [header, index]));
  const cell = (values: readonly string[], header: string | undefined): string | undefined => {
    if (!header) return undefined;
    const index = columnIndex.get(header);
    return index === undefined ? undefined : values[index]?.trim() || undefined;
  };
  const result: ImportRowsResult = { rows: [], invalid: [] };
  rows.forEach((values, offset) => {
    const rowNumber = offset + 1;
    const name = cell(values, mapping.name);
    if (!name || name.length < 2 || name.length > 300) {
      result.invalid.push({ rowNumber, reason: 'COMPANY_NAME_INVALID' });
      return;
    }
    const raw = Object.fromEntries(
      headers
        .map((header, index) => [header, values[index]?.trim()] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    );
    result.rows.push({
      rowNumber,
      name,
      ...(hostOf(cell(values, mapping.domain) ?? cell(values, mapping.website))
        ? { domain: hostOf(cell(values, mapping.domain) ?? cell(values, mapping.website)) }
        : {}),
      ...(cell(values, mapping.country) ? { country: cell(values, mapping.country)! } : {}),
      ...(cell(values, mapping.industry) ? { industry: cell(values, mapping.industry)! } : {}),
      raw,
    });
  });
  return result;
}

/** Q27-2：系统生成的 10 行示例 CSV（列映射与导入验收用，不依赖用户提供样例）。 */
export const IMPORT_SAMPLE_CSV = [
  'company,website,country,industry',
  'Acme Pumpen GmbH,https://acme-pumpen.example,DE,industrial pumps',
  'Beta Armaturen AG,https://beta-armaturen.example,AT,valves',
  'Gamma Fluid Systems,https://gamma-fluid.example,CH,fluid systems',
  'Delta Industrievertretung,https://delta-vertretung.example,DE,distribution',
  'Epsilon Pumpenhandel,https://epsilon-pumpen.example,DE,wholesale',
  'Zeta Verfahrenstechnik,https://zeta-verfahren.example,AT,process technology',
  'Eta Dichtungen GmbH,https://eta-dichtungen.example,DE,seals',
  'Theta Rohrleitungsbau,https://theta-rohrbau.example,DE,piping',
  'Iota Handelsgesellschaft,https://iota-handel.example,CH,trading',
  'Kappa Industriepumpen,https://kappa-pumpen.example,DE,industrial pumps',
].join('\n');
