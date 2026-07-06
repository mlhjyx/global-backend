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
};

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

export function mapIndustryToQids(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    const q = INDUSTRY_QIDS[t.toLowerCase().trim()];
    if (q) out.add(q);
  }
  return [...out];
}

export function mapCountryToQid(term: string): string | undefined {
  return COUNTRY_QIDS[term.toLowerCase().trim()];
}
