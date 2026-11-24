/**
 * 规范词表归一层（评测 + 架构评审的头号欠账）。
 * ICP 规则/查询计划里的行业、国家词（中/英/德混杂）→ 各结构化源的规范标识：
 * - Wikidata QID（industry P452 / country P17）
 * - OSM 标签（craft/industrial/landuse）
 * - 国家 ISO code
 *
 * 这是一份**种子表**（金属加工/制造域为主），覆盖 TRUMPF 场景与常见词。
 * 后续可从 ICP 生成时用 LLM 补全并沉淀（一次性映射，不在热路径调模型）。
 * 有了它，中文 ICP 也能驱动 Wikidata/OSM 结构化发现，不再需要手工塞英文计划。
 */

import { PHOTOVOLTAIC_TERMS } from './isic-seed';

/** 行业词（归一为小写）→ Wikidata industry QID。 */
export const INDUSTRY_QIDS: Record<string, string> = {
  // 金属加工 / 制造
  制造业: 'Q187939',
  manufacturing: 'Q187939',
  金属加工: 'Q19541171',
  'metal fabrication': 'Q19541171',
  metalworking: 'Q19541171',
  机械制造: 'Q1957908',
  'mechanical engineering': 'Q1957908',
  机床: 'Q1957908',
  'machine tool': 'Q1957908',
  'machine tools': 'Q1957908',
  汽车: 'Q190117',
  automotive: 'Q190117',
  'automotive industry': 'Q190117',
  汽车零部件: 'Q190117',
  航空航天: 'Q765633',
  aerospace: 'Q765633',
  半导体: 'Q2986369',
  semiconductor: 'Q2986369',
  电子: 'Q11650',
  electronics: 'Q11650',
  新能源: 'Q12705122',
  'renewable energy': 'Q12705122',
  钢铁: 'Q2285982',
  steel: 'Q2285982',
  'steel industry': 'Q2285982',
  // Verified word-level PV identity; shared ISIC 279 itself is intentionally unbound.
  ...Object.fromEntries(PHOTOVOLTAIC_TERMS.map((term) => [term, 'Q192127'])),
  工业品分销: 'Q220695',
  工业分销商: 'Q220695',
  机械设备批发: 'Q220695',
  wholesale: 'Q220695',
  'industrial distributor': 'Q220695',
  'industrial distributors': 'Q220695',
  'machinery distributor': 'Q220695',
  'machinery wholesale': 'Q220695',
};

/** 国家/地区词（归一为小写）→ Wikidata country QID。 */
export const COUNTRY_QIDS: Record<string, string> = {
  德国: 'Q183',
  germany: 'Q183',
  deutschland: 'Q183',
  美国: 'Q30',
  usa: 'Q30',
  'united states': 'Q30',
  us: 'Q30',
  中国: 'Q148',
  china: 'Q148',
  日本: 'Q17',
  japan: 'Q17',
  韩国: 'Q884',
  'south korea': 'Q884',
  意大利: 'Q38',
  italy: 'Q38',
  法国: 'Q142',
  france: 'Q142',
  英国: 'Q145',
  uk: 'Q145',
  'united kingdom': 'Q145',
  印度: 'Q668',
  india: 'Q668',
  奥地利: 'Q40',
  austria: 'Q40',
  österreich: 'Q40',
  oesterreich: 'Q40',
  瑞士: 'Q39',
  switzerland: 'Q39',
  schweiz: 'Q39',
  suisse: 'Q39',
  svizzera: 'Q39',
  荷兰: 'Q55',
  netherlands: 'Q55',
  nederland: 'Q55',
  holland: 'Q55',
  波兰: 'Q36',
  poland: 'Q36',
  polska: 'Q36',
  西班牙: 'Q29',
  spain: 'Q29',
  españa: 'Q29',
  espana: 'Q29',
  葡萄牙: 'Q45',
  portugal: 'Q45',
  比利时: 'Q31',
  belgium: 'Q31',
  belgië: 'Q31',
  belgique: 'Q31',
  瑞典: 'Q34',
  sweden: 'Q34',
  sverige: 'Q34',
  挪威: 'Q20',
  norway: 'Q20',
  norge: 'Q20',
  丹麦: 'Q35',
  denmark: 'Q35',
  danmark: 'Q35',
  芬兰: 'Q33',
  finland: 'Q33',
  suomi: 'Q33',
  爱尔兰: 'Q27',
  ireland: 'Q27',
  捷克: 'Q213',
  czechia: 'Q213',
  'czech republic': 'Q213',
  匈牙利: 'Q28',
  hungary: 'Q28',
  罗马尼亚: 'Q218',
  romania: 'Q218',
  希腊: 'Q41',
  greece: 'Q41',
  土耳其: 'Q43',
  turkey: 'Q43',
  türkiye: 'Q43',
  turkiye: 'Q43',
  阿联酋: 'Q878',
  阿拉伯联合酋长国: 'Q878',
  uae: 'Q878',
  'united arab emirates': 'Q878',
  沙特: 'Q851',
  沙特阿拉伯: 'Q851',
  'saudi arabia': 'Q851',
  卡塔尔: 'Q846',
  qatar: 'Q846',
  阿曼: 'Q842',
  oman: 'Q842',
  科威特: 'Q817',
  kuwait: 'Q817',
  埃及: 'Q79',
  egypt: 'Q79',
  摩洛哥: 'Q1028',
  morocco: 'Q1028',
  以色列: 'Q801',
  israel: 'Q801',
  南非: 'Q258',
  'south africa': 'Q258',
  巴西: 'Q155',
  brazil: 'Q155',
  brasil: 'Q155',
  墨西哥: 'Q96',
  mexico: 'Q96',
  méxico: 'Q96',
  智利: 'Q298',
  chile: 'Q298',
  哥伦比亚: 'Q739',
  colombia: 'Q739',
  阿根廷: 'Q414',
  argentina: 'Q414',
  秘鲁: 'Q419',
  peru: 'Q419',
  perú: 'Q419',
  加拿大: 'Q16',
  canada: 'Q16',
  澳大利亚: 'Q408',
  australia: 'Q408',
  新西兰: 'Q664',
  'new zealand': 'Q664',
  新加坡: 'Q334',
  singapore: 'Q334',
  马来西亚: 'Q833',
  malaysia: 'Q833',
  印度尼西亚: 'Q252',
  印尼: 'Q252',
  indonesia: 'Q252',
  越南: 'Q881',
  vietnam: 'Q881',
  'viet nam': 'Q881',
  泰国: 'Q869',
  thailand: 'Q869',
  菲律宾: 'Q928',
  philippines: 'Q928',
  俄罗斯: 'Q159',
  russia: 'Q159',
};

/** 国家/地区词 → ISO 3166-1 alpha-2（供 OSM/canonical 归一）。 */
export const COUNTRY_ISO: Record<string, string> = {
  德国: 'DE',
  germany: 'DE',
  deutschland: 'DE',
  美国: 'US',
  usa: 'US',
  'united states': 'US',
  中国: 'CN',
  china: 'CN',
  日本: 'JP',
  japan: 'JP',
  韩国: 'KR',
  'south korea': 'KR',
  korea: 'KR',
  意大利: 'IT',
  italy: 'IT',
  italia: 'IT',
  法国: 'FR',
  france: 'FR',
  英国: 'GB',
  uk: 'GB',
  'united kingdom': 'GB',
  印度: 'IN',
  india: 'IN',
  奥地利: 'AT',
  austria: 'AT',
  österreich: 'AT',
  oesterreich: 'AT',
  瑞士: 'CH',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  svizzera: 'CH',
  荷兰: 'NL',
  netherlands: 'NL',
  nederland: 'NL',
  holland: 'NL',
  波兰: 'PL',
  poland: 'PL',
  polska: 'PL',
  西班牙: 'ES',
  spain: 'ES',
  españa: 'ES',
  espana: 'ES',
  葡萄牙: 'PT',
  portugal: 'PT',
  比利时: 'BE',
  belgium: 'BE',
  belgië: 'BE',
  belgique: 'BE',
  瑞典: 'SE',
  sweden: 'SE',
  sverige: 'SE',
  挪威: 'NO',
  norway: 'NO',
  norge: 'NO',
  丹麦: 'DK',
  denmark: 'DK',
  danmark: 'DK',
  芬兰: 'FI',
  finland: 'FI',
  suomi: 'FI',
  爱尔兰: 'IE',
  ireland: 'IE',
  捷克: 'CZ',
  czechia: 'CZ',
  'czech republic': 'CZ',
  匈牙利: 'HU',
  hungary: 'HU',
  罗马尼亚: 'RO',
  romania: 'RO',
  希腊: 'GR',
  greece: 'GR',
  土耳其: 'TR',
  turkey: 'TR',
  türkiye: 'TR',
  turkiye: 'TR',
  阿联酋: 'AE',
  阿拉伯联合酋长国: 'AE',
  uae: 'AE',
  'united arab emirates': 'AE',
  沙特: 'SA',
  沙特阿拉伯: 'SA',
  'saudi arabia': 'SA',
  卡塔尔: 'QA',
  qatar: 'QA',
  阿曼: 'OM',
  oman: 'OM',
  科威特: 'KW',
  kuwait: 'KW',
  埃及: 'EG',
  egypt: 'EG',
  摩洛哥: 'MA',
  morocco: 'MA',
  以色列: 'IL',
  israel: 'IL',
  南非: 'ZA',
  'south africa': 'ZA',
  巴西: 'BR',
  brazil: 'BR',
  brasil: 'BR',
  墨西哥: 'MX',
  mexico: 'MX',
  méxico: 'MX',
  智利: 'CL',
  chile: 'CL',
  哥伦比亚: 'CO',
  colombia: 'CO',
  阿根廷: 'AR',
  argentina: 'AR',
  秘鲁: 'PE',
  peru: 'PE',
  perú: 'PE',
  加拿大: 'CA',
  canada: 'CA',
  澳大利亚: 'AU',
  australia: 'AU',
  新西兰: 'NZ',
  'new zealand': 'NZ',
  新加坡: 'SG',
  singapore: 'SG',
  马来西亚: 'MY',
  malaysia: 'MY',
  印度尼西亚: 'ID',
  印尼: 'ID',
  indonesia: 'ID',
  越南: 'VN',
  vietnam: 'VN',
  'viet nam': 'VN',
  泰国: 'TH',
  thailand: 'TH',
  菲律宾: 'PH',
  philippines: 'PH',
  俄罗斯: 'RU',
  russia: 'RU',
};

/** ISO 3166-1 alpha-2 → 中文国名（ICP 提示词与目标市场补齐展示用；未收录的回退为代码本身）。 */
export const COUNTRY_NAME_BY_ISO: Record<string, string> = {
  DE: '德国', AT: '奥地利', CH: '瑞士', FR: '法国', IT: '意大利', ES: '西班牙', NL: '荷兰', PL: '波兰',
  BE: '比利时', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IE: '爱尔兰', CZ: '捷克', HU: '匈牙利',
  RO: '罗马尼亚', GR: '希腊', GB: '英国', US: '美国', CN: '中国', JP: '日本', KR: '韩国', IN: '印度',
  MY: '马来西亚', SG: '新加坡', ID: '印度尼西亚', VN: '越南', TH: '泰国', PH: '菲律宾', PT: '葡萄牙',
  TR: '土耳其', AE: '阿联酋', SA: '沙特阿拉伯', QA: '卡塔尔', OM: '阿曼', KW: '科威特', EG: '埃及',
  MA: '摩洛哥', IL: '以色列', AU: '澳大利亚', NZ: '新西兰', CA: '加拿大', MX: '墨西哥', BR: '巴西',
  CL: '智利', CO: '哥伦比亚', AR: '阿根廷', PE: '秘鲁', ZA: '南非', RU: '俄罗斯',
};

const DACH: readonly string[] = Object.freeze(['DE', 'AT', 'CH']);
const BENELUX: readonly string[] = Object.freeze(['NL', 'BE', 'LU']);
const NORDICS: readonly string[] = Object.freeze(['SE', 'NO', 'DK', 'FI']);
const GCC: readonly string[] = Object.freeze(['AE', 'SA', 'QA', 'OM', 'KW', 'BH']);
const MENA: readonly string[] = Object.freeze(['AE', 'SA', 'QA', 'OM', 'KW', 'EG', 'MA']);
const LATAM: readonly string[] = Object.freeze(['BR', 'MX', 'CL', 'CO', 'AR', 'PE']);
const ASEAN: readonly string[] = Object.freeze(['SG', 'MY', 'ID', 'VN', 'TH', 'PH']);

/**
 * 跨国市场地区词（归一为小写）→ 成员国 ISO 3166-1 alpha-2（有序）。只用于目标市场这类国家**列表**：
 * 列表里的「DACH」就是德国、奥地利、瑞士三国，不能被归一成其中一国。单个公司的所在国不会是地区，
 * 所以 COUNTRY_ISO / COUNTRY_QIDS 不收地区词。
 */
export const MARKET_REGION_COUNTRIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dach: DACH,
  'd-a-ch': DACH,
  dach区域: DACH,
  dach地区: DACH,
  dach市场: DACH,
  'dach region': DACH,
  'dach-region': DACH,
  'dach-raum': DACH,
  benelux: BENELUX,
  比荷卢: BENELUX,
  nordics: NORDICS,
  北欧: NORDICS,
  gcc: GCC,
  海湾六国: GCC,
  海合会: GCC,
  mena: MENA,
  中东: MENA,
  中东北非: MENA,
  'middle east': MENA,
  latam: LATAM,
  拉美: LATAM,
  拉丁美洲: LATAM,
  'latin america': LATAM,
  asean: ASEAN,
  东盟: ASEAN,
  东南亚: ASEAN,
  'southeast asia': ASEAN,
});

/**
 * 行业词 → OSM 标签过滤（用于 Overpass 地理发现）。
 * 只用**索引快**的 craft 类标签——man_made=works / industrial=factory / landuse=industrial
 * 在州级别查询极慢（单个 30-40s，union 必超时），已剔除。adapter 会逐标签分别查询再合并。
 */
export const INDUSTRY_OSM_TAGS: Record<string, { k: string; v?: string }[]> = {
  金属加工: [{ k: 'craft', v: 'metal_construction' }, { k: 'craft', v: 'blacksmith' }],
  'metal fabrication': [{ k: 'craft', v: 'metal_construction' }, { k: 'craft', v: 'blacksmith' }],
  metalworking: [{ k: 'craft', v: 'metal_construction' }, { k: 'craft', v: 'blacksmith' }],
  钣金: [{ k: 'craft', v: 'metal_construction' }],
  'sheet metal': [{ k: 'craft', v: 'metal_construction' }],
  机械制造: [{ k: 'craft', v: 'metal_construction' }],
  制造业: [{ k: 'craft', v: 'metal_construction' }],
  manufacturing: [{ k: 'craft', v: 'metal_construction' }],
};

/** 国家与常见地区名（供 OSM area 查询）。 */
export const REGION_OSM_AREA: Record<string, string> = {
  德国: 'Deutschland',
  germany: 'Deutschland',
  de: 'Deutschland',
  deutschland: 'Deutschland',
  'baden-württemberg': 'Baden-Württemberg',
  巴登符腾堡: 'Baden-Württemberg',
  bavaria: 'Bayern',
  巴伐利亚: 'Bayern',
  意大利: 'Italia',
  italy: 'Italia',
  it: 'Italia',
  italia: 'Italia',
  法国: 'France',
  france: 'France',
  fr: 'France',
  西班牙: 'España',
  spain: 'España',
  es: 'España',
  荷兰: 'Nederland',
  netherlands: 'Nederland',
  nl: 'Nederland',
  波兰: 'Polska',
  poland: 'Polska',
  pl: 'Polska',
  奥地利: 'Österreich',
  austria: 'Österreich',
  at: 'Österreich',
  瑞士: 'Schweiz',
  switzerland: 'Schweiz',
  ch: 'Schweiz',
  巴西: 'Brasil',
  brazil: 'Brasil',
  br: 'Brasil',
  墨西哥: 'México',
  mexico: 'México',
  mx: 'México',
};

/**
 * 词表键归一：Unicode NFC + 小写 + 去空白。**必须**——含变音符的词（Württemberg 的 ü、
 * Bayern 等）从 JSON/DB 进来可能是 NFD（组合字符），与源文件的 NFC 键不相等，
 * toLowerCase 也救不了。所有查表都经此函数。
 */
export function normKey(term: string): string {
  return term.normalize('NFC').toLowerCase().trim();
}

/**
 * 查表只认表自己的键：词来自模型与 ICP，「constructor」「toString」这类词不能取到对象原型上的属性
 * （取到的是函数，会被当成国家码、QID 或地区成员国列表用）。
 */
function own<T>(table: Readonly<Record<string, T>>, term: string): T | undefined {
  const key = normKey(term);
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function mapIndustryToQids(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    const q = own(INDUSTRY_QIDS, t);
    if (q) out.add(q);
  }
  return [...out];
}

export function mapCountryToQid(term: string): string | undefined {
  const direct = own(COUNTRY_QIDS, term);
  if (direct) return direct;
  // Query plans frequently store ISO-3166 alpha-2 codes (e.g. "DE", "IT", "BR", "AE").
  const iso = normKey(term).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(iso)) return undefined;
  const candidates = new Set(
    Object.entries(COUNTRY_ISO)
      .filter(([, code]) => code === iso)
      .map(([alias]) => own(COUNTRY_QIDS, alias))
      .filter((qid): qid is string => Boolean(qid)),
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

export function lookupIndustryOsmTags(term: string): { k: string; v?: string }[] | undefined {
  return own(INDUSTRY_OSM_TAGS, term);
}

export function lookupRegionOsmArea(term: string): string | undefined {
  return own(REGION_OSM_AREA, term);
}

export function lookupCountryIso(term: string): string | undefined {
  return own(COUNTRY_ISO, term);
}

/** 地区词的成员国 alpha-2（「DACH」→ DE、AT、CH）；不是已知地区时为 undefined。 */
export function lookupMarketRegion(term: string): readonly string[] | undefined {
  return own(MARKET_REGION_COUNTRIES, term);
}

/** 目标市场列表：地区词就地换成成员国 alpha-2，其余词原样保留、顺序不变。 */
export function expandMarketRegions(terms: readonly string[]): string[] {
  return terms.flatMap((term) => lookupMarketRegion(term) ?? [term]);
}
