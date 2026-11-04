/**
 * Search localization for keyword discovery (G3 spec 2026-09-24 §4.3):
 * search language follows the ICP target country, and query strings follow
 * the ICP trade role instead of a hard-coded "manufacturer company" suffix.
 * Pure functions over the query-plan filters; no I/O.
 */

import { MAX_PUBLIC_WEB_SEARCHES_PER_QUERY } from './execution-envelope';
import { lookupMarketRegion } from './vocab';

export type SearchLanguage =
  | 'de' | 'en' | 'fr' | 'it' | 'es' | 'nl' | 'pl' | 'zh'
  | 'ms' | 'id' | 'vi' | 'th' | 'ja' | 'ko' | 'pt' | 'tr';
export type TradeRole = 'distributor' | 'manufacturer';

/** `name` is the country as a search in its own language would write it. */
type CountryEntry = Readonly<{ iso2: string; language: SearchLanguage; name: string; aliases: readonly string[] }>;

const COUNTRIES: readonly CountryEntry[] = Object.freeze([
  { iso2: 'de', language: 'de', name: 'Deutschland', aliases: ['germany', 'deutschland', 'de', 'deu', '德国'] },
  { iso2: 'at', language: 'de', name: 'Österreich', aliases: ['austria', 'österreich', 'oesterreich', 'at', 'aut', '奥地利'] },
  { iso2: 'ch', language: 'de', name: 'Schweiz', aliases: ['switzerland', 'schweiz', 'suisse', 'ch', 'che', '瑞士'] },
  { iso2: 'fr', language: 'fr', name: 'France', aliases: ['france', 'fr', 'fra', '法国'] },
  { iso2: 'it', language: 'it', name: 'Italia', aliases: ['italy', 'italia', 'it', 'ita', '意大利'] },
  { iso2: 'es', language: 'es', name: 'España', aliases: ['spain', 'españa', 'espana', 'es', 'esp', '西班牙'] },
  { iso2: 'nl', language: 'nl', name: 'Nederland', aliases: ['netherlands', 'nederland', 'holland', 'nl', 'nld', '荷兰'] },
  { iso2: 'pl', language: 'pl', name: 'Polska', aliases: ['poland', 'polska', 'pl', 'pol', '波兰'] },
  { iso2: 'cn', language: 'zh', name: '中国', aliases: ['china', 'cn', 'chn', '中国'] },
  { iso2: 'my', language: 'ms', name: 'Malaysia', aliases: ['malaysia', 'my', 'mys', '马来西亚'] },
  { iso2: 'id', language: 'id', name: 'Indonesia', aliases: ['indonesia', 'id', 'idn', '印度尼西亚', '印尼'] },
  { iso2: 'vn', language: 'vi', name: 'Việt Nam', aliases: ['vietnam', 'viet nam', 'việt nam', 'vn', 'vnm', '越南'] },
  { iso2: 'th', language: 'th', name: 'ประเทศไทย', aliases: ['thailand', 'th', 'tha', '泰国'] },
  { iso2: 'jp', language: 'ja', name: '日本', aliases: ['japan', 'jp', 'jpn', '日本'] },
  { iso2: 'kr', language: 'ko', name: '대한민국', aliases: ['south korea', 'korea', 'kr', 'kor', '韩国', '南韩'] },
  { iso2: 'pt', language: 'pt', name: 'Portugal', aliases: ['portugal', 'pt', 'prt', '葡萄牙'] },
  { iso2: 'tr', language: 'tr', name: 'Türkiye', aliases: ['turkey', 'türkiye', 'turkiye', 'tr', 'tur', '土耳其'] },
  { iso2: 'gb', language: 'en', name: 'United Kingdom', aliases: ['united kingdom', 'uk', 'gb', 'gbr', 'great britain', '英国'] },
  { iso2: 'us', language: 'en', name: 'United States', aliases: ['united states', 'usa', 'us', 'america', '美国'] },
]);

/** Han, kana and Hangul：zh/ja/ko 的检索串由这些文字构成，其余支持的语言一律剔除。 */
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_SCRIPT = /\p{Script=Han}/u;
const KANA_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_SCRIPT = /\p{Script=Hangul}/u;

/** 词是否属于目标语言的检索文字（P2 §2.3：zh/ja/ko 保留本地文字并剥离纯拉丁词，其余语言剔除 CJK）。 */
function termFitsLanguage(term: string, language: SearchLanguage): boolean {
  switch (language) {
    case 'zh':
      return HAN_SCRIPT.test(term);
    case 'ja':
      return HAN_SCRIPT.test(term) || KANA_SCRIPT.test(term);
    case 'ko':
      return HANGUL_SCRIPT.test(term);
    default:
      return !CJK_SCRIPT.test(term);
  }
}

/**
 * A trailing "(…)" or "（…）" qualifier, as in 「瑞士（德语区优先）」. The body
 * excludes every bracket, which keeps the match linear on any input.
 */
const MARKET_QUALIFIER = /[（(][^（()）]*[）)]\s*$/u;

/** Region names (lower case) that imply a country when no country filter is given. */
const REGION_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
  'baden-württemberg': 'de', 'baden-wuerttemberg': 'de', bayern: 'de', bavaria: 'de',
  berlin: 'de', brandenburg: 'de', bremen: 'de', hamburg: 'de', hessen: 'de', hesse: 'de',
  'mecklenburg-vorpommern': 'de', niedersachsen: 'de', 'lower saxony': 'de',
  'nordrhein-westfalen': 'de', 'north rhine-westphalia': 'de', nrw: 'de',
  'rheinland-pfalz': 'de', 'rhineland-palatinate': 'de', saarland: 'de', sachsen: 'de',
  saxony: 'de', 'sachsen-anhalt': 'de', 'saxony-anhalt': 'de', 'schleswig-holstein': 'de',
  thüringen: 'de', thueringen: 'de', thuringia: 'de',
  wien: 'at', vienna: 'at', niederösterreich: 'at', oberösterreich: 'at', salzburg: 'at',
  steiermark: 'at', styria: 'at', tirol: 'at', tyrol: 'at', kärnten: 'at', vorarlberg: 'at',
  burgenland: 'at',
  '珠三角': 'cn', '长三角': 'cn', '京津冀': 'cn', '粤港澳': 'cn', '粤港澳大湾区': 'cn', '大湾区': 'cn',
  '环渤海': 'cn', '华东': 'cn', '华南': 'cn', '华北': 'cn', '华中': 'cn', '西南': 'cn', '西北': 'cn', '东北': 'cn',
});

/** Two-letter TLDs that are routinely used as generic brands, not as a country. */
const GENERIC_CCTLDS: ReadonlySet<string> = new Set(['io', 'co', 'ai', 'me', 'tv', 'eu', 'cc', 'biz']);

const DISTRIBUTOR_PATTERN =
  /distribut|wholesal|dealer|import|reseller|\btrad(?:er|ing)\b|gro(?:ß|ss)hand|h(?:ä|ae)ndler|vertrieb|经销|分销|进口|批发|代理|grossiste|distributeur|distributore|grossista|distribuidor|mayorista|groothandel|hurtown|dystrybut/iu;
const MANUFACTURER_PATTERN =
  /manufactur|\boem\b|hersteller|produzent|fabrik|制造|生产|工厂|厂家|fabricant|produttore|fabricante|fabrikant|producent/iu;

const ROLE_TERMS: Readonly<Record<TradeRole, Readonly<Record<SearchLanguage, readonly string[]>>>> = Object.freeze({
  distributor: {
    de: ['Großhandel', 'Händler', 'Vertrieb'],
    en: ['distributor', 'wholesaler', 'dealer'],
    fr: ['distributeur', 'grossiste', 'revendeur'],
    it: ['distributore', 'grossista', 'rivenditore'],
    es: ['distribuidor', 'mayorista', 'proveedor'],
    nl: ['groothandel', 'distributeur', 'dealer'],
    pl: ['hurtownia', 'dystrybutor', 'sprzedaż'],
    zh: ['经销商', '分销商', '批发商', '进口商'],
    ms: ['pemborong', 'peniaga', 'pengedar'],
    id: ['distributor', 'grosir', 'penyalur'],
    vi: ['nhà phân phối', 'đại lý', 'bán buôn'],
    th: ['ผู้จัดจำหน่าย', 'ตัวแทนจำหน่าย', 'ค้าส่ง'],
    ja: ['販売代理店', '卸売業者', 'ディーラー'],
    ko: ['유통업체', '도매업체', '대리점'],
    pt: ['distribuidor', 'atacadista', 'revendedor'],
    tr: ['distribütör', 'toptancı', 'bayi'],
  },
  manufacturer: {
    de: ['Hersteller'],
    en: ['manufacturer'],
    fr: ['fabricant'],
    it: ['produttore'],
    es: ['fabricante'],
    nl: ['fabrikant'],
    pl: ['producent'],
    zh: ['制造商', '厂家', '工厂'],
    ms: ['pengeluar', 'pembuat'],
    id: ['produsen', 'pabrikan'],
    vi: ['nhà sản xuất'],
    th: ['ผู้ผลิต'],
    ja: ['製造業者', 'メーカー'],
    ko: ['제조업체', '제조사'],
    pt: ['fabricante'],
    tr: ['üretici'],
  },
});

export const MAX_SEARCHES_PER_QUERY = MAX_PUBLIC_WEB_SEARCHES_PER_QUERY;

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** Lower-case alpha-2 codes of a multi-country market such as "DACH" (de, at, ch); undefined for any other term. */
function marketRegionCodes(term: string): string[] | undefined {
  return lookupMarketRegion(term)?.map((code) => code.toLowerCase());
}

function targetCountries(filters: Record<string, unknown>): CountryEntry[] {
  const values = [...strings(filters.country), ...strings(filters.iso_country), ...strings(filters.buyer_country)]
    .flatMap((v) => v.split(/[,/;、，；]/u))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const found: CountryEntry[] = [];
  const add = (entry: CountryEntry | undefined): void => {
    if (entry && !found.includes(entry)) found.push(entry);
  };
  const byCode = (iso2: string | undefined): CountryEntry | undefined => COUNTRIES.find((c) => c.iso2 === iso2);
  for (const value of values) {
    const members = marketRegionCodes(value);
    if (members) members.forEach((iso2) => add(byCode(iso2)));
    // 国家字段里也可能写区域名（「珠三角」「Bayern」）——与国家别名同等对待。
    else add(COUNTRIES.find((c) => c.aliases.includes(value)) ?? byCode(REGION_COUNTRY[value]));
  }
  if (found.length) return found;
  // Region-only plans ("industry + country OR region") imply their country, or each country of a "DACH" region.
  for (const region of strings(filters.region).map((v) => v.trim().toLowerCase())) {
    for (const iso2 of marketRegionCodes(region) ?? [REGION_COUNTRY[region]]) add(byCode(iso2));
  }
  return found;
}

export function searchLanguageFor(query: { filters?: Record<string, unknown> }): SearchLanguage {
  return targetCountries(query.filters ?? {})[0]?.language ?? 'en';
}

/**
 * 把词分成「目标语言可用」与「被剥离」两组（P2 §2.3）：被剥离的词要留痕——它们说明规划器
 * 给的市场语言与关键词语言不一致。未指定语言时按旧行为只看「是否含 CJK」。
 */
export function partitionSearchTerms(
  terms: readonly string[],
  language?: SearchLanguage,
): { usable: string[]; stripped: string[] } {
  const usable: string[] = [];
  const stripped: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    if (language === undefined ? !CJK_SCRIPT.test(term) : termFitsLanguage(term, language)) {
      usable.push(term);
    } else {
      stripped.push(term);
    }
  }
  return { usable, stripped };
}

/** Trimmed, non-empty terms a search in the given language can use. */
export function searchableTerms(terms: readonly string[], language?: SearchLanguage): string[] {
  return partitionSearchTerms(terms, language).usable;
}

/** The first target country as its own language writes it; undefined when unknown. */
export function searchCountryName(query: { filters?: Record<string, unknown> }): string | undefined {
  return targetCountries(query.filters ?? {})[0]?.name;
}

/** Search languages of ICP target markets such as 「德国」 or "Germany (Bavaria)", in first-seen order. */
export function searchLanguagesForMarkets(markets: unknown): SearchLanguage[] {
  const country = strings(markets).map((market) => market.replace(MARKET_QUALIFIER, ''));
  return [...new Set(targetCountries({ country }).map((entry) => entry.language))];
}

/** Target countries as lower-case ISO-3166 alpha-2 codes; empty when unknown. */
export function targetCountryCodes(query: { filters?: Record<string, unknown> }): readonly string[] {
  return targetCountries(query.filters ?? {}).map((c) => c.iso2);
}

/** Target-country ccTLDs; empty when the target country is unknown. */
export function targetCountryTlds(query: { filters?: Record<string, unknown> }): ReadonlySet<string> {
  return new Set(targetCountries(query.filters ?? {}).map((c) => c.iso2 === 'gb' ? 'uk' : c.iso2));
}

/** True when the domain carries another country's ccTLD than the target countries. */
export function isForeignCountryDomain(domain: string, targets: ReadonlySet<string>): boolean {
  if (targets.size === 0) return false;
  const tld = domain.toLowerCase().split('.').pop() ?? '';
  return tld.length === 2 && !GENERIC_CCTLDS.has(tld) && !targets.has(tld);
}

export function tradeRoleFor(query: { filters?: Record<string, unknown> }): TradeRole | null {
  const filters = query.filters ?? {};
  const text = [
    ...strings(filters.trade_side),
    ...strings(filters.business_model),
    ...strings(filters.establishment_type),
  ].join(' ');
  const distributorAt = text.search(DISTRIBUTOR_PATTERN);
  const manufacturerAt = text.search(MANUFACTURER_PATTERN);
  if (distributorAt < 0 && manufacturerAt < 0) return null;
  if (manufacturerAt < 0) return 'distributor';
  if (distributorAt < 0) return 'manufacturer';
  // Both vocabularies present ("manufacturer that imports …"): the role named first wins.
  return distributorAt < manufacturerAt ? 'distributor' : 'manufacturer';
}

export function tradeRoleTerms(role: TradeRole | null, language: SearchLanguage): readonly string[] {
  return role ? ROLE_TERMS[role][language] : [];
}
