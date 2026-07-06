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
console.log(`countries: ${cty.nodes} nodes, ${cty.aliases} aliases`);
console.log(`industries: ${ind.nodes} nodes, ${ind.aliases} aliases`);
const totalAlias = await db.termAlias.count();
const totalNode = await db.canonicalTaxonomy.count();
console.log(`TOTAL: ${totalNode} canonical nodes, ${totalAlias} aliases`);
await db.$disconnect();
process.exit(0);
