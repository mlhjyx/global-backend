/**
 * L1 规则预筛前的确定性国家推断（Batch 1.2-B）：
 *
 * 解决既有线上痛点：历史库约 42.6% 的候选公司 `canonical_company.country = NULL`，
 * 导致 ICP 的 `country` MUST_HAVE/EXCLUSION 规则退化为 UNKNOWN/漏筛。
 *
 * 严格遵循「高置信单国确定性信号」原则，绝不对多国共用的模糊信号瞎猜：
 *  1. 已有 `company.country`（先走 `normalizeCountryValue` 归一）；
 *  2. 注册/官网权威属性：`gleif.registered_country` 与 `website_profile.vat_id`（复用 `inferCountryFromAttributes`）；
 *  3. 单国明确 ccTLD（如 `.de`/`.it`/`.fr`/`.nl`/`.es`/`.co.uk`/`.com.br`/`.com.au`/`.ae`/`.sa`），
 *     **明确排除**商业化/泛用 ccTLD（`.ai`/`.io`/`.co`/`.me`/`.tv`/`.cc`/`.gg`/`.sh`/`.to`/`.ly`/`.fm`/`.ag`/`.nu`/`.ws` 等）；
 *  4. 单国专属法定企业后缀（如 `S.r.l.`/`S.p.A.`→IT、`B.V.`→NL、`S.A.S.`/`S.A.R.L.`→FR、`S.L.`/`S.L.U.`→ES、
 *     `Sp. z o.o.`→PL、`GmbH & Co. KG`→DE、`Pty Ltd`→AU、`Ltda`→BR、`S.A. de C.V.`→MX、`A.Ş.`→TR、`株式会社`→JP 等），
 *     **明确排除**多国共用后缀（`GmbH` 跨 DE/AT/CH、`Ltd`/`Inc`/`S.A.`/`AG`/`Co., Ltd.` 均不猜）；
 *  5. 单国明确国际区号（`+49`→DE、`+39`→IT、`+971`→AE、`+966`→SA 等），**明确排除**共享区号 `+1`/`+7`。
 */
import { inferCountryFromAttributes, normalizeCountryValue } from './company-normalization';

export type PrefilterCountrySource =
  | 'canonical_country'
  | 'gleif_registered_country'
  | 'vies_registered_country'
  | 'vat_id'
  | 'cctld'
  | 'legal_suffix'
  | 'dial_code';

export interface PrefilterCountryInference {
  readonly iso: string;
  readonly source: PrefilterCountrySource;
  readonly evidence: string;
}

export interface PrefilterCountryInput {
  readonly name?: string | null;
  readonly domain?: string | null;
  readonly country?: string | null;
  readonly attributes?: unknown;
  /** 外部来源收集到的公司电话列表（如 company_contact_channel.channel='phone'）。 */
  readonly phones?: readonly (string | null | undefined)[];
  /** 公司渠道行，自动提取有效 `channel='phone'` 参与第 5 级国际区号推断。 */
  readonly contactChannels?: readonly {
    readonly channel?: string | null;
    readonly value?: string | null;
    readonly status?: string | null;
  }[];
}

/** 商业化/泛用 ccTLD 黑名单：绝不据此推断公司注册国。 */
const COMMERCIALIZED_CCTLDS: ReadonlySet<string> = new Set([
  'ai', 'io', 'co', 'me', 'tv', 'cc', 'gg', 'sh', 'to', 'ly', 'fm', 'ag',
  'nu', 'ws', 'tk', 'ml', 'ga', 'cf', 'gq', 'so', 'vc', 'ac', 'st', 'gl',
  'is', 'la', 'ms', 'bz', 'cm', 'cx', 'gd', 'im', 'je', 'lc', 'sc', 'sx',
  'tc', 'vg', 'eu', 'org', 'com', 'net', 'biz', 'info', 'pro', 'tech', 'energy',
]);

/** 单国明确 ccTLD → ISO 3166-1 alpha-2。 */
const UNAMBIGUOUS_CCTLD_TO_ISO: Readonly<Record<string, string>> = Object.freeze({
  de: 'DE', at: 'AT', ch: 'CH', it: 'IT', fr: 'FR', nl: 'NL', es: 'ES', pl: 'PL',
  uk: 'GB', gb: 'GB', be: 'BE', lu: 'LU', se: 'SE', dk: 'DK', fi: 'FI', no: 'NO',
  cz: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', gr: 'GR', pt: 'PT', ie: 'IE',
  hr: 'HR', si: 'SI', ee: 'EE', lv: 'LV', lt: 'LT', rs: 'RS', ua: 'UA', tr: 'TR',
  us: 'US', ca: 'CA', mx: 'MX', br: 'BR', cl: 'CL', ar: 'AR', pe: 'PE', uy: 'UY',
  au: 'AU', nz: 'NZ', za: 'ZA', eg: 'EG', ma: 'MA', tn: 'TN', ke: 'KE', ng: 'NG',
  ae: 'AE', sa: 'SA', qa: 'QA', kw: 'KW', om: 'OM', bh: 'BH', jo: 'JO', il: 'IL',
  jp: 'JP', kr: 'KR', cn: 'CN', tw: 'TW', hk: 'HK', sg: 'SG', my: 'MY', th: 'TH',
  vn: 'VN', id: 'ID', ph: 'PH', in: 'IN', pk: 'PK', bd: 'BD', lk: 'LK',
});

/** 多级明确国别后缀（在单级 TLD 前优先匹配，例如 .co.uk / .com.br / .com.au / .co.za）。 */
const MULTI_LABEL_CCTLD_TO_ISO: Readonly<Record<string, string>> = Object.freeze({
  'co.uk': 'GB', 'org.uk': 'GB', 'ltd.uk': 'GB', 'plc.uk': 'GB',
  'com.br': 'BR', 'ind.br': 'BR', 'net.br': 'BR',
  'com.au': 'AU', 'net.au': 'AU',
  'co.nz': 'NZ',
  'co.jp': 'JP', 'ne.jp': 'JP', 'or.jp': 'JP',
  'co.kr': 'KR', 'or.kr': 'KR',
  'co.za': 'ZA',
  'com.mx': 'MX', 'com.ar': 'AR', 'com.co': 'CO', 'com.pe': 'PE', 'com.tr': 'TR',
  'com.sa': 'SA', 'com.eg': 'EG', 'com.sg': 'SG', 'com.my': 'MY', 'com.vn': 'VN',
  'co.th': 'TH', 'co.id': 'ID', 'com.ph': 'PH', 'co.in': 'IN', 'com.cn': 'CN',
  'com.tw': 'TW', 'com.hk': 'HK', 'co.il': 'IL', 'com.pl': 'PL',
});

/** 单国专属法定企业后缀规则（高置信度；排除多国共用的 GmbH / AG / Ltd / S.A. / Inc）。 */
const LEGAL_SUFFIX_RULES: ReadonlyArray<Readonly<{ pattern: RegExp; iso: string }>> = [
  { pattern: /\bGmbH\s*&\s*Co\.?\s*KG\b/iu, iso: 'DE' },
  { pattern: /\be\.?\s*K\.?(?:fm|fr)?\.?$/u, iso: 'DE' },
  { pattern: /\bS\.?\s*r\.?\s*l\.?\b/iu, iso: 'IT' },
  { pattern: /\bS\.?\s*p\.?\s*A\.?\b/iu, iso: 'IT' },
  { pattern: /\bS\.?\s*n\.?\s*c\.?\b/iu, iso: 'IT' },
  { pattern: /\bS\.?\s*a\.?\s*s\.?\b/u, iso: 'FR' },
  { pattern: /\bS\.?\s*A\.?\s*S\.?U?\.?\b/u, iso: 'FR' },
  { pattern: /\bS\.?\s*A\.?\s*R\.?\s*L\.?\b/iu, iso: 'FR' },
  { pattern: /\bE\.?\s*U\.?\s*R\.?\s*L\.?\b/iu, iso: 'FR' },
  { pattern: /\bB\.?\s*V\.?\b/u, iso: 'NL' },
  { pattern: /\bS\.?\s*L\.?\s*(?:U|L|N\.?E)?\.?$/u, iso: 'ES' },
  { pattern: /\bSp\.?\s*z\.?\s*o\.?\s*o\.?\b/iu, iso: 'PL' },
  { pattern: /\bSp\.?\s*k\.?\b/iu, iso: 'PL' },
  { pattern: /\bPty\.?\s+Ltd\.?\b/iu, iso: 'AU' },
  { pattern: /\bS\.?\s*A\.?\s+de\s+C\.?\s*V\.?\b/iu, iso: 'MX' },
  { pattern: /\bS\.?\s*de\s+R\.?\s*L\.?\s+de\s+C\.?\s*V\.?\b/iu, iso: 'MX' },
  { pattern: /\bLtda\.?\b/iu, iso: 'BR' },
  { pattern: /\bEIRELI\b/u, iso: 'BR' },
  { pattern: /\bA\.?\s*Ş\.?\b/u, iso: 'TR' },
  { pattern: /\bSan\.?\s*Tic\.?\s*Ltd\.?\s*Şti\.?\b/iu, iso: 'TR' },
  { pattern: /\bApS\b/u, iso: 'DK' },
  { pattern: /\bAktiebolag\b/iu, iso: 'SE' },
  { pattern: /\bOyj?\b/u, iso: 'FI' },
  { pattern: /\bKft\.?\b/u, iso: 'HU' },
  { pattern: /\bZrt\.?\b/u, iso: 'HU' },
  { pattern: /\bSdn\.?\s*Bhd\.?\b/iu, iso: 'MY' },
  { pattern: /\bPvt\.?\s*Ltd\.?\b/iu, iso: 'IN' },
  { pattern: /\bPte\.?\s*Ltd\.?\b/iu, iso: 'SG' },
  { pattern: /(?:\bKabushiki\s+Kaisha\b|株式会社)/iu, iso: 'JP' },
  { pattern: /(?:주식회사|\(주\))/u, iso: 'KR' },
];

/** 单国明确国际电话区号前缀（按长度降序，避开共享区号 +1 / +7）。 */
const DIAL_CODE_TO_ISO: ReadonlyArray<readonly [string, string]> = [
  ['+971', 'AE'], ['+966', 'SA'], ['+974', 'QA'], ['+965', 'KW'], ['+968', 'OM'],
  ['+973', 'BH'], ['+962', 'JO'], ['+972', 'IL'], ['+420', 'CZ'], ['+421', 'SK'],
  ['+351', 'PT'], ['+353', 'IE'], ['+358', 'FI'], ['+352', 'LU'], ['+359', 'BG'],
  ['+370', 'LT'], ['+371', 'LV'], ['+372', 'EE'], ['+380', 'UA'], ['+381', 'RS'],
  ['+385', 'HR'], ['+386', 'SI'], ['+886', 'TW'], ['+852', 'HK'],
  ['+49', 'DE'], ['+43', 'AT'], ['+41', 'CH'], ['+39', 'IT'], ['+33', 'FR'],
  ['+31', 'NL'], ['+34', 'ES'], ['+48', 'PL'], ['+44', 'GB'], ['+32', 'BE'],
  ['+46', 'SE'], ['+45', 'DK'], ['+47', 'NO'], ['+30', 'GR'], ['+36', 'HU'],
  ['+40', 'RO'], ['+90', 'TR'], ['+81', 'JP'], ['+82', 'KR'], ['+86', 'CN'],
  ['+55', 'BR'], ['+52', 'MX'], ['+56', 'CL'], ['+57', 'CO'], ['+51', 'PE'],
  ['+54', 'AR'], ['+61', 'AU'], ['+64', 'NZ'], ['+27', 'ZA'], ['+20', 'EG'],
  ['+65', 'SG'], ['+60', 'MY'], ['+66', 'TH'], ['+84', 'VN'], ['+62', 'ID'],
  ['+63', 'PH'], ['+91', 'IN'], ['+92', 'PK'],
];

export function inferCountryFromDomainTld(domain: string | null | undefined): PrefilterCountryInference | null {
  if (typeof domain !== 'string') return null;
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/\/.*$/u, '')
    .replace(/^www\./u, '')
    .replace(/\.$/u, '');
  if (!host || !host.includes('.')) return null;
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length >= 3) {
    const twoLevel = `${parts.at(-2)}.${parts.at(-1)}`;
    const multiIso = MULTI_LABEL_CCTLD_TO_ISO[twoLevel];
    if (multiIso) return { iso: multiIso, source: 'cctld', evidence: `.${twoLevel}` };
  }
  const tld = parts.at(-1)!;
  if (COMMERCIALIZED_CCTLDS.has(tld)) return null;
  const iso = UNAMBIGUOUS_CCTLD_TO_ISO[tld];
  return iso ? { iso, source: 'cctld', evidence: `.${tld}` } : null;
}

export function inferCountryFromLegalSuffix(name: string | null | undefined): PrefilterCountryInference | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 3) return null;
  for (const rule of LEGAL_SUFFIX_RULES) {
    const match = rule.pattern.exec(trimmed);
    if (match) {
      return { iso: rule.iso, source: 'legal_suffix', evidence: match[0] };
    }
  }
  return null;
}

function collectPhoneStrings(attributes: unknown): string[] {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return [];
  const root = attributes as Record<string, unknown>;
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
      }
    }
  };
  push(root.phone);
  push(root.company_phone);
  push(root.phones);
  const profile = root.website_profile;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    push((profile as Record<string, unknown>).phone);
    push((profile as Record<string, unknown>).phones);
  }
  return out;
}

export function inferCountryFromDialCode(phone: string | null | undefined): PrefilterCountryInference | null {
  if (typeof phone !== 'string') return null;
  const compact = phone.trim().replace(/^00/u, '+').replace(/[\s().-]/gu, '');
  if (!compact.startsWith('+') || compact.length < 8) return null;
  for (const [prefix, iso] of DIAL_CODE_TO_ISO) {
    if (compact.startsWith(prefix)) {
      return { iso, source: 'dial_code', evidence: prefix };
    }
  }
  return null;
}

function collectAllPhoneStrings(input: PrefilterCountryInput): string[] {
  const out = collectPhoneStrings(input.attributes);
  for (const phone of input.phones ?? []) {
    if (typeof phone === 'string' && phone.trim()) out.push(phone.trim());
  }
  for (const ch of input.contactChannels ?? []) {
    if (ch?.channel === 'phone' && ch.status !== 'INVALID' && typeof ch.value === 'string' && ch.value.trim()) {
      out.push(ch.value.trim());
    }
  }
  return out;
}

/**
 * L1 预筛前确定性国家解析：优先权威列与注册库，再按 ccTLD → 单国法定后缀 → 国际区号回退。
 * 当多条电话指向不同单国区号时保守返回 null，不盲猜。
 */
export function inferPrefilterCountry(
  input: PrefilterCountryInput,
): PrefilterCountryInference | null {
  if (typeof input.country === 'string' && input.country.trim()) {
    const normalized = normalizeCountryValue(input.country);
    if (normalized) {
      return { iso: normalized, source: 'canonical_country', evidence: input.country.trim() };
    }
  }
  const fromAttrs = inferCountryFromAttributes(input.attributes);
  if (fromAttrs) {
    return { iso: fromAttrs.iso, source: fromAttrs.source, evidence: fromAttrs.evidence };
  }
  const fromTld = inferCountryFromDomainTld(input.domain);
  if (fromTld) return fromTld;

  const fromSuffix = inferCountryFromLegalSuffix(input.name);
  if (fromSuffix) return fromSuffix;

  const dialHits = new Map<string, PrefilterCountryInference>();
  for (const phone of collectAllPhoneStrings(input)) {
    const fromDial = inferCountryFromDialCode(phone);
    if (fromDial && !dialHits.has(fromDial.iso)) {
      dialHits.set(fromDial.iso, fromDial);
    }
  }
  if (dialHits.size === 1) {
    return [...dialHits.values()][0]!;
  }
  return null;
}
