import { describe, expect, it } from 'vitest';
import { resolveIcpToNaics, NaicsTaxonomyPort } from './icp-to-naics';
import { CanonicalNode } from './taxonomy-resolver';

function node(code: string, naics?: string[]): CanonicalNode {
  return { kind: 'industry', scheme: 'ISIC', code, labelEn: code, labels: null, wikidataQid: null, osmTags: null, crosswalks: { naics } };
}

/** 结构化替身：注入行业节点 / 精修码。 */
function port(opts: { nodes?: CanonicalNode[]; refined?: string | null }): NaicsTaxonomyPort {
  return {
    resolveMany: async () => opts.nodes ?? [],
    resolveNaicsForProduct: async () => opts.refined ?? null,
  };
}

describe('resolveIcpToNaics —— ICP → NAICS（crosswalk 锚定 + product 精修 + US 市场门）', () => {
  it('行业 → NAICS crosswalk（确定性），产品精修命中 → 单码', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])], refined: '333914' }),
      { industryTerms: ['pumps'], product: 'centrifugal pumps' },
    );
    expect(r.naicsCodes).toEqual(['333914']);
  });

  it('无产品词 → crosswalk 宽网（锚候选码集）', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339', '3345'])] }),
      { industryTerms: ['machinery'] },
    );
    expect(r.naicsCodes).toEqual(['3339', '3345']);
  });

  it('产品精修未命中（LLM null）→ 回退宽网候选（不空手）', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])], refined: null }),
      { industryTerms: ['pumps'], product: '不存在的产品' },
    );
    expect(r.naicsCodes).toEqual(['3339']);
  });

  it('多行业 crosswalk 并集去重', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339']), node('266', ['334517', '3339'])] }),
      { industryTerms: ['pumps', 'radiology'] },
    );
    expect(r.naicsCodes.sort()).toEqual(['334517', '3339'].sort());
  });

  it('行业归一但无 NAICS crosswalk → warning（绝不静默）', async () => {
    const r = await resolveIcpToNaics(port({ nodes: [node('01')] }), { industryTerms: ['farming'] });
    expect(r.naicsCodes).toEqual([]);
    expect(r.warnings.some((w) => w.includes('icp_seed_gap'))).toBe(true);
  });

  it('US 市场门：非美国目标市场 → 不注入（SAM 仅美国联邦）+ warning', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])] }),
      { industryTerms: ['pumps'], targetCountries: ['Germany', 'France'] },
    );
    expect(r.naicsCodes).toEqual([]);
    expect(r.warnings.some((w) => w.includes('仅覆盖美国'))).toBe(true);
  });

  it('US 市场门：目标含美国 或 无目标 → 正常解析', async () => {
    const us = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])] }),
      { industryTerms: ['pumps'], targetCountries: ['US', 'Germany'] },
    );
    expect(us.naicsCodes).toEqual(['3339']);
    const any = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])] }),
      { industryTerms: ['pumps'], targetCountries: [] },
    );
    expect(any.naicsCodes).toEqual(['3339']);
  });

  it('allowLlm=false → 不精修，仍走确定性宽网', async () => {
    const r = await resolveIcpToNaics(
      port({ nodes: [node('281', ['3339'])], refined: '333914' }),
      { industryTerms: ['pumps'], product: 'x' },
      { allowLlm: false },
    );
    expect(r.naicsCodes).toEqual(['3339']); // 宽网，非精修单码
  });
});
