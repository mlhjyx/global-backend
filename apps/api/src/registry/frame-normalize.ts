/**
 * 单行归一：源记录 → registry_entity 字段集（含确定性 contentHash）。
 *
 * 归一规则（v0，fail closed）：
 *  - 必填：注册号、名称；国家来自字段映射或常量（ISO2 大写）。
 *  - LEI（20 位大写字母数字）与 VAT（两字母国别前缀 + 字母数字）格式非法即整行错误，
 *    防止脏标识进入硬键归并。
 *  - 状态/法律形式/规模带按映射表转换；状态无法映射时落 UNKNOWN 并记 warning（不丢行）。
 *  - contentHash = 归一字段的规范序列哈希：同一实体两次装载哈希稳定，任何归一字段
 *    变化都会变哈希（快照 diff 与乐观锁的依据）。
 */
import { createHash } from 'node:crypto';
import { normalizeCompanyName, normalizeDomain } from '../discovery/identity';
import type {
  EmployeeBand,
  FrameMapping,
  RegistryEntityStatus,
} from './frame-types';
import { EMPLOYEE_BANDS, REGISTRY_ENTITY_STATUSES } from './frame-types';
import { canonicalNace } from './industry-map';

export interface NormalizedRegistryEntity {
  scheme: string;
  regNumber: string;
  country: string;
  name: string;
  nameNorm: string;
  legalForm: string | null;
  status: RegistryEntityStatus;
  addressJson: { lines: string[] } | null;
  city: string | null;
  postalCode: string | null;
  region: string | null;
  nace: string | null;
  naceVersion: string | null;
  employeeBand: EmployeeBand | null;
  vatId: string | null;
  lei: string | null;
  website: string | null;
  identifiers: Array<{ scheme: string; value: string }> | null;
  /** 源特有属性（如 FR diffusionCommerciale=false 表示当事人反对商业推介）。 */
  attributes: Record<string, string> | null;
  contentHash: string;
}

export interface RowIssue {
  row: number;
  field: string;
  code: string;
  detail?: string;
}

export type FieldReader = (pointer: string) => { text: string | null; list: string[] | null };

const CONTROL_CHARS = /\p{Cc}+/gu;
const ISO2 = /^[A-Z]{2}$/u;
const LEI_PATTERN = /^[A-Z0-9]{20}$/u;
const VAT_PATTERN = /^[A-Z]{2}[A-Z0-9]{2,30}$/u;
// NACE Rev.2 类目（28.13 / 2813）及其国家派生码（NAF rev2 的 28.13Z 等带字母后缀）。
const NACE_PATTERN = /^\d{2}(?:(?:\.\d{1,2}|\d{2})[A-Z]?)?$/u;

export function normalizeRegNumber(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim().toUpperCase();
}

export function normalizeVatId(raw: string): string | null {
  const stripped = raw.normalize('NFC').toUpperCase().replace(/[\s.-]/gu, '');
  return stripped.length === 0 ? null : stripped;
}

export function normalizeLei(raw: string): string | null {
  const stripped = raw.normalize('NFC').toUpperCase().replace(/\s+/gu, '');
  return stripped.length === 0 ? null : stripped;
}

function cleanText(raw: string | null, max: number): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

function canonicalWebsite(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const domain = normalizeDomain(trimmed);
  if (!domain) return null;
  const host = domain.split(':')[0]?.replace(/\.$/u, '') ?? '';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(host)) {
    return null;
  }
  if (!/\.[a-z]{2,}$/u.test(host)) return null;
  return host;
}

/** 归一字段的规范序列哈希（字段顺序固定；contentHash 本身除外）。 */
export function contentHashFor(entity: Omit<NormalizedRegistryEntity, 'contentHash'>): string {
  const parts = [
    entity.scheme,
    entity.regNumber,
    entity.country,
    entity.name,
    entity.nameNorm,
    entity.legalForm ?? '',
    entity.status,
    entity.addressJson ? JSON.stringify(entity.addressJson) : '',
    entity.city ?? '',
    entity.postalCode ?? '',
    entity.region ?? '',
    entity.nace ?? '',
    entity.naceVersion ?? '',
    entity.employeeBand ?? '',
    entity.vatId ?? '',
    entity.lei ?? '',
    entity.website ?? '',
    entity.identifiers ? JSON.stringify(entity.identifiers) : '',
    entity.attributes
      ? JSON.stringify(
          Object.keys(entity.attributes)
            .sort()
            .map((key) => [key, entity.attributes![key]]),
        )
      : '',
  ];
  return createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex');
}

export interface NormalizeRecordInput {
  mapping: FrameMapping;
  row: number;
  read: FieldReader;
}

export type NormalizeRecordResult =
  | { ok: true; entity: NormalizedRegistryEntity; warnings: RowIssue[] }
  | { ok: false; issues: RowIssue[] };

export function normalizeRecord(input: NormalizeRecordInput): NormalizeRecordResult {
  const { mapping, row, read } = input;
  const issues: RowIssue[] = [];
  const warnings: RowIssue[] = [];

  const regNumberRaw = read(mapping.fields.regNumber).text ?? '';
  const regNumber = normalizeRegNumber(regNumberRaw);
  if (!regNumber) {
    issues.push({ row, field: 'regNumber', code: 'REG_NUMBER_MISSING' });
  } else if (regNumber.length > 64) {
    issues.push({ row, field: 'regNumber', code: 'REG_NUMBER_TOO_LONG' });
  }

  const nameRaw = read(mapping.fields.name).text ?? '';
  const name = nameRaw.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  if (!name) {
    issues.push({ row, field: 'name', code: 'NAME_MISSING' });
  } else if (name.length > 500) {
    issues.push({ row, field: 'name', code: 'NAME_TOO_LONG' });
  }
  const nameNorm = name ? normalizeCompanyName(name).slice(0, 500) : '';

  const countryRaw = mapping.fields.country
    ? (read(mapping.fields.country).text ?? '')
    : (mapping.constants.country ?? '');
  const country = countryRaw.normalize('NFC').trim().toUpperCase();
  if (!ISO2.test(country)) {
    issues.push({
      row,
      field: 'country',
      code: 'COUNTRY_INVALID',
      detail: countryRaw || '(空)',
    });
  }

  let status: RegistryEntityStatus = 'UNKNOWN';
  const statusRaw = mapping.fields.status ? (read(mapping.fields.status).text ?? '') : '';
  if (statusRaw.trim()) {
    const mapped = mapping.statusMap?.[statusRaw.trim().toLowerCase()];
    if (mapped && REGISTRY_ENTITY_STATUSES.includes(mapped)) {
      status = mapped;
    } else {
      warnings.push({
        row,
        field: 'status',
        code: 'STATUS_UNMAPPED',
        detail: statusRaw.trim(),
      });
    }
  }

  let legalForm: string | null = null;
  const legalFormRaw = mapping.fields.legalForm
    ? (read(mapping.fields.legalForm).text ?? '')
    : '';
  if (legalFormRaw.trim()) {
    legalForm =
      mapping.legalFormMap?.[legalFormRaw.trim().toLowerCase()] ?? cleanText(legalFormRaw, 80);
  }

  let employeeBand: EmployeeBand | null = null;
  const bandRaw = mapping.fields.employeeBand
    ? (read(mapping.fields.employeeBand).text ?? '')
    : '';
  if (bandRaw.trim()) {
    const mapped = mapping.employeeBandMap?.[bandRaw.trim().toLowerCase()];
    if (mapped) {
      employeeBand = mapped;
    } else if ((EMPLOYEE_BANDS as readonly string[]).includes(bandRaw.trim())) {
      employeeBand = bandRaw.trim() as EmployeeBand;
    } else {
      warnings.push({
        row,
        field: 'employeeBand',
        code: 'EMPLOYEE_BAND_UNMAPPED',
        detail: bandRaw.trim(),
      });
    }
  }

  let lei: string | null = null;
  const leiRaw = mapping.fields.lei ? (read(mapping.fields.lei).text ?? '') : '';
  if (leiRaw.trim()) {
    const candidate = normalizeLei(leiRaw);
    if (!candidate || !LEI_PATTERN.test(candidate)) {
      issues.push({ row, field: 'lei', code: 'LEI_INVALID', detail: leiRaw.trim() });
    } else {
      lei = candidate;
    }
  }

  let vatId: string | null = null;
  const vatRaw = mapping.fields.vatId ? (read(mapping.fields.vatId).text ?? '') : '';
  if (vatRaw.trim()) {
    const candidate = normalizeVatId(vatRaw);
    if (!candidate || !VAT_PATTERN.test(candidate)) {
      issues.push({ row, field: 'vatId', code: 'VAT_INVALID', detail: vatRaw.trim() });
    } else {
      vatId = candidate;
    }
  }

  let website: string | null = null;
  const websiteRaw = mapping.fields.website ? (read(mapping.fields.website).text ?? '') : '';
  if (websiteRaw.trim()) {
    website = canonicalWebsite(websiteRaw);
    if (!website) {
      issues.push({ row, field: 'website', code: 'WEBSITE_INVALID', detail: websiteRaw.trim() });
    }
  }

  let nace: string | null = null;
  const naceRaw = mapping.fields.nace ? (read(mapping.fields.nace).text ?? '') : '';
  if (naceRaw.trim()) {
    const candidate = naceRaw.trim();
    if (NACE_PATTERN.test(candidate)) {
      // 国家派生码（NAF 28.13Z、无点号 2813）归一到 NACE 类目形态；原始码保留在源快照里。
      nace = canonicalNace(candidate) ?? candidate;
    } else {
      warnings.push({ row, field: 'nace', code: 'NACE_INVALID', detail: candidate });
    }
  }
  const naceVersion =
    (mapping.fields.naceVersion
      ? cleanText(read(mapping.fields.naceVersion).text, 16)
      : null) ??
    mapping.constants.naceVersion ??
    null;

  let addressJson: { lines: string[] } | null = null;
  if (mapping.fields.addressLines?.length) {
    const lines: string[] = [];
    for (const pointer of mapping.fields.addressLines) {
      const value = read(pointer);
      const candidates = value.list ?? (value.text ? [value.text] : []);
      for (const candidate of candidates) {
        const cleaned = cleanText(candidate, 200);
        if (cleaned && lines[lines.length - 1] !== cleaned) lines.push(cleaned);
      }
    }
    if (lines.length > 0) addressJson = { lines };
  }

  let attributes: Record<string, string> | null = null;
  if (mapping.fields.attributes) {
    const collected: Record<string, string> = {};
    for (const [name, pointer] of Object.entries(mapping.fields.attributes)) {
      const value = cleanText(read(pointer).text, 120);
      if (value) collected[name] = value;
    }
    if (Object.keys(collected).length > 0) {
      attributes = Object.fromEntries(
        Object.keys(collected)
          .sort()
          .map((key) => [key, collected[key]!]),
      );
    }
  }

  let identifiers: Array<{ scheme: string; value: string }> | null = null;
  if (mapping.fields.identifiers?.length) {
    const collected: Array<{ scheme: string; value: string }> = [];
    for (const entry of mapping.fields.identifiers) {
      const value = read(entry.value).text;
      const cleaned = value == null ? null : cleanText(value, 64);
      if (cleaned) collected.push({ scheme: entry.scheme, value: cleaned });
    }
    if (collected.length > 0) identifiers = collected;
  }

  const city = mapping.fields.city ? cleanText(read(mapping.fields.city).text, 120) : null;
  const region = mapping.fields.region ? cleanText(read(mapping.fields.region).text, 120) : null;
  const postalRaw = mapping.fields.postalCode
    ? cleanText(read(mapping.fields.postalCode).text, 24)
    : null;
  const postalCode = postalRaw ? postalRaw.toUpperCase() : null;

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const entityWithoutHash: Omit<NormalizedRegistryEntity, 'contentHash'> = {
    scheme: mapping.constants.scheme,
    regNumber,
    country,
    name,
    nameNorm,
    legalForm,
    status,
    addressJson,
    city,
    postalCode,
    region,
    nace,
    naceVersion,
    employeeBand,
    vatId,
    lei,
    website,
    identifiers,
    attributes,
  };
  return {
    ok: true,
    entity: { ...entityWithoutHash, contentHash: contentHashFor(entityWithoutHash) },
    warnings,
  };
}

/** CSV 行读取器：指针即列名。 */
export function csvFieldReader(
  header: string[],
  values: string[],
): FieldReader {
  const index = new Map(header.map((name, i) => [name, i]));
  return (pointer) => {
    const i = index.get(pointer);
    if (i === undefined) return { text: null, list: null };
    return { text: values[i] ?? '', list: null };
  };
}

/** JSON 行读取器：指针即点分路径。 */
export function jsonFieldReader(value: unknown, readPath: (value: unknown, path: string) => unknown): FieldReader {
  return (pointer) => {
    const found = readPath(value, pointer);
    if (found == null) return { text: null, list: null };
    if (Array.isArray(found)) {
      return { text: null, list: found.map((item) => String(item)) };
    }
    if (typeof found === 'object') return { text: null, list: null };
    return { text: String(found), list: null };
  };
}
