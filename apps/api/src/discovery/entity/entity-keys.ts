/**
 * 获客挖掘 vNext W2（2026-11-10）：法人实体标识的 scheme 词表与规范式。
 *
 * 权威计划：docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W2。
 * 纪律：确定性键优先（LEI/VAT/注册号），概率匹配只在无确定性键可用时兜底；
 * 规格化在这里收口（大写、去空格与分隔符），DB 的 legal_entity.value 只存规范式，
 * 让「同号不同写法」（"HRB 12345" / "hrb12345" / "HRB-12345"）落同一键。
 *
 * 复用 `registry/frame-normalize` 的 LEI/VAT 归一口径（与 registry_frame 装载一致），
 * 其余 scheme 在本文件定义（HRB/SIREN/CH/KVK/CVR/bolagsverket/other）。
 */
import { normalizeLei, normalizeVatId } from '../../registry/frame-normalize';

export const LEGAL_ENTITY_SCHEMES = [
  'lei',
  'vat',
  'hrb',
  'siren',
  'ch',
  'kvk',
  'cvr',
  'bolagsverket',
  'other',
] as const;
export type LegalEntityScheme = (typeof LEGAL_ENTITY_SCHEMES)[number];

export const LEGAL_ENTITY_STATUSES = ['active', 'inactive', 'dissolved', 'unknown'] as const;
export type LegalEntityStatus = (typeof LEGAL_ENTITY_STATUSES)[number];

export const LEGAL_LINK_METHODS = ['deterministic', 'probabilistic'] as const;
export type LegalLinkMethod = (typeof LEGAL_LINK_METHODS)[number];

export const LEGAL_LINK_STATUSES = ['auto', 'review', 'rejected'] as const;
export type LegalLinkStatus = (typeof LEGAL_LINK_STATUSES)[number];

/**
 * 确定性键的强度：
 *  - `hard`：编号空间在该国/全球唯一（LEI、法国 SIREN、Companies House、KVK、CVR、瑞典
 *    organisationsnummer）→ 命中即可 auto；
 *  - `caveat`：编号可被多个法人共享或按辖区分配——VAT 在税组（Organschaft）可跨法人共享、
 *    德国 HRB 按登记法院分配（"HRB 12345" 在多个 Amtsgericht 各有一家）、other 唯一性未知
 *    → 命中只落 review，等人工/VIES 佐证。
 */
export type SchemeStrength = 'hard' | 'caveat';

export const SCHEME_STRENGTH: Readonly<Record<LegalEntityScheme, SchemeStrength>> = Object.freeze({
  lei: 'hard',
  siren: 'hard',
  ch: 'hard',
  kvk: 'hard',
  cvr: 'hard',
  bolagsverket: 'hard',
  vat: 'caveat',
  hrb: 'caveat',
  other: 'caveat',
});

export function isLegalEntityScheme(value: unknown): value is LegalEntityScheme {
  return typeof value === 'string' && (LEGAL_ENTITY_SCHEMES as readonly string[]).includes(value);
}

export function isLegalEntityStatus(value: unknown): value is LegalEntityStatus {
  return typeof value === 'string' && (LEGAL_ENTITY_STATUSES as readonly string[]).includes(value);
}

/** ISO-3166-1 alpha-2（大写两字母）；不合规 → null。 */
export function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const country = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/u.test(country) ? country : null;
}

/**
 * scheme 各自的规范式；无法规范化/格式明显非法 → null（调用方按 400 / 跳过处理，不落库）。
 *  - lei：20 位大写字母数字（GLEIF 格式）；
 *  - vat：大写、去空格/点/连字符，两字母国别前缀 + 2..12 位字母数字（VIES 层面再校验）；
 *  - hrb：仅接受「HRA/HRB/PR + 数字」或纯数字（紧凑大写）——不臆造缺失的登记法院或前缀；
 *  - siren：9 位数字（14 位 SIRET 截前 9）；
 *  - ch：8 位大写字母数字，且至少含一位数字（Companies House 编号：全数字或两字母前缀）；
 *  - kvk：8 位数字；cvr：8 位数字；bolagsverket：10 位数字（XXXXXXXXXX 的组织号）；
 *  - other：紧凑大写字母数字，1..64 位。
 */
export function normalizeLegalValue(scheme: LegalEntityScheme, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  switch (scheme) {
    case 'lei': {
      const value = normalizeLei(raw);
      return value && /^[A-Z0-9]{20}$/u.test(value) ? value : null;
    }
    case 'vat': {
      // 复用 frame-normalize 的归一（NU/NFC 大写、去空白与 .-）后做形态校验：
      // VIES 的共同体口径是「两字母国别 + 2..12 位 [0-9A-Z+*]」。
      const value = normalizeVatId(raw);
      return value && /^[A-Z]{2}[0-9A-Z+*]{2,12}$/u.test(value) ? value : null;
    }
    case 'hrb': {
      const compact = raw.normalize('NFC').toUpperCase().replace(/[^A-Z0-9]+/gu, '');
      return /^(?:(?:HRA|HRB|PR)\d{1,12}|\d{1,12})$/u.test(compact) ? compact : null;
    }
    case 'siren': {
      // 纯数字体系：只容忍分隔符（空格/点/连字符/斜杠），夹字母一律视为非法值。
      const digits = raw.normalize('NFC').replace(/[\s./-]+/gu, '');
      // SIRET（14 位）= SIREN（9 位）+ NIC（5 位）；取前 9 位是 INSEE 的官方口径。
      if (/^\d{14}$/u.test(digits)) return digits.slice(0, 9);
      return /^\d{9}$/u.test(digits) ? digits : null;
    }
    case 'ch': {
      const compact = raw.normalize('NFC').toUpperCase().replace(/[^A-Z0-9]+/gu, '');
      return /^[A-Z0-9]{8}$/u.test(compact) && /\d/u.test(compact) ? compact : null;
    }
    case 'kvk': {
      const digits = raw.normalize('NFC').replace(/[\s./-]+/gu, '');
      return /^\d{8}$/u.test(digits) ? digits : null;
    }
    case 'cvr': {
      // 丹麦 CVR 常写作 "DK12345678"；接受可选 DK 前缀，其余必须纯 8 位数字。
      const compact = raw.normalize('NFC').toUpperCase().replace(/[\s./-]+/gu, '');
      const match = /^(?:DK)?(\d{8})$/u.exec(compact);
      return match ? match[1]! : null;
    }
    case 'bolagsverket': {
      const digits = raw.normalize('NFC').replace(/[\s./-]+/gu, '');
      return /^\d{10}$/u.test(digits) ? digits : null;
    }
    case 'other': {
      const compact = raw.normalize('NFC').toUpperCase().replace(/[^A-Z0-9]+/gu, '');
      return compact.length >= 1 && compact.length <= 64 ? compact : null;
    }
  }
}
