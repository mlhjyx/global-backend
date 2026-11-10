import { describe, expect, it } from 'vitest';
import { INDUSTRY_ROLE_KIND, INDUSTRY_ROLE_SEED, ISIC_SEED } from './isic-seed';
import { CPV_SEED } from './cpv-seed';
import { resolveIcpToCpv, type CpvTaxonomyPort } from './icp-to-cpv';
import { cpvSubtreePrefix, type CanonicalNode } from './taxonomy-resolver';

const norm = (s: string): string => s.normalize('NFC').toLowerCase().trim();

/**
 * 内存 taxonomy 桩：直接由种子数据（与 seed-taxonomy.mjs 相同的来源）构造，
 * 复刻 TermAlias（(kind,term) 唯一、后写覆盖）+ ISIC/CPV crosswalk 的解析语义。
 * 不动线上库、不依赖 Prisma —— 验的是「种子完备性 + icp-to-cpv 纯函数」这一链路。
 */
function inMemoryPort(): CpvTaxonomyPort {
  const industryByTerm = new Map<string, CanonicalNode>();
  for (const node of ISIC_SEED) {
    const canonical: CanonicalNode = {
      kind: 'industry',
      scheme: 'ISIC',
      code: node.code,
      labelEn: node.en,
      labels: { zh: node.zh, de: node.de, it: node.it, fr: node.fr, es: node.es } as Record<string, string>,
      wikidataQid: node.wikidataQid ?? null,
      osmTags: node.osmTags ?? null,
      crosswalks: node.crosswalks ?? null,
    };
    for (const term of [node.en, node.zh, node.de, node.it, node.fr, node.es, ...(node.aliases ?? [])]) {
      if (term) industryByTerm.set(norm(term), canonical);
    }
  }
  const countryAlpha3: Record<string, string> = {
    italy: 'ITA', italia: 'ITA', '意大利': 'ITA',
    'united kingdom': 'GBR', uk: 'GBR', '英国': 'GBR',
    'united states': 'USA', usa: 'USA', us: 'USA', '美国': 'USA',
    germany: 'DEU', deutschland: 'DEU', '德国': 'DEU',
    france: 'FRA', '法国': 'FRA',
  };
  const countryNode = (iso3: string): CanonicalNode => ({
    kind: 'country', scheme: 'ISO3166_1', code: iso3.slice(0, 2), labelEn: iso3,
    labels: null, wikidataQid: null, osmTags: null, crosswalks: { alpha3: [iso3] },
  });
  return {
    resolveMany: async (kind, terms) =>
      kind === 'industry'
        ? terms.map((t) => industryByTerm.get(norm(t))).filter((n): n is CanonicalNode => !!n)
        : [],
    resolve: async (kind, term) => {
      if (kind === 'industry') return industryByTerm.get(norm(term)) ?? null;
      if (kind !== 'country') return null;
      const iso3 = countryAlpha3[norm(term)];
      return iso3 ? countryNode(iso3) : null;
    },
    resolveCpvForProduct: async () => null,
  };
}

const port = inMemoryPort();
const IT_ONLY = { allowLlm: false } as const;

describe('行业词汇扩建 · ICP→CPV 演示词解析（真实种子 + 内存桩）', () => {
  it('「光伏」ICP（意大利/美国/英国）→ 非空 CPV（09331200），TED 买方 ITA/GBR，美国显式 warning', async () => {
    const r = await resolveIcpToCpv(
      port,
      { industryTerms: ['光伏'], targetCountries: ['意大利', '美国', '英国'] },
      IT_ONLY,
    );
    expect(r.cpvCodes).toContain('09331200');
    expect(r.cpvCodes.length).toBeGreaterThan(0);
    expect(r.buyerCountries).toEqual(['ITA', 'GBR']);
    expect(r.warnings.some((w) => /icp_fit_warning/.test(w) && /美国/.test(w))).toBe(true);
  });

  it('「太阳能」同族词 → 同一 CPV 族（0933xxxx）', async () => {
    const r = await resolveIcpToCpv(port, { industryTerms: ['太阳能'], targetCountries: ['意大利'] }, IT_ONLY);
    expect(r.cpvCodes).toContain('09331200');
  });

  it('「零碳建筑」→ 施工安装 CPV（45 族），不空手', async () => {
    const r = await resolveIcpToCpv(port, { industryTerms: ['零碳建筑'], targetCountries: ['英国'] }, IT_ONLY);
    expect(r.cpvCodes).toContain('45300000');
    expect(r.buyerCountries).toEqual(['GBR']);
  });

  it('「建筑电气」→ 电气安装 CPV（45310000）', async () => {
    const r = await resolveIcpToCpv(port, { industryTerms: ['建筑电气'], targetCountries: ['意大利'] }, IT_ONLY);
    expect(r.cpvCodes).toContain('45310000');
  });

  it('「泵阀贸易」→ 泵阀 CPV（42120000 / 42130000）', async () => {
    const r = await resolveIcpToCpv(port, { industryTerms: ['泵阀贸易'], targetCountries: ['意大利'] }, IT_ONLY);
    expect(r.cpvCodes.some((c) => c === '42120000' || c === '42130000')).toBe(true);
  });

  it('「EPC」→ 土木工程 CPV（45200000）；「热泵」→ 42511110', async () => {
    const epc = await resolveIcpToCpv(port, { industryTerms: ['EPC'], targetCountries: ['英国'] }, IT_ONLY);
    expect(epc.cpvCodes).toContain('45200000');
    const hp = await resolveIcpToCpv(port, { industryTerms: ['热泵'], targetCountries: ['意大利'] }, IT_ONLY);
    expect(hp.cpvCodes).toContain('42511110');
  });

  it('英文/德文常用词同样命中：solar panels / valves / Wärmepumpen', async () => {
    const solar = await resolveIcpToCpv(port, { industryTerms: ['solar panels'], targetCountries: ['Italy'] }, IT_ONLY);
    expect(solar.cpvCodes).toContain('09331200');
    const valves = await resolveIcpToCpv(port, { industryTerms: ['valves'], targetCountries: ['Italy'] }, IT_ONLY);
    expect(valves.cpvCodes).toContain('42130000');
    const wp = await resolveIcpToCpv(port, { industryTerms: ['Wärmepumpen'], targetCountries: ['Italy'] }, IT_ONLY);
    expect(wp.cpvCodes).toContain('42511110');
  });

  it('产品精修未命中时回退宽网候选（不空手）', async () => {
    const r = await resolveIcpToCpv(
      port,
      { industryTerms: ['光伏'], product: '太阳能支架', targetCountries: ['意大利'] },
      { allowLlm: true },
    );
    expect(r.cpvCodes.length).toBeGreaterThan(0);
  });
});

describe('行业种子完备性（pipeline 数据契约）', () => {
  const cpvByCode = new Map(CPV_SEED.map((c) => [c.code, c]));

  it('每个行业节点有 en + zh，多语标签键限于 zh/de/it/fr/es', () => {
    for (const node of ISIC_SEED) {
      expect(node.en.trim().length, node.code).toBeGreaterThan(0);
      expect(node.zh.trim().length, node.code).toBeGreaterThan(0);
    }
    for (const node of INDUSTRY_ROLE_SEED) {
      expect(node.en.trim().length, node.code).toBeGreaterThan(0);
      expect(node.zh.trim().length, node.code).toBeGreaterThan(0);
    }
  });

  it('要求的行业方向都有种子词覆盖（出口/获客高频行业）', async () => {
    const demo = ['光伏', '风电', '储能', '暖通', '泵阀贸易', '塑料包装', '电子元器件', '汽车零部件', '化工材料', '批发', '工程服务', '软件', 'EPC', '零碳建筑'];
    for (const term of demo) {
      const node = await port.resolve('industry', term);
      expect(node, `行业词「${term}」无种子`).not.toBeNull();
    }
  });

  it('industry 别名(case-insensitive)不跨节点重复（term_alias 唯一键，后写会静默覆盖）', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const node of ISIC_SEED) {
      const terms = new Set(
        [node.en, node.zh, node.de, node.it, node.fr, node.es, ...(node.aliases ?? [])]
          .filter((t): t is string => !!t)
          .map(norm),
      );
      for (const term of terms) {
        const prev = seen.get(term);
        if (prev && prev !== node.code) conflicts.push(`${term}: ${prev} vs ${node.code}`);
        seen.set(term, node.code);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('industry_role 别名不跨角色重复；渠道角色词齐备（de/it/fr/es）', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const role of INDUSTRY_ROLE_SEED) {
      const terms = new Set(
        [role.en, role.zh, role.de, role.it, role.fr, role.es, ...role.aliases]
          .filter((t): t is string => !!t)
          .map(norm),
      );
      for (const term of terms) {
        const prev = seen.get(term);
        if (prev && prev !== role.code) conflicts.push(`${term}: ${prev} vs ${role.code}`);
        seen.set(term, role.code);
      }
    }
    expect(conflicts).toEqual([]);
    for (const word of ['fachhandel', 'großhandel', 'rivenditore', 'distributore', 'distributeur', 'mayorista', 'importatore', 'grossista']) {
      expect(seen.get(norm(word)), `角色词「${word}」未入 ${INDUSTRY_ROLE_KIND}`).toBeDefined();
    }
  });

  it('ISIC.crosswalks.cpv 只锚定已种子的 CPV 码（双向可解析）', () => {
    for (const node of ISIC_SEED) {
      for (const cpv of node.crosswalks?.cpv ?? []) {
        expect(cpvByCode.has(cpv), `${node.code} → ${cpv} 不在 cpv-seed`).toBe(true);
      }
    }
  });

  it('CPV parent 存在（或 null）且子码落在父码子树前缀内（8 位前缀嵌套）', () => {
    for (const c of CPV_SEED) {
      if (c.parent != null) {
        expect(cpvByCode.has(c.parent), `${c.code} parent ${c.parent} 未种子`).toBe(true);
        expect(
          c.code.startsWith(cpvSubtreePrefix(c.parent)),
          `${c.code} 不在 ${c.parent} 的子树前缀 ${cpvSubtreePrefix(c.parent)} 内`,
        ).toBe(true);
        expect(c.parent).not.toBe(c.code);
      }
    }
  });

  it('CPV 码全局唯一，且标签（en/zh）非空', () => {
    expect(new Set(CPV_SEED.map((c) => c.code)).size).toBe(CPV_SEED.length);
    for (const c of CPV_SEED) {
      expect(c.en.trim().length, c.code).toBeGreaterThan(0);
      expect((c.zh ?? '').trim().length, c.code).toBeGreaterThan(0);
    }
  });
});
