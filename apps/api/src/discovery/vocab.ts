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

/** 行业词（归一为小写）→ Wikidata industry QID。 */
export const INDUSTRY_QIDS: Record<string, string> = {
  // 金属加工 / 制造
  制造业: 'Q187939',
  manufacturing: 'Q187939',
  金属加工: 'Q19541171',
  'metal fabrication': 'Q19541171',
  metalworking: 'Q19541171',
  钣金: 'Q1857831',
  'sheet metal': 'Q1857831',
  'sheet metal fabrication': 'Q1857831',
  机械制造: 'Q1857831',
  'mechanical engineering': 'Q1857831',
  机床: 'Q1857831',
  'machine tool': 'Q1857831',
  'machine tools': 'Q1857831',
  汽车: 'Q190117',
  automotive: 'Q190117',
  'automotive industry': 'Q190117',
  汽车零部件: 'Q190117',
  航空航天: 'Q765633',
  aerospace: 'Q765633',
  半导体: 'Q11661',
  semiconductor: 'Q11661',
  电子: 'Q11650',
  electronics: 'Q11650',
  新能源: 'Q12705122',
  'renewable energy': 'Q12705122',
  钢铁: 'Q206894',
  steel: 'Q206894',
  'steel industry': 'Q206894',
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
  意大利: 'IT',
  italy: 'IT',
  法国: 'FR',
  france: 'FR',
  英国: 'GB',
  uk: 'GB',
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
};

const DACH: readonly string[] = Object.freeze(['DE', 'AT', 'CH']);

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

/** 德国州/地区名（供 OSM area 查询）。可扩展。 */
export const REGION_OSM_AREA: Record<string, string> = {
  德国: 'Deutschland',
  germany: 'Deutschland',
  'baden-württemberg': 'Baden-Württemberg',
  巴登符腾堡: 'Baden-Württemberg',
  bavaria: 'Bayern',
  巴伐利亚: 'Bayern',
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
  return own(COUNTRY_QIDS, term);
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
