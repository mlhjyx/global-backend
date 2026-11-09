/**
 * 存量公司数据归一（2026-11-10）：country 变体 → ISO alpha-2、industry 空缺 → ISIC/NACE 锚定。
 *
 * 背景（dev 库实测）：canonical_company.country 里 `DE` 846 与 `德国` 72 并存，NULL 1169；
 * industry 2303 行为空，非空行是自由文本（中/英混杂）。判定链（judgment/gates.ts 的
 * normalizeCountryIso）按 ISO 读 country——中文国名让国家门静默 NOT_APPLICABLE；
 * 空 industry 让 ICP 行业规则（prefilterAttributes.industry）无从匹配。
 *
 * 本模块全部为**纯函数**（无 IO、无模型），供回填脚本与后续归一逻辑复用：
 *  - `normalizeCountryValue`：词表（vocab.ts，中/英/德）+ alpha-2/alpha-3 → alpha-2；
 *    不认识的值返回 null（绝不猜）。
 *  - `inferCountryFromAttributes`：仅用**确定性证据**补 NULL country——
 *    `attributes.gleif.registered_country`（T1 注册库）与 `website_profile.vat_id` 前缀
 *    （增值税号前两位是 ISO 国家码，DE/AT/CH 等）。
 *  - `inferIndustryFromAttributes`：ISIC_SEED 别名词表（industry-map 同一匹配器）对
 *    keywords/products/website_profile.evidence 做词面匹配，另接 TED CPV 与 FDA product code
 *    交叉表；命中节点按「命中词数 → 码具体度」选最优，产出 ISIC 英文名 + NACE 前缀 + 证据词。
 *
 * 不做什么：不改已有非空 industry（自由文本原样保留）；不从域名 TLD 猜国家；不认识的值
 * 只进报告，不落库。
 */
import { ISIC_SEED, type IsicNode } from './isic-seed';
import { lookupCountryIso } from './vocab';
import { matchIsicNodesForTerms, type IsicNodeMatch } from '../registry/industry-map';

/** ISO 3661-1 alpha-3 → alpha-2（仅覆盖词表国家 + 常见来源输出；其余不猜）。 */
const ISO3_TO_ISO2: Readonly<Record<string, string>> = Object.freeze({
  DEU: 'DE',
  AUT: 'AT',
  CHE: 'CH',
  USA: 'US',
  CHN: 'CN',
  JPN: 'JP',
  ITA: 'IT',
  FRA: 'FR',
  GBR: 'GB',
  IND: 'IN',
  NLD: 'NL',
  POL: 'PL',
  ESP: 'ES',
});

/**
 * 认识的 alpha-2 码集合：词表国家的值 + 常见贸易国。`normalizeCountryIso`（判定链）把任意
 * 两字母大写直接当 ISO——回填侧更保守：只有认识的码才接受，避免把垃圾两字母值固化成国家。
 */
const KNOWN_ISO2: ReadonlySet<string> = new Set([
  ...Object.values(ISO3_TO_ISO2),
  'SE', 'DK', 'FI', 'NO', 'BE', 'LU', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'PT', 'IE',
  'EE', 'LV', 'LT', 'SI', 'HR', 'RS', 'TR', 'UA', 'CA', 'MX', 'BR', 'AU', 'NZ', 'KR',
  'SG', 'IL', 'AE', 'SA', 'ZA', 'EG', 'MA', 'TN', 'VN', 'TH', 'MY', 'ID', 'PH', 'PK',
  'BD', 'LK', 'TW', 'HK', 'AR', 'CL', 'CO', 'PE',
]);

/**
 * VAT 号前缀 → ISO alpha-2。只收「前缀即国家」的体系（DE/AT/CH/FR/IT/NL/PL/ES/GB/CN…）；
 * 美国无 VAT，EIN 无前缀语义。AT 号形如 ATU12345678、CH 形如 CHE-123.456.789。
 */
const VAT_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  DE: 'DE',
  AT: 'AT',
  CH: 'CH',
  FR: 'FR',
  IT: 'IT',
  NL: 'NL',
  PL: 'PL',
  ES: 'ES',
  BE: 'BE',
  LU: 'LU',
  DK: 'DK',
  SE: 'SE',
  FI: 'FI',
  CZ: 'CZ',
  SK: 'SK',
  HU: 'HU',
  RO: 'RO',
  BG: 'BG',
  GR: 'GR',
  PT: 'PT',
  IE: 'IE',
  GB: 'GB',
  CN: 'CN',
  IN: 'IN',
  JP: 'JP',
  KR: 'KR',
  TR: 'TR',
  UA: 'UA',
  RS: 'RS',
  HR: 'HR',
  SI: 'SI',
  EE: 'EE',
  LV: 'LV',
  LT: 'LT',
  NO: 'NO',
});

/**
 * 原始 country 值 → ISO alpha-2；不认识的值返回 null。
 * 大小写与首尾空白不敏感；词表覆盖中/英/德国名（德国/Deutschland/germany → DE）。
 */
export function normalizeCountryValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mapped = lookupCountryIso(trimmed) ?? lookupCountryIso(trimmed.toLowerCase());
  if (mapped) return mapped;
  if (/^[A-Za-z]{2}$/u.test(trimmed)) {
    const code = trimmed.toUpperCase();
    return KNOWN_ISO2.has(code) ? code : null;
  }
  if (/^[A-Za-z]{3}$/u.test(trimmed)) {
    return ISO3_TO_ISO2[trimmed.toUpperCase()] ?? null;
  }
  return null;
}

export interface CountryInference {
  iso: string;
  source: 'vat_id' | 'gleif_registered_country';
  /** 触发推断的原始值（vat_id 本身是登记信息，非个人数据；仅用于报告追溯）。 */
  evidence: string;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function iso2FromVat(raw: string): string | null {
  const compact = raw.replace(/[\s.-]/gu, '').toUpperCase();
  const prefix = compact.slice(0, 2);
  const iso = VAT_PREFIXES[prefix];
  return iso ?? null;
}

/** 仅用确定性证据推断 NULL 国家（gleif 注册国优先于 VAT 前缀，二者都是登记事实）。 */
export function inferCountryFromAttributes(attributes: unknown): CountryInference | null {
  const root = jsonObject(attributes);
  if (!root) return null;
  const gleif = jsonObject(root.gleif);
  const registered = gleif?.registered_country;
  if (typeof registered === 'string') {
    const iso = normalizeCountryValue(registered);
    if (iso) return { iso, source: 'gleif_registered_country', evidence: registered };
  }
  const profile = jsonObject(root.website_profile);
  const vat = profile?.vat_id;
  if (typeof vat === 'string') {
    const iso = iso2FromVat(vat);
    if (iso) return { iso, source: 'vat_id', evidence: vat };
  }
  return null;
}

/** TED CPV 前缀锚（去尾零：'42120000'→'4212'，覆盖子树 4212xxxx）。 */
function cpvSubtreePrefix(code: string): string {
  return code.replace(/0+$/u, '') || code;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export interface IndustryInference {
  isicCode: string;
  /** ISIC 英文名（回填写入 canonical_company.industry 的值）。 */
  isicName: string;
  nacePrefixes: string[];
  /** 命中的词/码（截断后随 attributes.industry_normalization 落库，供复核）。 */
  matchedTerms: string[];
  /** 证据来自哪些属性域（keywords/products/website_profile/ted/fda）。 */
  sources: string[];
}

const MAX_STORED_TERMS = 8;
const MAX_TERM_CHARS = 80;

function storableTerm(term: string): boolean {
  return term.length <= MAX_TERM_CHARS && !/\d{7,}/u.test(term);
}

/** 推断可选端口：FDA product code 无内置交叉表，由调用方从 canonical_taxonomy 提供 code→panel。 */
export interface IndustryInferencePorts {
  fdaPanelOf?: (code: string) => string | null;
}

/**
 * 空 industry 的确定性推断。证据域：
 *  - keywords / products：受控词（已是短词）；
 *  - website_profile.evidence：官网抽取的证据句——句子本身不落库，落库的只有命中的别名；
 *  - ted.cpv：中标公告 CPV 码 → ISIC crosswalks.cpv 前缀锚；
 *  - fda.product_codes：FDA 器械产品码 →（ports 提供 code→panel）→ ISIC crosswalks.fdaPanels。
 * 没有任何命中返回 null（绝不猜）。
 */
export function inferIndustryFromAttributes(
  attributes: unknown,
  ports?: IndustryInferencePorts,
): IndustryInference | null {
  const root = jsonObject(attributes);
  if (!root) return null;
  const bySource: Array<[string, string[]]> = [
    ['keywords', stringArray(root.keywords)],
    ['products', stringArray(root.products)],
    ['website_profile', stringArray(jsonObject(root.website_profile)?.evidence)],
  ];
  const matches = new Map<string, { match: IsicNodeMatch; sources: Set<string>; weight: number }>();
  // 受控词（keywords/products）命中权重 2，自由证据句（website_profile.evidence）权重 1：
  // 官网整句常顺带提到材质/配件词（如「不锈钢」），加权后不会盖过受控词的直接证据。
  // 落库口径：受控词存原词；自由证据句**只存命中的词表别名**（`alias:pump`）——证据句可能
  // 含人名/联系方式（PII），整句绝不进入 attributes 与报告。
  const absorb = (nodeMatches: IsicNodeMatch[], source: string): void => {
    if (nodeMatches.length === 0) return;
    const controlled = source === 'keywords' || source === 'products';
    const perTermWeight = controlled ? 2 : 1;
    for (const nodeMatch of nodeMatches) {
      const current = matches.get(nodeMatch.code) ?? {
        match: { ...nodeMatch, matchedTerms: [], matchedAliases: [] },
        sources: new Set<string>(),
        weight: 0,
      };
      if (controlled) {
        for (const term of nodeMatch.matchedTerms) {
          if (!current.match.matchedTerms.includes(term)) {
            current.match.matchedTerms.push(term);
            current.weight += perTermWeight;
          }
        }
      } else {
        // 自由文本源：仅当该节点尚未经此源计过权重时记一次（按别名去重）。
        for (const alias of nodeMatch.matchedAliases) {
          const term = `alias:${alias}`;
          if (!current.match.matchedTerms.includes(term)) {
            current.match.matchedTerms.push(term);
            current.weight += perTermWeight;
          }
        }
      }
      current.sources.add(source);
      matches.set(nodeMatch.code, current);
    }
  };
  for (const [source, terms] of bySource) {
    absorb(matchIsicNodesForTerms(terms), source);
  }
  // TED CPV：反向查 ISIC crosswalks.cpv 前缀锚。
  const cpvCodes = stringArray(jsonObject(root.ted)?.cpv);
  if (cpvCodes.length > 0) {
    for (const node of ISIC_SEED as readonly IsicNode[]) {
      const anchors = node.crosswalks?.cpv ?? [];
      if (anchors.length === 0) continue;
      const hit = cpvCodes.find((code) =>
        anchors.some((anchor) => code.startsWith(cpvSubtreePrefix(anchor))),
      );
      if (!hit) continue;
      const current = matches.get(node.code) ?? {
        match: {
          code: node.code,
          en: node.en,
          nacePrefixes: [...(node.crosswalks?.nace ?? [])],
          matchedTerms: [],
          matchedAliases: [],
        },
        sources: new Set<string>(),
        weight: 0,
      };
      // 存前缀形态（去尾零）：8 位原码会被 sanitizer 的电话形态规则丢弃。
      const term = `cpv:${cpvSubtreePrefix(hit)}`;
      if (!current.match.matchedTerms.includes(term)) {
        current.match.matchedTerms.push(term);
        current.weight += 1;
      }
      current.sources.add('ted');
      matches.set(node.code, current);
    }
  }
  // FDA product code：code→panel 由调用方提供，再查 ISIC crosswalks.fdaPanels。
  const fdaCodes = stringArray(jsonObject(root.fda)?.product_codes);
  if (fdaCodes.length > 0 && ports?.fdaPanelOf) {
    const panelsByCode = new Map<string, string>();
    for (const code of fdaCodes) {
      const panel = ports.fdaPanelOf(code);
      if (panel) panelsByCode.set(code, panel);
    }
    for (const node of ISIC_SEED as readonly IsicNode[]) {
      const panels = node.crosswalks?.fdaPanels ?? [];
      const hit = [...panelsByCode.entries()].find(([, panel]) => panels.includes(panel));
      if (!hit) continue;
      const code = hit[0];
      const current = matches.get(node.code) ?? {
        match: {
          code: node.code,
          en: node.en,
          nacePrefixes: [...(node.crosswalks?.nace ?? [])],
          matchedTerms: [],
          matchedAliases: [],
        },
        sources: new Set<string>(),
        weight: 0,
      };
      const term = `fda:${code}`;
      if (!current.match.matchedTerms.includes(term)) {
        current.match.matchedTerms.push(term);
        current.weight += 1;
      }
      current.sources.add('fda');
      matches.set(node.code, current);
    }
  }
  if (matches.size === 0) return null;
  const best = [...matches.values()].sort(
    (a, b) =>
      b.weight - a.weight ||
      b.match.matchedTerms.length - a.match.matchedTerms.length ||
      b.match.code.length - a.match.code.length ||
      a.match.code.localeCompare(b.match.code),
  )[0]!;
  return {
    isicCode: best.match.code,
    isicName: best.match.en,
    nacePrefixes: best.match.nacePrefixes,
    // 证据句截断后落库（只留命中依据；整句可能含电话形态被 sanitizer 拒收）。
    matchedTerms: best.match.matchedTerms
      .map((term) =>
        term.length > MAX_TERM_CHARS ? `${term.slice(0, MAX_TERM_CHARS - 1)}…` : term,
      )
      .filter(storableTerm)
      .slice(0, MAX_STORED_TERMS),
    sources: [...best.sources].sort(),
  };
}

export interface CompanyNormalizationPlan {
  /** country 变化：变体归一（德国→DE）或确定性证据补空。 */
  country?: { from: string | null; to: string; reason: 'variant' | CountryInference['source'] };
  /** industry 变化：仅当原值为空（null/空白）时回填。 */
  industry?: { from: null; to: string; inference: IndustryInference };
}

/**
 * 单行归一计划（幂等：已归一/非空的值不再产生变化）。
 * - country 非空但不是标准 alpha-2 → 归一（不认识的值不动，返回 undefined）；
 * - country 空 → 仅当有确定性证据时补；
 * - industry 空 → 有证据时推断，非空值永不覆盖。
 */
export function planCompanyNormalization(
  row: {
    country: string | null | undefined;
    industry: string | null | undefined;
    attributes: unknown;
  },
  ports?: IndustryInferencePorts,
): CompanyNormalizationPlan {
  const plan: CompanyNormalizationPlan = {};
  const countryRaw = typeof row.country === 'string' ? row.country.trim() : '';
  if (countryRaw) {
    const iso = normalizeCountryValue(countryRaw);
    if (iso && iso !== row.country) plan.country = { from: row.country ?? null, to: iso, reason: 'variant' };
  } else {
    const inference = inferCountryFromAttributes(row.attributes);
    if (inference) plan.country = { from: null, to: inference.iso, reason: inference.source };
  }
  const industryRaw = typeof row.industry === 'string' ? row.industry.trim() : '';
  if (!industryRaw) {
    const inference = inferIndustryFromAttributes(row.attributes, ports);
    if (inference) plan.industry = { from: null, to: inference.isicName, inference };
  }
  return plan;
}
