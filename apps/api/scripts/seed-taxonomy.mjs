/**
 * 一次性种子：CanonicalTaxonomy + TermAlias。
 * 国家：world-countries 全量 ISO 3166-1（250 国）+ 中/英/德多语言别名（确定性、零 LLM）。
 * 行业：ISIC Rev.4 制造相关种子（isic-seed）+ 别名迁移。
 * 用 owner 连接（DATABASE_URL）写平台级参考数据。可重复运行（upsert）。
 *
 * 运行：node --import tsx scripts/seed-taxonomy.mjs   或先 build 后 node scripts/seed-taxonomy.mjs
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import countries from 'world-countries';
import { ISIC_SEED } from '../dist/discovery/isic-seed.js';

// alpha-2 → Wikidata country QID（供 wikidata provider 的国家过滤）。主要国家覆盖；
// 长尾可后续用 Wikidata SPARQL(P297) 批量补全。
const ALPHA2_TO_QID = {
  DE: 'Q183', US: 'Q30', CN: 'Q148', JP: 'Q17', KR: 'Q884', IT: 'Q38', FR: 'Q142',
  GB: 'Q145', IN: 'Q668', ES: 'Q29', NL: 'Q55', CH: 'Q39', AT: 'Q40', BE: 'Q31',
  SE: 'Q34', PL: 'Q36', CZ: 'Q213', TR: 'Q43', BR: 'Q155', MX: 'Q96', CA: 'Q16',
  RU: 'Q159', TW: 'Q865', VN: 'Q881', TH: 'Q869', ID: 'Q252', MY: 'Q833',
};

const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const norm = (s) => s.normalize('NFC').toLowerCase().trim();

async function upsertNode(kind, scheme, code, data) {
  await db.canonicalTaxonomy.upsert({
    where: { kind_code: { kind, code } },
    update: data,
    create: { kind, scheme, code, ...data },
  });
}
async function upsertAlias(kind, term, code, source) {
  const t = norm(term);
  if (!t) return;
  await db.termAlias.upsert({
    where: { kind_term: { kind, term: t } },
    update: { code, source },
    create: { kind, term: t, code, source },
  });
}

async function seedCountries() {
  let n = 0, a = 0;
  for (const c of countries) {
    const code = c.cca2; // ISO alpha-2
    const zh = c.translations?.zho?.common;
    const de = c.translations?.deu?.common;
    const labels = { zh, de, native: Object.values(c.name.native ?? {})[0]?.common };
    await upsertNode('country', 'ISO3166_1', code, {
      labelEn: c.name.common,
      labels,
      crosswalks: { alpha3: [c.cca3], numeric: [c.ccn3] },
      wikidataQid: ALPHA2_TO_QID[code] ?? null,
    });
    n++;
    // 别名：英文常用名/官方名、中文、德文、alpha-3、本地名
    const aliases = new Set([c.name.common, c.name.official, c.cca3, zh, de, labels.native, ...Object.values(c.altSpellings ?? [])]);
    for (const al of aliases) { if (al) { await upsertAlias('country', al, code, 'seed'); a++; } }
  }
  return { nodes: n, aliases: a };
}

// CPV 子树种子（§2.3 有界·手工核验·frozen source='seed'，非全 9450 码树）。
// 8 位码 + parentCode 自引用（前缀嵌套）；供 ISIC.crosswalks.cpv 锚定 + 产品精修枚举 + node('cpv',code) 校验。
const CPV_SEED = [
  { code: '42000000', parent: null, en: 'Industrial machinery', zh: '工业机械', de: 'Industrielle Maschinen' },
  { code: '42120000', parent: '42000000', en: 'Pumps and compressors', zh: '泵与压缩机', de: 'Pumpen und Kompressoren' },
  { code: '42122000', parent: '42120000', en: 'Pumps', zh: '泵', de: 'Pumpen' },
  { code: '42122130', parent: '42122000', en: 'Water pumps', zh: '水泵', de: 'Wasserpumpen' },
  { code: '42123000', parent: '42120000', en: 'Compressors', zh: '压缩机', de: 'Kompressoren' },
];

async function seedCpv() {
  let n = 0, a = 0;
  for (const c of CPV_SEED) {
    await upsertNode('cpv', 'CPV', c.code, { parentCode: c.parent, labelEn: c.en, labels: { zh: c.zh, de: c.de } });
    n++;
    for (const al of [c.en, c.zh, c.de]) { if (al) { await upsertAlias('cpv', al, c.code, 'seed'); a++; } }
  }
  return { nodes: n, aliases: a };
}

// FDA 器械分类（curated 子集，手工核验自 openFDA /device/classification；非全 ~6000 树，同 CPV 子树种子哲学）。
// panel = 2 字母专科（parentCode null）；product code = 3 字母（parentCode = panel，无前缀层级靠显式父维）。
const FDA_PANEL_SEED = [
  { code: 'RA', en: 'Radiology', zh: '放射' },
  { code: 'CV', en: 'Cardiovascular', zh: '心血管' },
  { code: 'OR', en: 'Orthopedic', zh: '骨科' },
  { code: 'SU', en: 'General & Plastic Surgery', zh: '普通与整形外科' },
  { code: 'GU', en: 'Gastroenterology & Urology', zh: '胃肠与泌尿' },
  { code: 'EN', en: 'Ear, Nose & Throat', zh: '耳鼻喉' },
];
const FDA_CODE_SEED = [
  { code: 'LLZ', panel: 'RA', en: 'System, Image Processing, Radiological', zh: '放射影像处理系统', cls: '2', reg: '892.2050' },
  { code: 'IZF', panel: 'RA', en: 'System, X-Ray, Tomographic', zh: 'X 射线断层扫描系统', cls: '2', reg: '892.1740' },
  { code: 'OXO', panel: 'RA', en: 'Image-Intensified Fluoroscopic X-Ray System, Mobile', zh: '移动影像增强透视 X 射线系统', cls: '2', reg: '892.1650' },
  { code: 'KPS', panel: 'RA', en: 'System, Tomography, Computed, Emission', zh: '发射计算机断层系统', cls: '2', reg: '892.1200' },
  { code: 'IZL', panel: 'RA', en: 'System, X-Ray, Mobile', zh: '移动 X 射线系统', cls: '2', reg: '892.1720' },
  { code: 'QQE', panel: 'RA', en: 'Image Management Software For Planning Of Otologic And Neurotologic Procedures', zh: '耳科与神经耳科手术规划影像管理软件', cls: '2', reg: '892.2050' },
];
async function seedFda() {
  let n = 0, a = 0;
  for (const p of FDA_PANEL_SEED) {
    await upsertNode('fda_panel', 'FDA_PANEL', p.code, { parentCode: null, labelEn: p.en, labels: { zh: p.zh } });
    n++;
    for (const al of [p.en, p.zh]) { if (al) { await upsertAlias('fda_panel', al, p.code, 'seed'); a++; } }
  }
  for (const c of FDA_CODE_SEED) {
    await upsertNode('fda_product_code', 'FDA_PRODUCT_CODE', c.code, {
      parentCode: c.panel, labelEn: c.en, labels: { zh: c.zh },
      crosswalks: { fdaPanels: [c.panel], deviceClass: c.cls, regulationNumber: c.reg },
    });
    n++;
    for (const al of [c.en, c.zh, c.code]) { if (al) { await upsertAlias('fda_product_code', al, c.code, 'seed'); a++; } }
  }
  return { nodes: n, aliases: a };
}

// NAICS 子树种子（§2.3 SAM.gov·有界·手工核验·frozen source='seed'，非全 ~1000 码树，同 CPV/FDA 子树哲学）。
// NAICS = 数字前缀层级（2→6 位，无 CPV 尾零占位）；parentCode 自引用（前缀嵌套）。
// 供 ISIC.crosswalks.naics 锚定的**产品精修**：resolveNaicsForProduct 先查 TermAlias 确定性命中——
// Temporal Schedule 走 allowLlm:false，产品→窄码全靠这些 seed 别名（无别名则只落宽锚码，仍正确只是宽）。
// 🔴 别名只挂**已核验窄码**（333914/334517/339112），绝不给宽码（333/334/3391）贴产品词——否则宽子树误吞。
const NAICS_SEED = [
  // 机械制造子树：ICP「pumps」经 ISIC 28→333 锚 → 产品精修落 333914（Measuring/Dispensing/Pumping Equipment）
  { code: '333', parent: null, en: 'Machinery manufacturing', zh: '机械制造', de: 'Maschinenbau' },
  { code: '3339', parent: '333', en: 'Other general purpose machinery manufacturing', zh: '其他通用设备制造', de: 'Sonstige allgemeine Maschinen' },
  { code: '333914', parent: '3339', en: 'Measuring, dispensing, and other pumping equipment manufacturing', zh: '泵与计量分配设备制造', de: 'Pumpen- und Dosiertechnik',
    aliases: ['pump', 'pumps', '泵', 'water pump', 'water pumps', 'pumping equipment', 'dosing pump'] },
  // 电子/测量/放射子树：放射设备 334517 归 334（非医疗 3391）；ICP「electronics」经 ISIC 26→334 可达
  { code: '334', parent: null, en: 'Computer and electronic product manufacturing', zh: '计算机与电子产品制造', de: 'Elektronik' },
  { code: '3345', parent: '334', en: 'Navigational, measuring, electromedical, and control instruments manufacturing', zh: '导航测量电子医疗与控制仪器制造', de: 'Mess- und Kontrolltechnik',
    aliases: ['measuring instruments', 'measurement instruments', '测量仪器', 'control instruments', 'metrology'] },
  { code: '334517', parent: '3345', en: 'Irradiation apparatus manufacturing', zh: '辐照设备制造（X 光/CT/放疗）', de: 'Bestrahlungsgeräte',
    aliases: ['x-ray', 'ct scanner', 'irradiation apparatus', 'radiation therapy', '放射设备', 'radiological imaging', 'irradiation'] },
  // 医疗器械子树：ICP「radiology/medical device」经 ISIC 325→3391 锚 → 产品精修落 339112
  { code: '3391', parent: null, en: 'Medical equipment and supplies manufacturing', zh: '医疗设备与耗材制造', de: 'Medizintechnik' },
  { code: '339112', parent: '3391', en: 'Surgical and medical instrument manufacturing', zh: '外科与医疗器械制造', de: 'Chirurgische und medizinische Instrumente',
    aliases: ['surgical instruments', 'medical instruments', '手术器械', '外科器械', 'medical device instruments'] },
  // 金属制品子树：ICP「metal fabrication」经 ISIC 25→332 锚
  { code: '332', parent: null, en: 'Fabricated metal product manufacturing', zh: '金属制品制造', de: 'Metallerzeugnisse' },
];
async function seedNaics() {
  let n = 0, a = 0;
  for (const c of NAICS_SEED) {
    await upsertNode('naics', 'NAICS', c.code, { parentCode: c.parent, labelEn: c.en, labels: { zh: c.zh, de: c.de } });
    n++;
    const aliases = new Set([c.en, c.zh, c.de, c.code, ...(c.aliases ?? [])]);
    for (const al of aliases) { if (al) { await upsertAlias('naics', al, c.code, 'seed'); a++; } }
  }
  return { nodes: n, aliases: a };
}

async function seedIndustries() {
  let n = 0, a = 0;
  for (const node of ISIC_SEED) {
    await upsertNode('industry', 'ISIC', node.code, {
      parentCode: node.parent ?? null,
      labelEn: node.en,
      labels: { zh: node.zh, de: node.de },
      crosswalks: node.crosswalks ?? null,
      wikidataQid: node.wikidataQid ?? null,
      osmTags: node.osmTags ?? null,
    });
    n++;
    const aliases = new Set([node.en, node.zh, node.de, ...(node.aliases ?? [])]);
    for (const al of aliases) { if (al) { await upsertAlias('industry', al, node.code, 'seed'); a++; } }
  }
  return { nodes: n, aliases: a };
}

const cty = await seedCountries();
const ind = await seedIndustries();
const cpv = await seedCpv();
const fda = await seedFda();
const naics = await seedNaics();
console.log(`countries: ${cty.nodes} nodes, ${cty.aliases} aliases`);
console.log(`industries: ${ind.nodes} nodes, ${ind.aliases} aliases`);
console.log(`cpv: ${cpv.nodes} nodes, ${cpv.aliases} aliases`);
console.log(`fda: ${fda.nodes} nodes, ${fda.aliases} aliases`);
console.log(`naics: ${naics.nodes} nodes, ${naics.aliases} aliases`);
const totalAlias = await db.termAlias.count();
const totalNode = await db.canonicalTaxonomy.count();
console.log(`TOTAL: ${totalNode} canonical nodes, ${totalAlias} aliases`);
await db.$disconnect();
process.exit(0);
