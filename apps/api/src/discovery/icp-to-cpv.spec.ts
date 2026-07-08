import { describe, expect, it, vi } from 'vitest';
import { resolveIcpToCpv, TED_COVERAGE, CpvTaxonomyPort, buildTedQuery, PlanQueryShape } from './icp-to-cpv';
import { CanonicalNode } from './taxonomy-resolver';

function node(kind: string, code: string, crosswalks: Record<string, unknown>): CanonicalNode {
  return {
    kind,
    scheme: kind === 'country' ? 'ISO3166_1' : 'ISIC',
    code,
    labelEn: code,
    labels: null,
    wikidataQid: null,
    osmTags: null,
    crosswalks: crosswalks as never,
  };
}

function fakePort(over: Partial<CpvTaxonomyPort> = {}): CpvTaxonomyPort {
  return {
    resolveMany: async () => [],
    resolve: async () => null,
    resolveCpvForProduct: async () => null,
    ...over,
  };
}

describe('resolveIcpToCpv（ICP→CPV 冷路径映射，多租户不硬编码）', () => {
  it('确定性无产品路径：industry crosswalk.cpv + country alpha3 → cpv + buyer_country', async () => {
    const port = fakePort({
      resolveMany: async (kind) => (kind === 'industry' ? [node('industry', '28', { cpv: ['42120000'] })] : []),
      resolve: async (kind, term) =>
        kind === 'country' && /germany/i.test(term) ? node('country', 'DE', { alpha3: ['DEU'] }) : null,
    });
    const r = await resolveIcpToCpv(port, { industryTerms: ['pumps'], targetCountries: ['Germany'] }, { allowLlm: false });
    expect(r.cpvCodes).toContain('42120000');
    expect(r.buyerCountries).toEqual(['DEU']);
    expect(r.warnings).toEqual([]);
  });

  it('覆盖门：目标国非 EU/EEA/UK → buyer_country 空 + icp_fit_warning（绝不静默丢）', async () => {
    const port = fakePort({
      resolveMany: async () => [node('industry', '28', { cpv: ['42120000'] })],
      resolve: async () => node('country', 'US', { alpha3: ['USA'] }),
    });
    const r = await resolveIcpToCpv(port, { industryTerms: ['pumps'], targetCountries: ['United States'] }, { allowLlm: false });
    expect(r.buyerCountries).toEqual([]);
    expect(r.warnings.some((w) => /icp_fit_warning/.test(w) && /United States/.test(w))).toBe(true);
  });

  it('industry 命中但无 crosswalk.cpv → cpvCodes 空 + 种子缺口 warning，不抛', async () => {
    const port = fakePort({
      resolveMany: async () => [node('industry', '28', { nace: ['28.13'] })],
      resolve: async () => node('country', 'DE', { alpha3: ['DEU'] }),
    });
    const r = await resolveIcpToCpv(port, { industryTerms: ['machinery'], targetCountries: ['Germany'] }, { allowLlm: false });
    expect(r.cpvCodes).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('多 industry 的 cpv 并集去重', async () => {
    const port = fakePort({
      resolveMany: async () => [
        node('industry', '28', { cpv: ['42120000', '42130000'] }),
        node('industry', '29', { cpv: ['42120000'] }),
      ],
      resolve: async () => node('country', 'DE', { alpha3: ['DEU'] }),
    });
    const r = await resolveIcpToCpv(port, { industryTerms: ['pumps', 'valves'], targetCountries: ['Germany'] }, { allowLlm: false });
    expect([...r.cpvCodes].sort()).toEqual(['42120000', '42130000']);
  });

  it('产品精修：命中子树内 8 位码替换宽网候选（LLM 枚举限于 crosswalk 子树）', async () => {
    const spy = vi.fn(async (_product: string, prefixes: string[]) => {
      expect(prefixes).toContain('42120000');
      return '42122130';
    });
    const port = fakePort({
      resolveMany: async () => [node('industry', '28', { cpv: ['42120000'] })],
      resolve: async () => node('country', 'DE', { alpha3: ['DEU'] }),
      resolveCpvForProduct: spy,
    });
    const r = await resolveIcpToCpv(
      port,
      { industryTerms: ['pumps'], product: 'water pump', targetCountries: ['Germany'] },
      { allowLlm: true },
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(r.cpvCodes).toEqual(['42122130']);
  });

  it('产品精修未命中 → 回退宽网 crosswalk 候选（不空手）', async () => {
    const port = fakePort({
      resolveMany: async () => [node('industry', '28', { cpv: ['42120000'] })],
      resolve: async () => node('country', 'DE', { alpha3: ['DEU'] }),
      resolveCpvForProduct: async () => null,
    });
    const r = await resolveIcpToCpv(
      port,
      { industryTerms: ['pumps'], product: 'exotic gizmo', targetCountries: ['Germany'] },
      { allowLlm: true },
    );
    expect(r.cpvCodes).toEqual(['42120000']);
  });

  it('无法解析的目标国 → warning，不静默丢', async () => {
    const port = fakePort({
      resolveMany: async () => [node('industry', '28', { cpv: ['42120000'] })],
      resolve: async () => null,
    });
    const r = await resolveIcpToCpv(port, { industryTerms: ['pumps'], targetCountries: ['Ruritania'] }, { allowLlm: false });
    expect(r.buyerCountries).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('TED_COVERAGE 含 DEU 不含 USA', () => {
    expect(TED_COVERAGE.has('DEU')).toBe(true);
    expect(TED_COVERAGE.has('USA')).toBe(false);
  });
});

describe('buildTedQuery（§8.7 计划注入，纯函数）', () => {
  const web: PlanQueryShape = { source_class: 'public_intelligence', filters: { industry: 'x' }, keywords: [], rationale: 'web', priority: 2 };

  it('有 cpv + 覆盖国 → 前置 TED 查询（priority 1，source_hint=ted）', () => {
    const out = buildTedQuery({ cpvCodes: ['42120000'], buyerCountries: ['DEU'], warnings: [] }, [web]);
    expect(out).toHaveLength(2);
    expect(out[0].filters.source_hint).toBe('ted');
    expect(out[0].filters.cpv).toBe('42120000');
    expect(out[0].filters.buyer_country).toBe('DEU');
    expect(out[0].priority).toBe(1);
    expect(out[1]).toBe(web);
  });

  it('多码/多国 → 逗号拼接 filters', () => {
    const out = buildTedQuery({ cpvCodes: ['42120000', '42122000'], buyerCountries: ['DEU', 'FRA'], warnings: [] }, []);
    expect(out[0].filters.cpv).toBe('42120000,42122000');
    expect(out[0].filters.buyer_country).toBe('DEU,FRA');
  });

  it('无可用 CPV/国别但有 warning → 不注入 TED，warning 附首条 rationale（绝不静默）', () => {
    const out = buildTedQuery({ cpvCodes: [], buyerCountries: [], warnings: ['icp_fit_warning: X'] }, [web]);
    expect(out).toHaveLength(1);
    expect(out[0].rationale).toContain('icp_fit_warning');
    expect(out.some((q) => q.filters.source_hint === 'ted')).toBe(false);
  });

  it('有 cpv 但无覆盖国 → 不注入 TED（TED 需 buyer_country）', () => {
    const out = buildTedQuery({ cpvCodes: ['42120000'], buyerCountries: [], warnings: ['icp_fit_warning: US'] }, [web]);
    expect(out.some((q) => q.filters.source_hint === 'ted')).toBe(false);
    expect(out[0].rationale).toContain('icp_fit_warning');
  });

  it('无码无 warning → 原样返回', () => {
    const out = buildTedQuery({ cpvCodes: [], buyerCountries: [], warnings: [] }, [web]);
    expect(out).toEqual([web]);
  });
});
