import { describe, expect, it } from 'vitest';
import { resolveIcpToFda, buildFdaQuery, FdaTaxonomyPort, IcpToFdaResult } from './icp-to-fda';
import { CanonicalNode } from './taxonomy-resolver';

function node(code: string, fdaPanels?: string[], fdaProductCodes?: string[]): CanonicalNode {
  return { kind: 'industry', scheme: 'ISIC', code, labelEn: code, labels: null, wikidataQid: null, osmTags: null, crosswalks: { fdaPanels, fdaProductCodes } };
}

/** 结构化替身：注入行业节点 / 精修码 / 宽网码。 */
function port(opts: { nodes?: CanonicalNode[]; refined?: string | null; listed?: string[] }): FdaTaxonomyPort {
  return {
    resolveMany: async () => opts.nodes ?? [],
    resolveFdaProductCode: async () => opts.refined ?? null,
    listFdaProductCodes: async () => opts.listed ?? [],
  };
}

describe('resolveIcpToFda —— ICP → FDA 产品码（crosswalk 锚定 + panel 宽网/精修）', () => {
  it('行业 → panel（确定性），产品精修命中 → 单码', async () => {
    const r = await resolveIcpToFda(
      port({ nodes: [node('325', ['RA'])], refined: 'LLZ' }),
      { industryTerms: ['medical device'], product: 'radiological image processing' },
    );
    expect(r.panels).toEqual(['RA']);
    expect(r.productCodes).toEqual(['LLZ']);
  });

  it('无产品词 → panel 宽网（整专科码集）', async () => {
    const r = await resolveIcpToFda(
      port({ nodes: [node('325', ['RA'])], listed: ['LLZ', 'IZF', 'OXO'] }),
      { industryTerms: ['medical device'] },
    );
    expect(r.panels).toEqual(['RA']);
    expect(r.productCodes).toEqual(['LLZ', 'IZF', 'OXO']);
  });

  it('产品精修未命中（LLM null）→ 回退 panel 宽网（不空手）', async () => {
    const r = await resolveIcpToFda(
      port({ nodes: [node('325', ['RA'])], refined: null, listed: ['LLZ', 'IZF'] }),
      { industryTerms: ['medical device'], product: '不存在的设备' },
    );
    expect(r.productCodes).toEqual(['LLZ', 'IZF']);
  });

  it('直锚 product code（窄行业 crosswalk.fdaProductCodes）无需 panel 宽网', async () => {
    const r = await resolveIcpToFda(port({ nodes: [node('x', undefined, ['MNI'])] }), { industryTerms: ['pacemaker'] });
    expect(r.productCodes).toEqual(['MNI']);
  });

  it('行业归一但无 FDA crosswalk → warning（绝不静默）', async () => {
    const r = await resolveIcpToFda(port({ nodes: [node('01')] }), { industryTerms: ['farming'] });
    expect(r.productCodes).toEqual([]);
    expect(r.warnings.some((w) => w.includes('icp_seed_gap'))).toBe(true);
  });

  it('默认贸易侧 = 进口商（importerOnly）；显式 manufacturer → establishmentTypes', async () => {
    const imp = await resolveIcpToFda(port({ nodes: [node('325', ['RA'])], listed: ['LLZ'] }), { industryTerms: ['device'] });
    expect(imp.importerOnly).toBe(true);
    expect(imp.establishmentTypes).toEqual([]);
    const man = await resolveIcpToFda(port({ nodes: [node('325', ['RA'])], listed: ['LLZ'] }), { industryTerms: ['device'], tradeSide: 'manufacturer' });
    expect(man.importerOnly).toBe(false);
    expect(man.establishmentTypes).toEqual(['Manufacturer']);
  });

  it('allowLlm=false → 不精修，仍走确定性 panel 宽网', async () => {
    const r = await resolveIcpToFda(
      port({ nodes: [node('325', ['RA'])], refined: 'LLZ', listed: ['LLZ', 'IZF'] }),
      { industryTerms: ['device'], product: 'x-ray' },
      { allowLlm: false },
    );
    expect(r.productCodes).toEqual(['LLZ', 'IZF']); // 宽网，非精修单码
  });
});

describe('buildFdaQuery —— 注入 openFDA 发现查询', () => {
  const base: IcpToFdaResult = { productCodes: ['LLZ', 'IZF'], panels: ['RA'], importerOnly: true, establishmentTypes: [], warnings: [] };

  it('有 product code → 前置 openFDA 查询（source_hint + product_code + trade_side）', () => {
    const [q] = buildFdaQuery(base, []);
    expect(q.filters.source_hint).toBe('openfda');
    expect(q.filters.product_code).toBe('LLZ,IZF');
    expect(q.filters.trade_side).toBe('importer');
    expect(q.priority).toBe(1);
  });

  it('manufacturer 侧 → establishment_type 过滤、无 trade_side', () => {
    const [q] = buildFdaQuery({ ...base, importerOnly: false, establishmentTypes: ['Manufacturer'] }, []);
    expect(q.filters.establishment_type).toBe('Manufacturer');
    expect(q.filters.trade_side).toBeUndefined();
  });

  it('无码但有 warning → 附到首条 rationale（人工门可见，绝不静默）', () => {
    const planned = [{ source_class: 'public_intelligence', filters: {}, keywords: [], rationale: 'x', priority: 2 }];
    const out = buildFdaQuery({ ...base, productCodes: [], warnings: ['icp_seed_gap: 无码'] }, planned);
    expect(out).toHaveLength(1);
    expect(out[0].rationale).toContain('icp_fit_warning');
  });

  it('无码无 warning → 原样返回', () => {
    const planned = [{ source_class: 'x', filters: {}, keywords: [], rationale: 'x', priority: 1 }];
    expect(buildFdaQuery({ ...base, productCodes: [], warnings: [] }, planned)).toEqual(planned);
  });
});
