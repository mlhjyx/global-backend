/**
 * Search localization for keyword discovery (G3 spec 2026-09-24 §4.3):
 * search language follows the ICP target country, and query strings follow
 * the ICP trade role instead of a hard-coded "manufacturer company" suffix.
 * Pure functions over the query-plan filters; no I/O.
 */

export type SearchLanguage = 'de' | 'en' | 'fr' | 'it' | 'es' | 'nl' | 'pl';
export type TradeRole = 'distributor' | 'manufacturer';

type CountryEntry = Readonly<{ iso2: string; language: SearchLanguage; aliases: readonly string[] }>;

const COUNTRIES: readonly CountryEntry[] = Object.freeze([
  { iso2: 'de', language: 'de', aliases: ['germany', 'deutschland', 'de', 'deu', '德国'] },
  { iso2: 'at', language: 'de', aliases: ['austria', 'österreich', 'oesterreich', 'at', 'aut', '奥地利'] },
  { iso2: 'ch', language: 'de', aliases: ['switzerland', 'schweiz', 'suisse', 'ch', 'che', '瑞士'] },
  { iso2: 'fr', language: 'fr', aliases: ['france', 'fr', 'fra', '法国'] },
  { iso2: 'it', language: 'it', aliases: ['italy', 'italia', 'it', 'ita', '意大利'] },
  { iso2: 'es', language: 'es', aliases: ['spain', 'españa', 'espana', 'es', 'esp', '西班牙'] },
  { iso2: 'nl', language: 'nl', aliases: ['netherlands', 'nederland', 'holland', 'nl', 'nld', '荷兰'] },
  { iso2: 'pl', language: 'pl', aliases: ['poland', 'polska', 'pl', 'pol', '波兰'] },
  { iso2: 'gb', language: 'en', aliases: ['united kingdom', 'uk', 'gb', 'gbr', 'great britain', '英国'] },
  { iso2: 'us', language: 'en', aliases: ['united states', 'usa', 'us', 'america', '美国'] },
]);

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
  },
  manufacturer: {
    de: ['Hersteller'],
    en: ['manufacturer'],
    fr: ['fabricant'],
    it: ['produttore'],
    es: ['fabricante'],
    nl: ['fabrikant'],
    pl: ['producent'],
  },
});

export const MAX_SEARCHES_PER_QUERY = 3;

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

function targetCountries(filters: Record<string, unknown>): CountryEntry[] {
  const values = [...strings(filters.country), ...strings(filters.iso_country), ...strings(filters.buyer_country)]
    .flatMap((v) => v.split(/[,/;]/u))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const found: CountryEntry[] = [];
  for (const value of values) {
    const entry = COUNTRIES.find((c) => c.aliases.includes(value));
    if (entry && !found.includes(entry)) found.push(entry);
  }
  if (found.length) return found;
  // Region-only plans ("industry + country OR region") imply their country.
  for (const region of strings(filters.region).map((v) => v.trim().toLowerCase())) {
    const iso2 = REGION_COUNTRY[region];
    const entry = COUNTRIES.find((c) => c.iso2 === iso2);
    if (entry && !found.includes(entry)) found.push(entry);
  }
  return found;
}

export function searchLanguageFor(query: { filters?: Record<string, unknown> }): SearchLanguage {
  return targetCountries(query.filters ?? {})[0]?.language ?? 'en';
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
