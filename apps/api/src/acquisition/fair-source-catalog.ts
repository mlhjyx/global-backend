/**
 * 展会参展商目录源目录（跨国 × 跨行业，研究产出，非硬编码运行数据）。
 * 由 acq-source-atlas 工作流跨 10 个行业簇 × WebSearch/WebFetch 确认得到：40 可达 / 30 可用 / 12 国。
 * 作用：铺源的真相源——按 `status` 决定「零代码直接接」还是「需新平台适配器」。
 *
 * status:
 *  - 'algolia'       现有 TradeFairSourceAdapter 直接可接；只需逆向该届 {indexName,eventEditionId}
 *                    （RX 全球共用同一 Algolia app XD0U5M6Y4R + 同一 search-only key）。
 *                    逆向：scripts/discover-fair-algolia.mjs <exhibitorUrl>
 *  - 'mapyourshow'   现有 MapYourShowSourceAdapter 直接可接；只需 host=<show>.mapyourshow.com。
 *                    （未来届的名录可能尚未放出 → fetch 返回 0，fail-safe）
 *  - 'needs_adapter' 需为该平台新写适配器（Adsale/Xporience/GL Events/Informa/经典ASP/自研 SPA…）。
 *  - 'blocked'       Cloudflare/反爬，纯 HTTP 被 403；需浏览器渲染（crawl4ai browser）绕过。
 *
 * ⚠️ 合规：接入前按 trade-fair-intelligence.md §0 数据分级；个人数据默认隔离 + LIA。
 */
export type FairAdapterStatus = 'algolia' | 'mapyourshow' | 'needs_adapter' | 'blocked';

export interface FairSourceCandidate {
  name: string;
  country: string;
  region: string;
  industry: string;
  organizer: string;
  status: FairAdapterStatus;
  exhibitorUrl: string;
  note?: string;
}

export const FAIR_SOURCE_CATALOG: FairSourceCandidate[] = [
  // ── 已接入并实测（seeded）──
  { name: 'EuroBLECH 2026', country: 'Germany', region: 'Europe', industry: '钣金/金属加工', organizer: 'RX (Mack Brooks)', status: 'algolia', exhibitorUrl: 'https://www.euroblech.com/en-gb/exhibitor-directory.html', note: 'SEEDED · 911 家' },
  { name: 'INTERPHEX 2026', country: 'United States', region: 'North America', industry: '制药/生物制造', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.interphex.com/en-us/show-info/exhibitor-list.html', note: 'SEEDED · 602 家 · 参展商来自 12+ 国' },
  { name: 'EATS 2025 (ex-PROCESS EXPO)', country: 'United States', region: 'North America', industry: '食品饮料加工', organizer: 'Messe Frankfurt', status: 'mapyourshow', exhibitorUrl: 'https://eats25.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm', note: 'SEEDED · 321 家 · host=eats25.mapyourshow.com' },

  // ── 零代码可接：RX/Algolia（跨国/跨行业，只需逆向 index/edition）──
  { name: 'Fastener Fair USA 2026', country: 'United States', region: 'North America', industry: '紧固件/汽车工业', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.fastenerfairusa.com/en-us/exhibitor-list.html' },
  { name: 'ICE Europe 2027', country: 'Germany', region: 'Europe', industry: '薄膜/纸/箔转换机械', organizer: 'RX (Mack Brooks)', status: 'algolia', exhibitorUrl: 'https://www.ice-x.com/en-gb/exhibitor-list.html' },
  { name: 'in-cosmetics Asia 2026', country: 'Thailand', region: 'Asia', industry: '化妆品原料/代工', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.in-cosmetics.com/asia/en-gb/exhibitor-directory.html', note: 'looksLikeDirectory=true · ~2255 家' },
  { name: 'in-cosmetics Latin America 2026', country: 'Brazil', region: 'Latin America', industry: '化妆品原料/代工', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.in-cosmetics.com/latin-america/en-gb/exhibitor-directory.html' },
  { name: 'ISC West 2026', country: 'United States', region: 'North America', industry: '安防/门禁/视频监控', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.discoverisc.com/west/en-us/exhibitors/exhibitor-directory.html' },
  { name: 'World Future Energy Summit 2027', country: 'United Arab Emirates', region: 'Middle East', industry: '光伏/储能/清洁能源', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.worldfutureenergysummit.com/en-gb/exhibitor-directory.html' },
  { name: 'All-Energy Australia 2026', country: 'Australia', region: 'APAC', industry: '光伏/风/储能/EV', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.all-energy.com.au/en-gb/exhibitor-directory.html' },
  { name: 'All-Energy UK 2027', country: 'United Kingdom', region: 'Europe', industry: '可再生/低碳能源', organizer: 'RX', status: 'algolia', exhibitorUrl: 'https://www.all-energy.co.uk/en-gb/exhibitor-directory.html', note: 'HTML 内含 algolia apiKey' },

  // ── 零代码可接：MapYourShow（多为北美制造业，只需 host）──
  { name: 'RE+ 2026 (SPI/ESI)', country: 'United States', region: 'North America', industry: '光伏/储能', organizer: 'SEIA+SEPA', status: 'mapyourshow', exhibitorUrl: 'https://re26.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm' },
  { name: 'IPC APEX EXPO 2027', country: 'United States', region: 'North America', industry: '电子/PCB 制造', organizer: 'IPC', status: 'mapyourshow', exhibitorUrl: 'https://apexexpo26.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm' },
  { name: 'PACK EXPO International 2026', country: 'United States', region: 'North America', industry: '包装/加工机械', organizer: 'PMMI', status: 'mapyourshow', exhibitorUrl: 'https://packexpo26.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm', note: '未来届，名录未满可能返回 0' },
  { name: 'NPE2027: The Plastics Show', country: 'United States', region: 'North America', industry: '塑料/橡胶', organizer: 'PLASTICS Assoc.', status: 'mapyourshow', exhibitorUrl: 'https://npe2027.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm', note: '未来届（2027），名录未满' },

  // ── 需新平台适配器 ──
  { name: 'ProPak Asia 2026', country: 'Thailand', region: 'Asia', industry: '食品/饮料/制药加工包装', organizer: 'Informa', status: 'needs_adapter', exhibitorUrl: 'https://www.propakasia.com/ppka/2026/en/list_participants.asp', note: '经典 .asp 服务端渲染，800+ 家，可直抓（items-per-page=All）——最易的新适配器' },
  { name: 'CHINAPLAS 2027', country: 'China', region: 'Asia', industry: '塑料/橡胶', organizer: 'Adsale (CMP)', status: 'needs_adapter', exhibitorUrl: 'https://www.chinaplasonline.com/cps/exhibitor/list/eng', note: 'Adsale SPA，需 headless 或后端 JSON' },
  { name: 'PLAST 2026', country: 'Italy', region: 'Europe', industry: '塑料/橡胶机械', organizer: 'Promaplast', status: 'needs_adapter', exhibitorUrl: 'https://plastonline.org/en/exhibitors/list-of-exhibitors/', note: '静态 A-Z 500+ 家，可走名录列表抽取' },
  { name: 'FESPA Brasil 2027', country: 'Brazil', region: 'South America', industry: '数字/宽幅印刷', organizer: 'FESPA', status: 'needs_adapter', exhibitorUrl: 'https://www.fespabrasil.com.br/en/evento/empresas', note: '静态 A-Z 300+ 家（名字+展馆+展位+官网）' },
  { name: 'NEPCON JAPAN', country: 'Japan', region: 'Asia', industry: '电子/PCB/SMT', organizer: 'RX Japan', status: 'needs_adapter', exhibitorUrl: 'https://www.nepconjapan.jp/tokyo/en-gb/search/2026/ex-list.html', note: 'RX Japan 自研站（非 Algolia），ex-list.html 静态字母列表' },
  { name: 'PLASTIC JAPAN (Material Week) Osaka', country: 'Japan', region: 'Asia', industry: '塑料/高功能材料', organizer: 'RX Japan', status: 'needs_adapter', exhibitorUrl: 'https://www.material-expo.jp/osaka/en-gb/search/2026/ex-list.html', note: '同 RX Japan 自研站；伞展合并名单需按展区过滤' },
  { name: 'Pharmapack Europe 2026', country: 'France', region: 'Europe', industry: '药品包装/给药器械', organizer: 'Informa (CPHI)', status: 'needs_adapter', exhibitorUrl: 'https://exhibitors.cphi.com/ppfr26/', note: 'Informa CPHI 目录平台（多展复用）' },
  { name: 'Gulfood Manufacturing 2026', country: 'United Arab Emirates', region: 'Middle East', industry: '食品饮料制造', organizer: 'DWTC/Informa', status: 'needs_adapter', exhibitorUrl: 'https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitor', note: 'Xporience/Informa SPA' },
  { name: 'CFIA Rennes 2027', country: 'France', region: 'Europe', industry: '农食工业供应', organizer: 'GL Events', status: 'needs_adapter', exhibitorUrl: 'https://rennes.cfiaexpo.com/en/exhibitors-list', note: 'GL Events SPA' },
  { name: 'Expomed Eurasia', country: 'Turkey', region: 'Eurasia', industry: '医疗器械', organizer: 'Tüyap', status: 'needs_adapter', exhibitorUrl: 'https://expomedistanbul.com/en/exhibitor-list', note: '分页服务端渲染，47 页' },
  { name: 'Southern Manufacturing & Electronics (SE27)', country: 'United Kingdom', region: 'Europe', industry: '制造/电子', organizer: 'Easyfairs', status: 'needs_adapter', exhibitorUrl: 'https://www.southern-manufacturing-electronics.com/en/exhibitors/', note: 'Easyfairs 站，467 家，A-Z+品类+国家筛选' },
  { name: 'Autopromotec Bologna', country: 'Italy', region: 'Europe', industry: '汽车后市场装备', organizer: 'Promotec', status: 'needs_adapter', exhibitorUrl: 'https://www.autopromotec.com/en/catalogo/index.php?S=CAT_INDEX', note: '自研 PHP 目录，需提交筛选取结果' },
  { name: 'Intersec Dubai 2026', country: 'United Arab Emirates', region: 'Middle East', industry: '安防/消防', organizer: 'Messe Frankfurt', status: 'needs_adapter', exhibitorUrl: 'https://intersecglobal.ae.messefrankfurt.com/dubai/en/exhibitor-search.html', note: 'Messe Frankfurt 自研搜索 SPA' },
  { name: 'SICUR', country: 'Spain', region: 'Europe', industry: '安防/消防', organizer: 'IFEMA Madrid', status: 'needs_adapter', exhibitorUrl: 'https://www.ifema.es/en/sicur/exhibitors/catalogue', note: 'IFEMA SPA，API 驱动' },

  // ── 被反爬阻断（需浏览器渲染绕过）──
  { name: 'LOUPE Americas 2026 (ex-Labelexpo)', country: 'United States', region: 'North America', industry: '标签/包装印刷', organizer: 'Informa', status: 'blocked', exhibitorUrl: 'https://www.loupe-americas.com/exhibitor-list', note: 'Cloudflare 403；450+ 家' },
  { name: 'Gulf Print & Pack 2026', country: 'United Arab Emirates', region: 'Middle East', industry: '印刷/包装', organizer: 'Informa', status: 'blocked', exhibitorUrl: 'https://www.gulfprintpack.com/exhibitor-list', note: 'Cloudflare 403；300+ 家' },
];

/** 现有两个适配器零代码即可接入的候选（algolia + mapyourshow）。 */
export function zeroCodeCandidates(): FairSourceCandidate[] {
  return FAIR_SOURCE_CATALOG.filter((f) => f.status === 'algolia' || f.status === 'mapyourshow');
}
