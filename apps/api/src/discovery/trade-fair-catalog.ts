/**
 * 全球垂直展会目录种子（L0 召回种子库，共 20 个真实展会）：
 *  - 恢复自归档 `global_dev_source_channels.json` 的 16 个全球多行业真实展会
 *    （排除 E2E smoke 测试项）；
 *  - 新增 4 个光伏/储能旗舰展（Intersolar Europe / KEY Energy Rimini / RE+ / Intersolar South America），
 *    支撑 Gate 1 试点（琏升科技 HJT 电池与组件）及全球新能源获客。
 *
 * 与 `trade-fairs.ts`（RX Algolia 专用执行模板，绑定 `tradefair.algolia` 预算包络）保持解耦：
 * 本目录既用于 source_channel 种子同步，也用于 L0 搜索引擎按展会名录召回参展商（不绕过 Cloudflare）。
 */

export interface TradeFairCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly exhibitorUrl: string;
  readonly region: string;
  readonly country: string;
  readonly countryIso: string;
  readonly industry: string;
  readonly organizer: string;
  readonly topics: readonly string[];
  readonly status: 'enabled' | 'needs_adapter' | 'blocked';
  readonly robotsPolicy?: 'A' | 'B';
  readonly license?: string;
  readonly tosUrl?: string;
  readonly note?: string;
}

export const TRADE_FAIR_CATALOG: readonly TradeFairCatalogEntry[] = Object.freeze([
  // ── 4 个光伏 / 储能旗舰展（Batch 1.2-B 新增） ───────────────────────────
  {
    slug: 'intersolar-europe',
    name: 'Intersolar Europe',
    exhibitorUrl: 'https://www.intersolar.de/exhibitor-list',
    region: 'Europe',
    country: 'Germany',
    countryIso: 'DE',
    industry: '光伏/储能/逆变器/EPC',
    organizer: 'Solar Promotion / FWTM',
    topics: [
      'solar', 'photovoltaic', 'pv', 'hjt', 'topcon', 'solar module', 'solar cell',
      'bipv', 'epc', 'inverter', 'energy storage', 'bess', 'renewable energy',
      '光伏', '太阳能', '异质结', '储能',
    ],
    status: 'needs_adapter',
    note: '全球最大欧洲光伏展（慕尼黑），覆盖德国/意大利/西班牙/荷兰/波兰 EPC 与分销商',
  },
  {
    slug: 'key-energy-rimini',
    name: 'KEY - The Energy Transition Expo (Rimini)',
    exhibitorUrl: 'https://www.key-expo.com/exhibitors-catalogue',
    region: 'Europe',
    country: 'Italy',
    countryIso: 'IT',
    industry: '光伏/能源转型/工商业储能',
    organizer: 'Italian Exhibition Group (IEG)',
    topics: [
      'solar', 'photovoltaic', 'fotovoltaico', 'pv', 'hjt', 'energy transition',
      'epc', 'solar module', 'bess', 'renewable energy', '光伏', '意大利光伏',
    ],
    status: 'needs_adapter',
    note: '意大利里米尼能源转型与光伏旗舰展，高密度意大利/南欧工商业 EPC 与批发商',
  },
  {
    slug: 're-plus-north-america',
    name: 'RE+ (SPI & ESI North America)',
    exhibitorUrl: 'https://www.re-plus.com/exhibitor-list/',
    region: 'North America',
    country: 'United States',
    countryIso: 'US',
    industry: '光伏/储能/氢能/微电网',
    organizer: 'SEIA / SEPA',
    topics: [
      'solar', 'photovoltaic', 'pv', 'hjt', 'solar module', 'utility solar',
      'commercial solar', 'epc', 'bess', 'energy storage', '光伏', '储能',
    ],
    status: 'needs_adapter',
    note: '北美最大清洁能源展，覆盖美国/加拿大/墨西哥工商业与地面电站开发商及分销商',
  },
  {
    slug: 'intersolar-south-america',
    name: 'Intersolar South America',
    exhibitorUrl: 'https://www.intersolar.net.br/exhibitor-list',
    region: 'South America',
    country: 'Brazil',
    countryIso: 'BR',
    industry: '光伏/分布式电站/储能',
    organizer: 'Solar Promotion International / Aranda',
    topics: [
      'solar', 'photovoltaic', 'energia solar', 'fotovoltaica', 'pv', 'hjt',
      'solar module', 'distribuidor solar', 'epc', 'bess', '光伏', '拉美光伏',
    ],
    status: 'needs_adapter',
    note: '拉美最大光伏展（圣保罗），覆盖巴西/智利/哥伦比亚/墨西哥分布式光伏分销商与集成商',
  },

  // ── 16 个归档全球多行业真实展会（恢复自 phase0-pre-20261124） ───────────
  {
    slug: 'autopromotec-bologna',
    name: 'Autopromotec Bologna',
    exhibitorUrl: 'https://www.autopromotec.com/en/catalogo/index.php?S=CAT_INDEX',
    region: 'Europe',
    country: 'Italy',
    countryIso: 'IT',
    industry: '汽车后市场装备',
    organizer: 'Promotec',
    topics: ['automotive', 'aftermarket', 'garage equipment', 'tire', 'auto parts', '汽车后市场'],
    status: 'needs_adapter',
    note: '自研 PHP 目录，需提交筛选取结果',
  },
  {
    slug: 'cfia-rennes-2027',
    name: 'CFIA Rennes 2027',
    exhibitorUrl: 'https://rennes.cfiaexpo.com/en/exhibitors-list',
    region: 'Europe',
    country: 'France',
    countryIso: 'FR',
    industry: '农食工业供应',
    organizer: 'GL Events',
    topics: ['food processing', 'packaging', 'agrofood', 'food equipment', '农食工业', '食品加工'],
    status: 'needs_adapter',
    note: 'GL Events SPA',
  },
  {
    slug: 'chinaplas-2027',
    name: 'CHINAPLAS 2027',
    exhibitorUrl: 'https://www.chinaplasonline.com/cps/exhibitor/list/eng',
    region: 'Asia',
    country: 'China',
    countryIso: 'CN',
    industry: '塑料/橡胶',
    organizer: 'Adsale (CMP)',
    topics: ['plastics', 'rubber', 'injection molding', 'extrusion', 'polymer', '塑料', '橡胶'],
    status: 'needs_adapter',
    note: 'Adsale SPA，需 headless 或后端 JSON',
  },
  {
    slug: 'expomed-eurasia',
    name: 'Expomed Eurasia',
    exhibitorUrl: 'https://expomedistanbul.com/en/exhibitor-list',
    region: 'Eurasia',
    country: 'Turkey',
    countryIso: 'TR',
    industry: '医疗器械',
    organizer: 'Tüyap',
    topics: ['medical device', 'healthcare', 'hospital equipment', 'diagnostics', '医疗器械'],
    status: 'needs_adapter',
    note: '分页服务端渲染，47 页',
  },
  {
    slug: 'fespa-brasil-2027',
    name: 'FESPA Brasil 2027',
    exhibitorUrl: 'https://www.fespabrasil.com.br/en/evento/empresas',
    region: 'South America',
    country: 'Brazil',
    countryIso: 'BR',
    industry: '数字/宽幅印刷',
    organizer: 'FESPA',
    topics: ['digital printing', 'wide format printing', 'signage', 'textile printing', '印刷'],
    status: 'needs_adapter',
    note: '静态 A-Z 300+ 家（名字+展馆+展位+官网）',
  },
  {
    slug: 'gulfood-manufacturing-2026',
    name: 'Gulfood Manufacturing 2026',
    exhibitorUrl: 'https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitor',
    region: 'Middle East',
    country: 'United Arab Emirates',
    countryIso: 'AE',
    industry: '食品饮料制造',
    organizer: 'DWTC/Informa',
    topics: ['food manufacturing', 'beverage', 'processing', 'packaging', '食品饮料'],
    status: 'needs_adapter',
    note: 'Xporience/Informa SPA',
  },
  {
    slug: 'gulf-print-pack-2026',
    name: 'Gulf Print & Pack 2026',
    exhibitorUrl: 'https://www.gulfprintpack.com/exhibitor-list',
    region: 'Middle East',
    country: 'United Arab Emirates',
    countryIso: 'AE',
    industry: '印刷/包装',
    organizer: 'Informa',
    topics: ['printing', 'packaging', 'label', 'corrugated', '印刷', '包装'],
    status: 'blocked',
    note: 'Cloudflare 403；300+ 家（通过 L0 搜索引擎查公开参展索引）',
  },
  {
    slug: 'intersec-dubai-2026',
    name: 'Intersec Dubai 2026',
    exhibitorUrl: 'https://intersecglobal.ae.messefrankfurt.com/dubai/en/exhibitor-search.html',
    region: 'Middle East',
    country: 'United Arab Emirates',
    countryIso: 'AE',
    industry: '安防/消防',
    organizer: 'Messe Frankfurt',
    topics: ['security', 'fire safety', 'surveillance', 'access control', '安防', '消防'],
    status: 'needs_adapter',
    note: 'Messe Frankfurt 自研搜索 SPA',
  },
  {
    slug: 'loupe-americas-2026',
    name: 'LOUPE Americas 2026 (ex-Labelexpo)',
    exhibitorUrl: 'https://www.loupe-americas.com/exhibitor-list',
    region: 'North America',
    country: 'United States',
    countryIso: 'US',
    industry: '标签/包装印刷',
    organizer: 'Informa',
    topics: ['label', 'labelexpo', 'package printing', 'flexo', '标签', '包装印刷'],
    status: 'blocked',
    note: 'Cloudflare 403；450+ 家（通过 L0 搜索引擎查公开参展索引）',
  },
  {
    slug: 'nepcon-japan',
    name: 'NEPCON JAPAN',
    exhibitorUrl: 'https://www.nepconjapan.jp/tokyo/en-gb/search/2026/ex-list.html',
    region: 'Asia',
    country: 'Japan',
    countryIso: 'JP',
    industry: '电子/PCB/SMT',
    organizer: 'RX Japan',
    topics: ['electronics', 'pcb', 'smt', 'semiconductor', 'ems', '电子制造'],
    status: 'needs_adapter',
    note: 'RX Japan 自研站（非 Algolia），ex-list.html 静态字母列表',
  },
  {
    slug: 'pharmapack-europe-2026',
    name: 'Pharmapack Europe 2026',
    exhibitorUrl: 'https://exhibitors.cphi.com/ppfr26/',
    region: 'Europe',
    country: 'France',
    countryIso: 'FR',
    industry: '药品包装/给药器械',
    organizer: 'Informa (CPHI)',
    topics: ['pharma packaging', 'drug delivery', 'pharmaceutical', 'medical packaging', '药品包装'],
    status: 'needs_adapter',
    note: 'Informa CPHI 目录平台（多展复用）',
  },
  {
    slug: 'plast-2026',
    name: 'PLAST 2026',
    exhibitorUrl: 'https://plastonline.org/en/exhibitors/list-of-exhibitors/',
    region: 'Europe',
    country: 'Italy',
    countryIso: 'IT',
    industry: '塑料/橡胶机械',
    organizer: 'Promaplast',
    topics: ['plastics machinery', 'rubber machinery', 'extrusion', 'molding', '塑料机械'],
    status: 'needs_adapter',
    note: '静态 A-Z 500+ 家，可走名录列表抽取',
  },
  {
    slug: 'plastic-japan-osaka',
    name: 'PLASTIC JAPAN (Material Week) Osaka',
    exhibitorUrl: 'https://www.material-expo.jp/osaka/en-gb/search/2026/ex-list.html',
    region: 'Asia',
    country: 'Japan',
    countryIso: 'JP',
    industry: '塑料/高功能材料',
    organizer: 'RX Japan',
    topics: ['plastics', 'functional materials', 'composite', 'polymer', '高功能材料'],
    status: 'needs_adapter',
    note: 'RX Japan 自研站；伞展合并名单需按展区过滤',
  },
  {
    slug: 'propak-asia-2026',
    name: 'ProPak Asia 2026',
    exhibitorUrl: 'https://www.propakasia.com/ppka/2026/en/list_participants.asp',
    region: 'Asia',
    country: 'Thailand',
    countryIso: 'TH',
    industry: '食品/饮料/制药加工包装',
    organizer: 'Informa',
    topics: ['packaging', 'food processing', 'beverage', 'pharma processing', '加工包装'],
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Informa Markets public exhibitor directory — facts reuse, no bulk republication',
    tosUrl: 'https://www.informamarkets.com/terms-of-use',
    note: '经典 .asp 服务端渲染；条目 div.ex-body（公司名 .company），约 1500+ 家',
  },
  {
    slug: 'sicur-madrid',
    name: 'SICUR',
    exhibitorUrl: 'https://www.ifema.es/en/sicur/exhibitors/catalogue',
    region: 'Europe',
    country: 'Spain',
    countryIso: 'ES',
    industry: '安防/消防',
    organizer: 'IFEMA Madrid',
    topics: ['security', 'fire safety', 'emergency', 'occupational safety', '安防', '消防'],
    status: 'needs_adapter',
    note: 'IFEMA SPA，API 驱动',
  },
  {
    slug: 'southern-manufacturing-electronics-se27',
    name: 'Southern Manufacturing & Electronics (SE27)',
    exhibitorUrl: 'https://www.southern-manufacturing-electronics.com/en/exhibitors/',
    region: 'Europe',
    country: 'United Kingdom',
    countryIso: 'GB',
    industry: '制造/电子',
    organizer: 'Easyfairs',
    topics: ['manufacturing', 'electronics', 'machinery', 'subcontracting', '工业制造', '电子'],
    status: 'needs_adapter',
    note: 'Easyfairs 站，467 家，A-Z+品类+国家筛选',
  },
]);

export interface SelectCatalogFairsInput {
  industryTerms?: readonly string[];
  keywords?: readonly string[];
  countries?: readonly string[];
  regions?: readonly string[];
}

/** 按行业/关键词（可选国家/区域排序优先）筛选匹配的全球展会目录种子。 */
export function selectCatalogFairs(
  input: SelectCatalogFairsInput,
): readonly TradeFairCatalogEntry[] {
  const needles = [...(input.industryTerms ?? []), ...(input.keywords ?? [])]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2);
  if (needles.length === 0) return [];
  const countrySet = new Set(
    (input.countries ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean),
  );
  const regionSet = new Set(
    (input.regions ?? []).map((region) => region.trim().toLowerCase()).filter(Boolean),
  );

  const matched = TRADE_FAIR_CATALOG.filter((fair) =>
    fair.topics.some((topic) =>
      needles.some((needle) => needle.includes(topic) || topic.includes(needle)),
    ),
  );

  return matched.sort((left, right) => {
    const leftCountry = countrySet.has(left.countryIso) ? 1 : 0;
    const rightCountry = countrySet.has(right.countryIso) ? 1 : 0;
    if (leftCountry !== rightCountry) return rightCountry - leftCountry;
    const leftRegion = regionSet.has(left.region.toLowerCase()) ? 1 : 0;
    const rightRegion = regionSet.has(right.region.toLowerCase()) ? 1 : 0;
    if (leftRegion !== rightRegion) return rightRegion - leftRegion;
    return left.slug.localeCompare(right.slug);
  });
}

/**
 * 为指定展会构造 L0 公开搜索召回词（不绕过 Cloudflare，直接借搜索引擎索引定位参展商官网）。
 */
export function buildTradeFairSearchQueries(
  fair: TradeFairCatalogEntry,
  keywords: readonly string[],
  limit = 2,
): string[] {
  const cleanKeywords = keywords
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 2);
  const primary = cleanKeywords[0] ?? fair.topics[0] ?? '';
  const queries: string[] = [];
  if (primary) {
    queries.push(`"${fair.name}" exhibitor ${primary}`);
  }
  try {
    const host = new URL(fair.exhibitorUrl).hostname.replace(/^www\./u, '');
    if (host && primary) {
      queries.push(`site:${host} ${primary}`);
    }
  } catch {
    // 忽略异常 URL
  }
  return queries.slice(0, Math.max(1, limit));
}
