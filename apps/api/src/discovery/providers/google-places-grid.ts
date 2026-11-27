/**
 * Google Maps Places API「目标国重点城市 × 行业类目」多语种网格规划器（纯函数，无 I/O）。
 *
 * 重点覆盖光伏安装商（PV installer）、光伏 EPC 工程商、电气/光伏分销批发商三类核心通道，
 * 同时兼容非光伏通用行业 ICP（回退到目标国重点城市 × 本地化关键词/行业词）。
 */
import { MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY } from '../execution-envelope';
import type { CompanyDiscoveryQuery } from '../provider-contract';
import {
  searchLanguageFor,
  searchableTerms,
  targetCountryCodes,
  tradeRoleFor,
  tradeRoleTerms,
  type SearchLanguage,
} from '../search-localization';

export type SolarChannelCategory = 'pv_installer' | 'solar_epc' | 'electrical_distributor';

export interface GooglePlacesGridQuery {
  readonly textQuery: string;
  readonly city?: string;
  readonly category: string;
  readonly regionCode?: string;
  readonly languageCode: string;
}

/** 目标国重点工业/新能源与电气分销枢纽城市（按本地惯用拼写）。 */
export const GOOGLE_PLACES_KEY_CITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  DE: Object.freeze(['München', 'Frankfurt', 'Stuttgart', 'Hamburg', 'Köln', 'Düsseldorf']),
  IT: Object.freeze(['Milano', 'Bologna', 'Torino', 'Verona', 'Roma', 'Brescia']),
  ES: Object.freeze(['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Bilbao', 'Zaragoza']),
  FR: Object.freeze(['Lyon', 'Paris', 'Toulouse', 'Marseille', 'Nantes', 'Bordeaux']),
  NL: Object.freeze(['Rotterdam', 'Eindhoven', 'Amsterdam', 'Utrecht', 'Tilburg']),
  BE: Object.freeze(['Antwerpen', 'Brussel', 'Gent', 'Leuven']),
  AT: Object.freeze(['Wien', 'Graz', 'Linz', 'Salzburg']),
  CH: Object.freeze(['Zürich', 'Basel', 'Bern', 'Genève']),
  PL: Object.freeze(['Warszawa', 'Kraków', 'Wrocław', 'Poznań', 'Gdańsk']),
  GB: Object.freeze(['Birmingham', 'London', 'Manchester', 'Bristol', 'Leeds']),
  PT: Object.freeze(['Lisboa', 'Porto', 'Braga', 'Coimbra']),
  CZ: Object.freeze(['Praha', 'Brno', 'Ostrava']),
  GR: Object.freeze(['Athens', 'Thessaloniki', 'Patras']),
  RO: Object.freeze(['București', 'Cluj-Napoca', 'Timișoara']),
  SE: Object.freeze(['Stockholm', 'Göteborg', 'Malmö']),
  DK: Object.freeze(['København', 'Aarhus', 'Odense']),
  US: Object.freeze(['Houston', 'Los Angeles', 'Phoenix', 'Dallas', 'Miami', 'Austin']),
  CA: Object.freeze(['Toronto', 'Calgary', 'Vancouver', 'Montréal']),
  AU: Object.freeze(['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide']),
  BR: Object.freeze(['São Paulo', 'Campinas', 'Curitiba', 'Belo Horizonte', 'Recife']),
  MX: Object.freeze(['Monterrey', 'Ciudad de México', 'Guadalajara', 'Querétaro']),
  CL: Object.freeze(['Santiago', 'Antofagasta', 'Concepción']),
  AE: Object.freeze(['Dubai', 'Abu Dhabi', 'Sharjah']),
  SA: Object.freeze(['Riyadh', 'Jeddah', 'Dammam']),
  ZA: Object.freeze(['Johannesburg', 'Cape Town', 'Durban']),
  TR: Object.freeze(['İstanbul', 'İzmir', 'Ankara', 'Bursa']),
  JP: Object.freeze(['Tokyo', 'Osaka', 'Nagoya', 'Fukuoka']),
  KR: Object.freeze(['Seoul', 'Busan', 'Daegu', 'Incheon']),
  IN: Object.freeze(['Mumbai', 'Bengaluru', 'Ahmedabad', 'Pune', 'Hyderabad']),
  MY: Object.freeze(['Kuala Lumpur', 'Penang', 'Johor Bahru']),
  ID: Object.freeze(['Jakarta', 'Surabaya', 'Bandung']),
  VN: Object.freeze(['Ho Chi Minh City', 'Hanoi', 'Da Nang']),
  TH: Object.freeze(['Bangkok', 'Chonburi', 'Chiang Mai']),
  SG: Object.freeze(['Singapore']),
});

const SOLAR_CATEGORY_TERMS: Readonly<
  Record<SearchLanguage, Readonly<Record<SolarChannelCategory, string>>>
> = Object.freeze({
  de: Object.freeze({
    pv_installer: 'Photovoltaik Installateur',
    solar_epc: 'Photovoltaik EPC Projektentwicklung',
    electrical_distributor: 'Elektrogroßhandel Photovoltaik',
  }),
  it: Object.freeze({
    pv_installer: 'installatore fotovoltaico',
    solar_epc: 'EPC fotovoltaico impianti solari',
    electrical_distributor: 'grossista materiale elettrico fotovoltaico',
  }),
  es: Object.freeze({
    pv_installer: 'instalador solar fotovoltaico',
    solar_epc: 'EPC solar fotovoltaica',
    electrical_distributor: 'distribuidor material eléctrico fotovoltaico',
  }),
  fr: Object.freeze({
    pv_installer: 'installateur photovoltaïque',
    solar_epc: 'EPC photovoltaïque solaire',
    electrical_distributor: 'grossiste matériel électrique photovoltaïque',
  }),
  nl: Object.freeze({
    pv_installer: 'zonnepanelen installateur',
    solar_epc: 'solar EPC zonne-energie',
    electrical_distributor: 'elektrotechnische groothandel zonnepanelen',
  }),
  pl: Object.freeze({
    pv_installer: 'instalator fotowoltaiki',
    solar_epc: 'wykonawca EPC fotowoltaika',
    electrical_distributor: 'hurtownia elektryczna fotowoltaika',
  }),
  en: Object.freeze({
    pv_installer: 'solar panel installer',
    solar_epc: 'solar EPC contractor',
    electrical_distributor: 'electrical solar distributor wholesaler',
  }),
  pt: Object.freeze({
    pv_installer: 'instalador energia solar fotovoltaica',
    solar_epc: 'engenharia EPC energia solar',
    electrical_distributor: 'distribuidor material elétrico solar',
  }),
  tr: Object.freeze({
    pv_installer: 'güneş enerjisi kurulum firması',
    solar_epc: 'güneş enerjisi EPC mühendislik',
    electrical_distributor: 'elektrik malzeme toptancısı solar',
  }),
  ja: Object.freeze({
    pv_installer: '太陽光発電 施工会社',
    solar_epc: '太陽光発電 EPC 事業者',
    electrical_distributor: '電設資材 卸売 太陽光',
  }),
  ko: Object.freeze({
    pv_installer: '태양광 설치 시공업체',
    solar_epc: '태양광 EPC 시공사',
    electrical_distributor: '전기 자재 도매 태양광',
  }),
  ar: Object.freeze({
    pv_installer: 'solar energy installer',
    solar_epc: 'solar EPC contractor',
    electrical_distributor: 'electrical solar distributor',
  }),
  zh: Object.freeze({
    pv_installer: '光伏安装商',
    solar_epc: '光伏EPC工程总包',
    electrical_distributor: '电气批发 光伏分销商',
  }),
  ms: Object.freeze({
    pv_installer: 'pemasang panel solar',
    solar_epc: 'kontraktor EPC solar',
    electrical_distributor: 'pengedar elektrik solar',
  }),
  id: Object.freeze({
    pv_installer: 'kontraktor instalasi panel surya',
    solar_epc: 'EPC PLTS solar',
    electrical_distributor: 'distributor listrik panel surya',
  }),
  vi: Object.freeze({
    pv_installer: 'lắp đặt điện mặt trời',
    solar_epc: 'tổng thầu EPC điện mặt trời',
    electrical_distributor: 'phân phối thiết bị điện mặt trời',
  }),
  th: Object.freeze({
    pv_installer: 'รับติดตั้งโซล่าเซลล์',
    solar_epc: 'ผู้รับเหมา EPC โซล่าเซลล์',
    electrical_distributor: 'ตัวแทนจำหน่ายอุปกรณ์ไฟฟ้า โซล่าเซลล์',
  }),
});

/** 永远不是 B2B 企业官网的平台/社媒/地图/黄页/商城域名，Places 候选命中这些域名一律丢弃。 */
const NON_COMPANY_DOMAINS: ReadonlySet<string> = new Set([
  'google.com', 'goo.gl', 'maps.app.goo.gl', 'maps.google.com', 'business.site', 'sites.google.com',
  'facebook.com', 'fb.com', 'm.facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 'reddit.com', 'xing.com', 'whatsapp.com',
  'wa.me', 't.me', 'linktr.ee', 'bio.link',
  'wikipedia.org', 'wikidata.org', 'yelp.com', 'trustpilot.com', 'tripadvisor.com',
  'yellowpages.com', 'paginegialle.it', 'gelbeseiten.de', 'dasoertliche.de', '11880.com',
  'wlw.de', 'wlw.com', 'kompass.com', 'europages.com', 'europages.de', 'europages.it',
  'europages.fr', 'europages.es', 'europages.co.uk', 'thomasnet.com', 'crunchbase.com',
  'amazon.com', 'amazon.de', 'amazon.it', 'amazon.fr', 'amazon.es', 'amazon.co.uk',
  'ebay.com', 'ebay.de', 'ebay.it', 'alibaba.com', '1688.com', 'aliexpress.com',
  'made-in-china.com', 'globalsources.com', 'indiamart.com', 'mercadolibre.com',
  'glassdoor.com', 'indeed.com', 'stepstone.de', 'kununu.com',
]);

const SOLAR_SIGNAL_RE =
  /solar|photovolta|fotovolta|zonnepanel|zonne-energ|fotowolta|pv[\s-]|hjt|topcon|bess|inverter|wechs?elrichter|solaranlag|solarteur|energie\s+solaire|güneş\s+enerj|太陽光|태양광|光伏|太阳能|逆变器|储能|组件/iu;
const ELECTRICAL_SIGNAL_RE =
  /electr|elektro|elettric|eléctric|électri|elektrycz|switchgear|电气|电工|配电|低压/iu;
const INSTALLER_SIGNAL_RE =
  /installat|install|montag|solarteur|施工|安装|설치|lắp\s+đặt|ติดตั้ง|kurulum/iu;
const EPC_SIGNAL_RE = /\bepc\b|工程总包|总包|turnkey|projektentwickl|contratista|wykonawc/iu;
const DISTRIBUTOR_SIGNAL_RE =
  /distribut|wholesal|grosshand|großhand|groothand|grossist|hurtown|mayorist|分销|经销|批发|代理|도매|卸売/iu;

export function isGooglePlacesNonCompanyDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^www\./u, '');
  if (!normalized) return true;
  if (NON_COMPANY_DOMAINS.has(normalized)) return true;
  for (const blocked of NON_COMPANY_DOMAINS) {
    if (normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/** 根据目标国代码与显式 filters.cities / city / area_name 选出重点城市列表。 */
export function selectGooglePlacesKeyCities(
  countryIso2: string | undefined,
  filters: Record<string, unknown> = {},
  maxCities = 3,
): string[] {
  const explicit = [
    ...stringList(filters.cities),
    ...stringList(filters.city),
    ...stringList(filters.area_name),
  ].flatMap((entry) =>
    entry
      .split(/[,/;、，；]/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 1),
  );
  const seen = new Set<string>();
  const picked: string[] = [];
  const push = (city: string): void => {
    const key = city.toLowerCase();
    if (seen.has(key) || picked.length >= maxCities) return;
    seen.add(key);
    picked.push(city);
  };
  for (const city of explicit) push(city);
  const iso = countryIso2?.trim().toUpperCase();
  if (iso && Object.hasOwn(GOOGLE_PLACES_KEY_CITIES, iso)) {
    for (const city of GOOGLE_PLACES_KEY_CITIES[iso]!) push(city);
  }
  return picked;
}

/** 识别查询是否命中光伏/电气渠道场景，并按意图排序三类核心渠道词。 */
export function detectSolarChannelCategories(
  query: Pick<CompanyDiscoveryQuery, 'keywords' | 'filters'>,
): SolarChannelCategory[] {
  const filters = query.filters ?? {};
  const corpus = [
    ...(query.keywords ?? []),
    ...stringList(filters.industry),
    ...stringList(filters.sub_industry),
    ...stringList(filters.product),
    ...stringList(filters.trade_side),
    ...stringList(filters.business_model),
  ].join(' ');
  const isSolar = SOLAR_SIGNAL_RE.test(corpus);
  const isElectrical = ELECTRICAL_SIGNAL_RE.test(corpus);
  if (!isSolar && !isElectrical) return [];

  const ordered: SolarChannelCategory[] = [];
  const add = (cat: SolarChannelCategory): void => {
    if (!ordered.includes(cat)) ordered.push(cat);
  };
  if (DISTRIBUTOR_SIGNAL_RE.test(corpus)) add('electrical_distributor');
  if (EPC_SIGNAL_RE.test(corpus)) add('solar_epc');
  if (INSTALLER_SIGNAL_RE.test(corpus)) add('pv_installer');
  if (isSolar) {
    add('pv_installer');
    add('solar_epc');
    add('electrical_distributor');
  } else {
    add('electrical_distributor');
    add('solar_epc');
    add('pv_installer');
  }
  return ordered;
}

/**
 * 为 coverageFill 生成 google_places 的目标国重点城市与多语种类目关键词。
 * 供 plan-query-sources.ts 在模型未排 google_places 查询时按 ICP 目标市场确定性补齐。
 */
export function resolveGooglePlacesCoverageFill(input: {
  readonly countryIso2: string | undefined;
  readonly industry: string | undefined;
  readonly tradeSide: string | null;
  readonly borrowedKeywords: readonly string[];
}): Readonly<{ cities: readonly string[]; keywords: readonly string[] }> {
  const iso = input.countryIso2?.trim().toUpperCase();
  const cities = selectGooglePlacesKeyCities(iso, {}, MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY);
  const language = searchLanguageFor({ filters: iso ? { country: iso } : {} });
  const categories = detectSolarChannelCategories({
    keywords: [...input.borrowedKeywords],
    filters: {
      ...(input.industry ? { industry: input.industry } : {}),
      ...(input.tradeSide ? { trade_side: input.tradeSide } : {}),
    },
  });
  if (categories.length > 0) {
    const vocab = SOLAR_CATEGORY_TERMS[language] ?? SOLAR_CATEGORY_TERMS.en;
    return {
      cities,
      keywords: categories.map((category) => vocab[category]),
    };
  }
  return { cities, keywords: [...input.borrowedKeywords] };
}

function localizedBaseCategoryTerms(
  query: Pick<CompanyDiscoveryQuery, 'keywords' | 'filters'>,
  language: SearchLanguage,
): string[] {
  const filters = query.filters ?? {};
  const solarCategories = detectSolarChannelCategories(query);
  if (solarCategories.length > 0) {
    const vocab = SOLAR_CATEGORY_TERMS[language] ?? SOLAR_CATEGORY_TERMS.en;
    return solarCategories.map((category) => vocab[category]);
  }
  const usable = searchableTerms(
    [
      ...(query.keywords ?? []),
      ...stringList(filters.industry),
      ...stringList(filters.sub_industry),
      ...stringList(filters.product),
    ],
    language,
  );
  const roleTerm = tradeRoleTerms(tradeRoleFor(query), language)[0];
  const deduped: string[] = [];
  for (const raw of usable) {
    const candidate =
      roleTerm && !raw.toLowerCase().includes(roleTerm.toLowerCase())
        ? `${raw} ${roleTerm}`
        : raw;
    if (!deduped.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) {
      deduped.push(candidate);
    }
    if (deduped.length >= 3) break;
  }
  return deduped;
}

/**
 * 构建有界的「重点城市 × 行业类目」Places 文本查询网格，单次查询严格不超过 maxQueries 条。
 *
 * 配对策略（最大化覆盖不同城市与不同类目）：
 *   第 i 条查询配 `(cities[i % cities.length], categories[i % categories.length])`，
 *   当只有 1 城多类目或 1 类目多城时自动展开不同组合；无城市映射时保留类目词并带 regionCode。
 */
export function buildGooglePlacesDiscoveryQueries(
  query: Pick<CompanyDiscoveryQuery, 'keywords' | 'filters'>,
  maxQueries: number = MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY,
): GooglePlacesGridQuery[] {
  const cap = Math.min(
    MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY,
    Math.max(0, Math.trunc(maxQueries)),
  );
  if (cap < 1) return [];

  const filters = query.filters ?? {};
  const language = searchLanguageFor(query);
  const countryIso = targetCountryCodes(query)[0]?.toUpperCase();
  const categories = localizedBaseCategoryTerms(query, language);
  if (categories.length === 0) return [];

  const cities = selectGooglePlacesKeyCities(countryIso, filters, cap);
  const out: GooglePlacesGridQuery[] = [];
  const seenText = new Set<string>();

  const pushQuery = (category: string, city?: string): void => {
    if (out.length >= cap) return;
    const textQuery = (
      city && !category.toLowerCase().includes(city.toLowerCase())
        ? `${category} ${city}`
        : category
    )
      .trim()
      .slice(0, 300);
    const key = textQuery.toLowerCase();
    if (!textQuery || seenText.has(key)) return;
    seenText.add(key);
    out.push({
      textQuery,
      ...(city ? { city } : {}),
      category,
      ...(countryIso ? { regionCode: countryIso } : {}),
      languageCode: language,
    });
  };

  if (cities.length === 0) {
    for (const category of categories) pushQuery(category);
    return out;
  }

  // 第一轮按对角线配对，让单次 3 条预算同时覆盖 3 个重点城市 + 3 个行业类目（如安装商/EPC/电气分销）。
  const diagonalCount = Math.max(cities.length, categories.length);
  for (let i = 0; i < diagonalCount && out.length < cap; i += 1) {
    pushQuery(categories[i % categories.length]!, cities[i % cities.length]!);
  }
  // 仍有余量时补充笛卡尔积其余组合。
  for (const city of cities) {
    for (const category of categories) {
      if (out.length >= cap) break;
      pushQuery(category, city);
    }
  }
  return out;
}
