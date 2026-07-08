/**
 * ISIC Rev.4 行业种子（制造/工业相关为主 —— TRUMPF 等出海制造场景的核心覆盖）。
 * 每个节点：ISIC code + 层级 parent + 中/英/德 规范名 + 跨标准对照 + 发现标识
 * （Wikidata QID / OSM 标签）。长尾行业由冷路径 LLM 归一到这些码。
 * 别名(aliases)迁自旧 vocab.ts + 常见中英德口语。
 */
export interface IsicNode {
  code: string;
  parent?: string;
  en: string;
  zh: string;
  de?: string;
  crosswalks?: { cpv?: string[]; nace?: string[]; naics?: string[]; gb4754?: string[] };
  wikidataQid?: string;
  osmTags?: { k: string; v?: string }[];
  aliases?: string[]; // 归一到该 code 的别名（中/英/德/口语）
}

export const ISIC_SEED: IsicNode[] = [
  // Section C — Manufacturing
  { code: 'C', en: 'Manufacturing', zh: '制造业', de: 'Verarbeitendes Gewerbe', wikidataQid: 'Q187939',
    aliases: ['制造业', 'manufacturing', 'fertigung', '生产制造', 'industrial manufacturing'] },

  // Division 24 — Basic metals
  { code: '24', parent: 'C', en: 'Manufacture of basic metals', zh: '基本金属制造', de: 'Metallerzeugung',
    crosswalks: { nace: ['24'], naics: ['331'], gb4754: ['31', '32'] }, wikidataQid: 'Q206894',
    aliases: ['钢铁', 'steel', 'steel industry', 'basic metals', 'metallurgy', '冶金', 'stahl'] },

  // Division 25 — Fabricated metal products（钣金/金属加工核心）
  { code: '25', parent: 'C', en: 'Manufacture of fabricated metal products', zh: '金属制品制造', de: 'Herstellung von Metallerzeugnissen',
    crosswalks: { nace: ['25'], naics: ['332'], gb4754: ['33'] }, wikidataQid: 'Q19541171',
    osmTags: [{ k: 'craft', v: 'metal_construction' }, { k: 'craft', v: 'blacksmith' }],
    aliases: ['金属加工', 'metal fabrication', 'metalworking', 'metallverarbeitung', '金属制品', 'fabricated metal', 'metallbau'] },
  { code: '2599', parent: '25', en: 'Manufacture of other fabricated metal products (sheet metal)', zh: '钣金加工', de: 'Blechbearbeitung',
    crosswalks: { nace: ['25.99'], naics: ['332999'] }, wikidataQid: 'Q1857831',
    osmTags: [{ k: 'craft', v: 'metal_construction' }],
    aliases: ['钣金', 'sheet metal', 'sheet metal fabrication', 'blechbearbeitung', '激光切割', 'laser cutting', '折弯', 'bending', '焊接', 'welding'] },

  // Division 28 — Machinery & equipment（机床/机械制造）
  { code: '28', parent: 'C', en: 'Manufacture of machinery and equipment n.e.c.', zh: '通用及专用设备制造', de: 'Maschinenbau',
    crosswalks: { cpv: ['42120000'], nace: ['28'], naics: ['333'], gb4754: ['34', '35'] }, wikidataQid: 'Q1857831',
    aliases: ['机械制造', 'mechanical engineering', 'machinery', 'maschinenbau', '机床', 'machine tool', 'machine tools', '装备制造', '设备制造', 'pump', 'pumps', '泵', 'compressor', 'compressors', 'pumps and compressors'] },

  // Division 29 — Motor vehicles
  { code: '29', parent: 'C', en: 'Manufacture of motor vehicles, trailers and semi-trailers', zh: '汽车制造', de: 'Fahrzeugbau',
    crosswalks: { nace: ['29'], naics: ['3361', '3362', '3363'], gb4754: ['36'] }, wikidataQid: 'Q190117',
    aliases: ['汽车', 'automotive', 'automotive industry', 'automobil', '汽车零部件', 'auto parts', 'car manufacturing', '汽车制造'] },

  // Division 30 — Other transport equipment（含航空航天）
  { code: '303', parent: 'C', en: 'Manufacture of air and spacecraft', zh: '航空航天器制造', de: 'Luft- und Raumfahrt',
    crosswalks: { nace: ['30.3'], naics: ['3364'] }, wikidataQid: 'Q765633',
    aliases: ['航空航天', 'aerospace', 'aviation', 'luft- und raumfahrt', '航空', '航天'] },

  // Division 26/27 — Electronics / electrical
  { code: '26', parent: 'C', en: 'Manufacture of computer, electronic and optical products', zh: '电子及光学产品制造', de: 'Elektronik',
    crosswalks: { nace: ['26'], naics: ['334'], gb4754: ['39', '40'] }, wikidataQid: 'Q11650',
    aliases: ['电子', 'electronics', 'elektronik', '电子制造', 'consumer electronics'] },
  { code: '2610', parent: '26', en: 'Manufacture of electronic components (semiconductors)', zh: '半导体制造', de: 'Halbleiter',
    crosswalks: { nace: ['26.11'], naics: ['334413'] }, wikidataQid: 'Q11661',
    aliases: ['半导体', 'semiconductor', 'semiconductors', 'halbleiter', '芯片', 'chip', '集成电路'] },

  // Division 27 — Electrical equipment（含新能源电池方向）
  { code: '272', parent: 'C', en: 'Manufacture of batteries and accumulators', zh: '电池制造', de: 'Batterieherstellung',
    crosswalks: { nace: ['27.2'], naics: ['335910'] }, wikidataQid: 'Q12705122',
    aliases: ['新能源', 'renewable energy', '新能源电池', 'battery', 'batteries', 'new energy', '动力电池', 'energy storage'] },
];
