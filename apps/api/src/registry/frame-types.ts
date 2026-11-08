/**
 * Registry frame v0 类型与配置校验（GainOS v3.0 第 3 章 P2）。
 *
 * 一个 frame = 一个可独立刷新、可独立许可的法人实体总体。配置分两部分：
 *  - `frame`：帧定义（落 registry_frame 的元数据）；
 *  - `mapping`：列映射（把源文件的列/JSON 路径映射到 registry_entity 归一字段）。
 *
 * 平台级纯逻辑：无 IO、无 Prisma 依赖，可被脚本、Temporal activity 与单测共用。
 */

export type FrameFormat = 'csv' | 'json';

export type RegistryEntityStatus = 'ACTIVE' | 'DISSOLVED' | 'INSOLVENT' | 'UNKNOWN';

export const REGISTRY_ENTITY_STATUSES: readonly RegistryEntityStatus[] = [
  'ACTIVE',
  'DISSOLVED',
  'INSOLVENT',
  'UNKNOWN',
];

export const EMPLOYEE_BANDS = ['0', '1-9', '10-49', '50-249', '250+'] as const;
export type EmployeeBand = (typeof EMPLOYEE_BANDS)[number];

export const FRAME_FETCH_MODES = [
  'bulk_file',
  'api_paged',
  'sftp',
  'manual_upload',
  'athena',
] as const;
export type FrameFetchMode = (typeof FRAME_FETCH_MODES)[number];

export interface FrameDefinitionInput {
  frameKey: string;
  country: string;
  scheme: string;
  label: string;
  providerKey: string;
  sourceUrl: string;
  licence: string;
  licenceUrl?: string | null;
  fetchMode: FrameFetchMode;
  cadence?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  expectedCount?: number | null;
}

export interface FrameFieldMapping {
  regNumber: string;
  name: string;
  country?: string | null;
  status?: string | null;
  legalForm?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  addressLines?: string[] | null;
  nace?: string | null;
  naceVersion?: string | null;
  employeeBand?: string | null;
  vatId?: string | null;
  lei?: string | null;
  website?: string | null;
  identifiers?: Array<{ scheme: string; value: string }> | null;
}

export interface FrameMapping {
  schemaVersion: 'registry-frame-mapping/v1';
  format: FrameFormat;
  csv?: { delimiter?: string } | null;
  recordsPath?: string | null;
  /** 源级常量：scheme 必填；country 可在 fields.country 缺省时兜底。 */
  constants: { scheme: string; country?: string | null };
  fields: FrameFieldMapping;
  /** 源状态词 → ACTIVE/DISSOLVED/INSOLVENT/UNKNOWN（键大小写不敏感）。 */
  statusMap?: Record<string, RegistryEntityStatus> | null;
  legalFormMap?: Record<string, string> | null;
  employeeBandMap?: Record<string, EmployeeBand> | null;
}

export interface FrameConfig {
  schemaVersion: 'registry-frame/v1';
  frame: FrameDefinitionInput;
  mapping: FrameMapping;
}

export class FrameConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'FrameConfigError';
    this.issues = issues;
  }
}

const ISO2 = /^[A-Z]{2}$/u;
const FRAME_KEY = /^[a-z0-9_]{3,80}$/u;
const SCHEME = /^[a-z0-9_]{2,40}$/u;
const POINTER = /^\S(?:.*\S)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  issues: string[],
  value: unknown,
  path: string,
  rules: { max?: number; pattern?: RegExp; patternHint?: string } = {},
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} 必填且必须是非空字符串`);
    return '';
  }
  const trimmed = value.trim();
  if (rules.max !== undefined && trimmed.length > rules.max) {
    issues.push(`${path} 超过 ${rules.max} 字符`);
  }
  if (rules.pattern && !rules.pattern.test(trimmed)) {
    issues.push(`${path} 格式非法${rules.patternHint ? `（${rules.patternHint}）` : ''}`);
  }
  return trimmed;
}

function optionalPointer(issues: string[], value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || !POINTER.test(value.trim())) {
    issues.push(`${path} 必须是非空字符串指针或 null`);
    return null;
  }
  return value.trim();
}

function parseMap<T extends string>(
  issues: string[],
  value: unknown,
  path: string,
  allowed: readonly T[],
): Record<string, T> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  const out: Record<string, T> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) {
      issues.push(`${path} 含空键`);
      continue;
    }
    if (typeof rawValue !== 'string' || !allowed.includes(rawValue as T)) {
      issues.push(`${path}.${rawKey} 必须是 ${allowed.join(' | ')} 之一`);
      continue;
    }
    out[key] = rawValue as T;
  }
  return out;
}

function parseStringMap(
  issues: string[],
  value: unknown,
  path: string,
): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (!key || typeof rawValue !== 'string' || rawValue.trim().length === 0) {
      issues.push(`${path}.${rawKey} 必须是非空字符串`);
      continue;
    }
    out[key] = rawValue.trim();
  }
  return out;
}

/**
 * 校验并归一帧配置。任何结构性问题一次性收集后抛 `FrameConfigError`
 * （fail closed：配置不合格不得开始装载）。
 */
export function parseFrameConfig(input: unknown): FrameConfig {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new FrameConfigError('frame 配置必须是对象', ['root 必须是对象']);
  }
  if (input.schemaVersion !== 'registry-frame/v1') {
    issues.push('schemaVersion 必须是 registry-frame/v1');
  }

  const rawFrame = isRecord(input.frame) ? input.frame : (issues.push('frame 必填') as never);
  const frame: FrameDefinitionInput = {
    frameKey: requireString(issues, rawFrame?.frameKey, 'frame.frameKey', {
      max: 80,
      pattern: FRAME_KEY,
      patternHint: '小写字母/数字/下划线',
    }),
    country: requireString(issues, rawFrame?.country, 'frame.country', {
      pattern: ISO2,
      patternHint: 'ISO 3166-1 alpha-2 大写',
    }),
    scheme: requireString(issues, rawFrame?.scheme, 'frame.scheme', {
      max: 40,
      pattern: SCHEME,
      patternHint: '小写字母/数字/下划线',
    }),
    label: requireString(issues, rawFrame?.label, 'frame.label', { max: 200 }),
    providerKey: requireString(issues, rawFrame?.providerKey, 'frame.providerKey', { max: 40 }),
    sourceUrl: requireString(issues, rawFrame?.sourceUrl, 'frame.sourceUrl', { max: 2048 }),
    licence: requireString(issues, rawFrame?.licence, 'frame.licence', { max: 120 }),
    licenceUrl: rawFrame?.licenceUrl == null ? null : String(rawFrame.licenceUrl),
    fetchMode: (rawFrame?.fetchMode ?? '') as FrameFetchMode,
    cadence: isRecord(rawFrame?.cadence) ? (rawFrame.cadence as Record<string, unknown>) : null,
    config: isRecord(rawFrame?.config) ? (rawFrame.config as Record<string, unknown>) : {},
    expectedCount:
      typeof rawFrame?.expectedCount === 'number' && Number.isFinite(rawFrame.expectedCount)
        ? rawFrame.expectedCount
        : null,
  };
  if (frame.sourceUrl && !/^https?:\/\/\S+$/u.test(frame.sourceUrl)) {
    issues.push('frame.sourceUrl 必须是 http(s) URL');
  }
  if (!FRAME_FETCH_MODES.includes(frame.fetchMode)) {
    issues.push(`frame.fetchMode 必须是 ${FRAME_FETCH_MODES.join(' | ')} 之一`);
  }

  const rawMapping = isRecord(input.mapping) ? input.mapping : (issues.push('mapping 必填') as never);
  const rawFields = isRecord(rawMapping?.fields)
    ? rawMapping.fields
    : (issues.push('mapping.fields 必填') as never);

  const format = rawMapping?.format as FrameFormat;
  if (format !== 'csv' && format !== 'json') {
    issues.push('mapping.format 必须是 csv 或 json');
  }
  if (rawMapping?.schemaVersion !== 'registry-frame-mapping/v1') {
    issues.push('mapping.schemaVersion 必须是 registry-frame-mapping/v1');
  }

  let csv: { delimiter?: string } | null = null;
  if (format === 'csv') {
    const rawCsv = isRecord(rawMapping?.csv) ? rawMapping.csv : {};
    const delimiter = typeof rawCsv.delimiter === 'string' ? rawCsv.delimiter : ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      issues.push('mapping.csv.delimiter 必须是单字符（不能是引号/换行）');
    }
    csv = { delimiter };
  }

  let recordsPath: string | null = null;
  if (format === 'json') {
    recordsPath = requireString(issues, rawMapping?.recordsPath, 'mapping.recordsPath');
  }

  const rawConstants = isRecord(rawMapping?.constants) ? rawMapping.constants : {};
  const constants = {
    scheme: requireString(issues, rawConstants.scheme, 'mapping.constants.scheme', {
      max: 40,
      pattern: SCHEME,
      patternHint: '小写字母/数字/下划线',
    }),
    country:
      rawConstants.country == null
        ? null
        : requireString(issues, rawConstants.country, 'mapping.constants.country', {
            pattern: ISO2,
            patternHint: 'ISO 3166-1 alpha-2 大写',
          }),
  };
  if (constants.scheme && frame.scheme && constants.scheme !== frame.scheme) {
    issues.push('mapping.constants.scheme 必须与 frame.scheme 一致');
  }

  const addressLines = rawFields?.addressLines;
  let parsedAddressLines: string[] | null = null;
  if (addressLines != null) {
    if (
      !Array.isArray(addressLines) ||
      addressLines.length === 0 ||
      addressLines.some((v) => typeof v !== 'string' || v.trim().length === 0)
    ) {
      issues.push('mapping.fields.addressLines 必须是非空字符串数组');
    } else {
      parsedAddressLines = addressLines.map((v: string) => v.trim());
    }
  }

  let identifiers: Array<{ scheme: string; value: string }> | null = null;
  const rawIdentifiers = rawFields?.identifiers;
  if (rawIdentifiers != null) {
    if (!Array.isArray(rawIdentifiers)) {
      issues.push('mapping.fields.identifiers 必须是数组');
    } else {
      identifiers = [];
      for (const entry of rawIdentifiers) {
        if (
          !isRecord(entry) ||
          typeof entry.scheme !== 'string' ||
          !SCHEME.test(entry.scheme) ||
          typeof entry.value !== 'string' ||
          entry.value.trim().length === 0
        ) {
          issues.push('mapping.fields.identifiers 每项必须是 {scheme, value}');
          continue;
        }
        identifiers.push({ scheme: entry.scheme, value: entry.value.trim() });
      }
      if (identifiers.length === 0) identifiers = null;
    }
  }

  const fields: FrameFieldMapping = {
    regNumber: requireString(issues, rawFields?.regNumber, 'mapping.fields.regNumber'),
    name: requireString(issues, rawFields?.name, 'mapping.fields.name'),
    country: optionalPointer(issues, rawFields?.country, 'mapping.fields.country'),
    status: optionalPointer(issues, rawFields?.status, 'mapping.fields.status'),
    legalForm: optionalPointer(issues, rawFields?.legalForm, 'mapping.fields.legalForm'),
    city: optionalPointer(issues, rawFields?.city, 'mapping.fields.city'),
    region: optionalPointer(issues, rawFields?.region, 'mapping.fields.region'),
    postalCode: optionalPointer(issues, rawFields?.postalCode, 'mapping.fields.postalCode'),
    addressLines: parsedAddressLines,
    nace: optionalPointer(issues, rawFields?.nace, 'mapping.fields.nace'),
    naceVersion: optionalPointer(issues, rawFields?.naceVersion, 'mapping.fields.naceVersion'),
    employeeBand: optionalPointer(issues, rawFields?.employeeBand, 'mapping.fields.employeeBand'),
    vatId: optionalPointer(issues, rawFields?.vatId, 'mapping.fields.vatId'),
    lei: optionalPointer(issues, rawFields?.lei, 'mapping.fields.lei'),
    website: optionalPointer(issues, rawFields?.website, 'mapping.fields.website'),
    identifiers,
  };
  if (fields.country == null && constants.country == null) {
    issues.push('country 缺失：mapping.fields.country 与 mapping.constants.country 至少给一个');
  }

  const mapping: FrameMapping = {
    schemaVersion: 'registry-frame-mapping/v1',
    format,
    csv,
    recordsPath,
    constants,
    fields,
    statusMap: parseMap(issues, rawMapping?.statusMap, 'mapping.statusMap', REGISTRY_ENTITY_STATUSES),
    legalFormMap: parseStringMap(issues, rawMapping?.legalFormMap, 'mapping.legalFormMap'),
    employeeBandMap: parseMap(
      issues,
      rawMapping?.employeeBandMap,
      'mapping.employeeBandMap',
      EMPLOYEE_BANDS,
    ),
  };

  if (issues.length > 0) {
    throw new FrameConfigError(`frame 配置校验失败（${issues.length} 项）`, issues);
  }
  return { schemaVersion: 'registry-frame/v1', frame, mapping };
}
