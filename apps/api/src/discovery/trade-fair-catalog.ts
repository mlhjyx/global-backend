/**
 * 全球垂直展会目录种子（L0 召回种子库 + 合规直抓名录，共 20 个真实展会）：
 *  - 恢复自归档 `global_dev_source_channels.json` 的 16 个全球多行业真实展会
 *    （排除 E2E smoke 测试项）；
 *  - 新增 4 个光伏/储能旗舰展（Intersolar Europe / KEY Energy Rimini / RE+ / Intersolar South America），
 *    支撑 Gate 1 试点（琏升科技 HJT 电池与组件）及全球新能源获客。
 *
 * 合规审核门禁（2026-11-27 逐站实测）：
 *  - 通用抽取为主（`crawl4ai.fetch` 渲染 + 翻页 + `discovery.extract_list` 模型抽取，PDF 走 Docling）；
 *  - robots 允许（`robotsPolicy === 'A'`）+ 明确 `license` / `tosUrl` + 有效 `https` 展商网址即 `enabled`；
 *  - robots 禁止、ToS 明确禁止抓取、或 WAF/CAPTCHA 阻断的站点标 `blocked`（绝不绕过反爬/验证码，
 *    仅保留 L0 搜索引擎公开参展索引召回）；
 *  - 仅采集公开公司事实（公司名/官网/国家/行业），不采集个人数据。
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
  readonly crawlDelayMs?: number;
  readonly platform?: string;
  readonly estimatedExhibitors?: number;
  readonly note?: string;
}

/**
 * 判断展会目录是否满足合规直抓门禁（robots A + 明确 license/tosUrl + 有效 https 展商网址 + enabled）。
 * 专用 CSS 选择器或平台级适配器（如 RX Algolia）仅作可选提速优化，不再是启用硬门禁。
 */
export function isTradeFairDirectlyCrawlable(fair: TradeFairCatalogEntry): boolean {
  if (fair.status !== 'enabled' || fair.robotsPolicy !== 'A') return false;
  if (!fair.license?.trim() || !fair.tosUrl?.trim()) return false;
  try {
    const exhibitor = new URL(fair.exhibitorUrl);
    const tos = new URL(fair.tosUrl);
    if (
      exhibitor.protocol !== 'https:' ||
      !exhibitor.hostname ||
      exhibitor.username ||
      exhibitor.password ||
      exhibitor.hash
    ) {
      return false;
    }
    return tos.protocol === 'https:' && Boolean(tos.hostname);
  } catch {
    return false;
  }
}

export const TRADE_FAIR_CATALOG: readonly TradeFairCatalogEntry[] = Object.freeze([
  // ── 4 个光伏 / 储能旗舰展（Batch 1.2-B 新增） ───────────────────────────
  {
    slug: 'intersolar-europe',
    name: 'Intersolar Europe',
    exhibitorUrl: 'https://www.intersolar.de/exhibitorlist',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Solar Promotion / FWTM public exhibitor list — company facts reuse, no bulk republication',
    tosUrl: 'https://www.intersolar.de/legal-notice',
    platform: 'smarter-e-frontend',
    estimatedExhibitors: 1400,
    note: '全球最大欧洲光伏展（慕尼黑，The smarter E Frontend 通用渲染抽取）；robots 允许 /exhibitorlist，Legal Notice 无禁爬条款',
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
    status: 'blocked',
    platform: 'ieg-cloudfront',
    estimatedExhibitors: 1000,
    note: 'CloudFront 403 Request blocked（含 robots.txt 亦返 403，不绕过 WAF）；保留 L0 搜索引擎公开参展索引召回',
  },
  {
    slug: 're-plus-north-america',
    name: 'RE+ (SPI & ESI North America)',
    exhibitorUrl: 'https://re26.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm?featured=false',
    region: 'North America',
    country: 'United States',
    countryIso: 'US',
    industry: '光伏/储能/氢能/微电网',
    organizer: 'SEIA / SEPA',
    topics: [
      'solar', 'photovoltaic', 'pv', 'hjt', 'solar module', 'utility solar',
      'commercial solar', 'epc', 'bess', 'energy storage', '光伏', '储能',
    ],
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'RE+ (SEIA / SEPA) public MapYourShow exhibitor gallery — company facts reuse, no bulk republication',
    tosUrl: 'https://www.re-plus.com/privacy-policy/',
    platform: 'mapyourshow',
    estimatedExhibitors: 1300,
    note: '北美最大清洁能源展（Map Your Show 8.0 公开名录页，通用渲染抽取）；robots 允许 /8_0/explore/*（严守不碰 /8_0/ajax 与 /8_0/cfc）',
  },
  {
    slug: 'intersolar-south-america',
    name: 'Intersolar South America',
    exhibitorUrl: 'https://www.intersolar.net.br/exhibitorlist',
    region: 'South America',
    country: 'Brazil',
    countryIso: 'BR',
    industry: '光伏/分布式电站/储能',
    organizer: 'Solar Promotion International / Aranda',
    topics: [
      'solar', 'photovoltaic', 'energia solar', 'fotovoltaica', 'pv', 'hjt',
      'solar module', 'distribuidor solar', 'epc', 'bess', '光伏', '拉美光伏',
    ],
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Solar Promotion International public exhibitor list — company facts reuse, no bulk republication',
    tosUrl: 'https://www.intersolar.net.br/legal-notice',
    platform: 'smarter-e-frontend',
    estimatedExhibitors: 600,
    note: '拉美最大光伏展（圣保罗，The smarter E Frontend 通用渲染抽取）；robots 允许 /exhibitorlist，Legal Notice 无禁爬条款',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Autopromotec public exhibitor catalogue — company facts reuse, no bulk republication',
    tosUrl: 'https://www.autopromotec.com/en/credits.php',
    platform: 'custom-php',
    note: '自研 PHP 目录，robots Allow: /，公开可读（通用抓取抽取）',
  },
  {
    slug: 'cfia-rennes-2027',
    name: 'CFIA Rennes 2027',
    exhibitorUrl: 'https://www.rennes.cfiaexpo.com/en/exhibitors',
    region: 'Europe',
    country: 'France',
    countryIso: 'FR',
    industry: '农食工业供应',
    organizer: 'GL Events',
    topics: ['food processing', 'packaging', 'agrofood', 'food equipment', '农食工业', '食品加工'],
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'GL events CFIA Rennes public exhibitor directory — company facts reuse, no bulk republication',
    tosUrl: 'https://www.rennes.cfiaexpo.com/en/content/mentions-legales',
    platform: 'inwink',
    estimatedExhibitors: 965,
    note: 'GL Events Inwink SPA，robots Allow: /，child-sitemap-exhibitordetail-en 确认 965 家公开参展商（通用渲染抽取）',
  },
  {
    slug: 'chinaplas-2027',
    name: 'CHINAPLAS 2027',
    exhibitorUrl: 'https://www.chinaplasonline.com/eMarketplace/AllExhibitors/eng',
    region: 'Asia',
    country: 'China',
    countryIso: 'CN',
    industry: '塑料/橡胶',
    organizer: 'Adsale (CMP)',
    topics: ['plastics', 'rubber', 'injection molding', 'extrusion', 'polymer', '塑料', '橡胶'],
    status: 'blocked',
    platform: 'adsale-waf',
    note: '展商目录页触发阿里云 WAF 滑块验证码反爬（CF_APP_WAF / waf-nc-h5-mask），绝不绕过；保留 L0 搜索引擎公开参展索引召回',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Tüyap Expomed Eurasia public exhibitor directory — company facts reuse, no bulk republication',
    tosUrl: 'https://expomedistanbul.com/en/privacy-statement',
    platform: 'tuyap-ssr',
    estimatedExhibitors: 700,
    note: 'Tüyap 分页服务端渲染（?page=N），robots Allow: /，通用抓取 + 翻页抽取',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'FESPA Brasil public exhibitor directory — company facts reuse, no bulk republication',
    tosUrl: 'https://www.fespa.com/en/terms-and-conditions/',
    platform: 'static-ssr',
    estimatedExhibitors: 92,
    note: '静态 SSR 名录（div.expositor_item_details 实测 92+ 家含名字/展位/官网），robots 全放行',
  },
  {
    slug: 'gulfood-manufacturing-2026',
    name: 'Gulfood Manufacturing 2026',
    exhibitorUrl: 'https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitors',
    region: 'Middle East',
    country: 'United Arab Emirates',
    countryIso: 'AE',
    industry: '食品饮料制造',
    organizer: 'DWTC/Informa',
    topics: ['food manufacturing', 'beverage', 'processing', 'packaging', '食品饮料'],
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'inD Events / DWTC public exhibitor directory — company facts reuse, no bulk republication',
    tosUrl: 'https://gulfoodmanufacturing.com/terms-conditions/',
    platform: 'xporience',
    estimatedExhibitors: 1399,
    note: 'Xporience 公开名录（实测 1399 家，无 robots 限制，通用渲染 + 翻页抽取）',
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
    platform: 'informa-cloudflare',
    estimatedExhibitors: 300,
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Messe Frankfurt Middle East public exhibitor directory — company facts reuse, no bulk republication',
    tosUrl: 'https://ae.messefrankfurt.com/dubai/en/terms-conditions.html',
    platform: 'messe-frankfurt-aem',
    note: 'Messe Frankfurt AEM SPA；robots 允许 HTML 展商检索页（不直接抓 /*.json$），通用渲染抽取',
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
    platform: 'informa-cloudflare',
    estimatedExhibitors: 450,
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
    status: 'blocked',
    tosUrl: 'https://legal.rxglobal.com/en-gb/WebsiteTC.html',
    platform: 'rx-japan',
    estimatedExhibitors: 1709,
    note: 'RX Global WebsiteTC §8 明确禁止爬虫/自动抓取与系统性目录采集（实测 1709 家但不违规直抓，仅保留 L0 搜索引擎公开索引）',
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
    status: 'blocked',
    tosUrl: 'https://www.informamarkets.com/terms-of-use',
    platform: 'informa-cphi',
    note: 'exhibitors.cphi.com/robots.txt 明确 Disallow: / 禁抓；保留 L0 搜索引擎公开参展索引召回',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Promaplast PLAST 2026 public exhibitor list — company facts reuse, no bulk republication',
    tosUrl: 'https://plastonline.org/en/privacy-policy/',
    platform: 'wordpress-ssr',
    estimatedExhibitors: 1669,
    note: '静态 SSR 名录（a.exhibitor 实测 1669 家含公司名与官网），robots 允许',
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
    status: 'blocked',
    tosUrl: 'https://legal.rxglobal.com/en-gb/WebsiteTC.html',
    platform: 'rx-japan',
    estimatedExhibitors: 382,
    note: 'RX Global WebsiteTC §8 明确禁止爬虫/自动抓取与系统性目录采集（实测 382 家但不违规直抓，仅保留 L0 搜索引擎公开索引）',
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
    platform: 'informa-asp',
    estimatedExhibitors: 1500,
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'IFEMA Madrid public exhibitor catalogue — company facts reuse, no bulk republication',
    tosUrl: 'https://www.ifema.es/en/legal-notice',
    platform: 'ifema-spa',
    note: 'IFEMA SPA，robots 允许目录页，Legal Notice 明确免费匿名查阅展会目录（通用渲染抽取，仅采公司事实）',
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
    status: 'enabled',
    robotsPolicy: 'A',
    license: 'Easyfairs public exhibitor directory — company facts reuse, no bulk republication (Crawl-delay 10s)',
    tosUrl: 'https://www.easyfairs.com/general-terms-conditions/',
    crawlDelayMs: 10_000,
    platform: 'easyfairs-algolia-ssr',
    estimatedExhibitors: 544,
    note: 'Easyfairs Algolia InstantSearch SSR（实测 544 家），robots 允许 /en/exhibitors/ 且声明 Crawl-delay: 10',
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
