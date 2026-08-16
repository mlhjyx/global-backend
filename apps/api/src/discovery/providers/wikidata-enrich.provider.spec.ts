import { describe, expect, it, vi } from 'vitest';
import { parseCompanyFacts, referencedQids, RawEntity } from '../../adapters/wikidata';
import { WikidataEnrichmentProvider } from './wikidata-enrich.provider';
import type { ExecutionBroker } from '../../tools/tool-contract';

// 构造一个仿真的 Wikidata 实体（wbgetentities claims 结构）
function entityIdSnak(id: string) {
  return { mainsnak: { datavalue: { value: { id } } } };
}
function stringSnak(v: string) {
  return { mainsnak: { datavalue: { value: v } } };
}
function quantitySnak(amount: string, time?: string) {
  return {
    mainsnak: { datavalue: { value: { amount } } },
    ...(time ? { qualifiers: { P585: [{ datavalue: { value: { time } } }] } } : {}),
  };
}

const ACME: RawEntity = {
  labels: { en: { value: 'ACME Manufacturing AG' } },
  claims: {
    P31: [entityIdSnak('Q4830453')], // instance of: business
    P452: [entityIdSnak('Q100'), entityIdSnak('Q101')], // industries
    P1056: [entityIdSnak('Q200')], // product
    P1128: [quantitySnak('+1000', '+2019-01-01T00:00:00Z'), quantitySnak('+1500', '+2023-01-01T00:00:00Z')],
    P571: [{ mainsnak: { datavalue: { value: { time: '+1965-00-00T00:00:00Z' } } } }], // inception
    P749: [entityIdSnak('Q300')], // parent
    P355: [entityIdSnak('Q401'), entityIdSnak('Q402')], // subsidiaries (2)
    P1278: [stringSnak('529900T8BM49AURSDO55')],
    P1616: [stringSnak('552100554')],
    P856: [stringSnak('https://www.acme-mfg.example/')],
    P17: [entityIdSnak('Q183')], // country
  },
};

const REF_LABELS: Record<string, string> = {
  Q100: 'mechanical engineering',
  Q101: 'metalworking',
  Q200: 'laser cutting machine',
  Q300: 'ACME Holding',
  Q183: 'Germany',
};

describe('Wikidata claim 解析（parseCompanyFacts）', () => {
  const f = parseCompanyFacts('Q999', ACME, REF_LABELS);

  it('识别为公司（instance-of business + 公司性属性）', () => {
    expect(f.isCompany).toBe(true);
  });

  it('行业/产品经 refLabels 解析为可读名', () => {
    expect(f.industries).toEqual(['mechanical engineering', 'metalworking']);
    expect(f.products).toEqual(['laser cutting machine']);
  });

  it('员工数取最新时间限定的一条（1500@2023，而非 1000@2019）', () => {
    expect(f.employees).toBe(1500);
  });

  it('成立年从 P571 时间戳解析', () => {
    expect(f.inceptionYear).toBe(1965);
  });

  it('母公司名 + 子公司计数 + LEI + 官网 + 国家', () => {
    expect(f.parentName).toBe('ACME Holding');
    expect(f.subsidiaryCount).toBe(2);
    expect(f.lei).toBe('529900T8BM49AURSDO55');
    expect(f.siren).toBe('552100554');
    expect(f.website).toBe('https://www.acme-mfg.example/');
    expect(f.countryName).toBe('Germany');
  });

  it('referencedQids 收齐所有需解析标签的被引 QID', () => {
    const refs = referencedQids(ACME);
    for (const q of ['Q100', 'Q101', 'Q200', 'Q300', 'Q183']) expect(refs).toContain(q);
  });

  it('非公司实体（家族名：无公司性属性）isCompany=false', () => {
    const familyName: RawEntity = { labels: { en: { value: 'Trumpf' } }, claims: { P31: [entityIdSnak('Q101352')] } };
    expect(parseCompanyFacts('Q1', familyName, {}).isCompany).toBe(false);
  });
});

describe('Wikidata enrichment identity output', () => {
  it('把 QID 和可校验 LEI 交给 Identity v2，而不是只写画像字段', async () => {
    const invoke = vi.fn(async (_toolId: string, input: { op: string; props?: string }) => {
      if (input.op === 'search') return { data: { search: [{ qid: 'Q999', label: 'ACME Manufacturing AG' }] }, costCents: 0 };
      if (input.props === 'labels') {
        return { data: { entities: Object.fromEntries(Object.entries(REF_LABELS).map(([qid, value]) => [qid, { labels: { en: { value } } }])) }, costCents: 0 };
      }
      return { data: { entities: { Q999: ACME } }, costCents: 0 };
    });
    const broker = { checkSourcePolicy: vi.fn(), invoke } as unknown as ExecutionBroker;
    const result = await new WikidataEnrichmentProvider({ broker }).enrichCompany(
      { name: 'ACME Manufacturing AG', country: 'DE' },
      { workspaceId: 'ws-1' },
    );
    expect(result.identifiers).toEqual([
      { scheme: 'domain', jurisdiction: 'GLOBAL', value: 'acme-mfg.example' },
      { scheme: 'wikidata-qid', jurisdiction: 'GLOBAL', value: 'Q999' },
      { scheme: 'lei', jurisdiction: 'GLOBAL', value: '529900T8BM49AURSDO55' },
      { scheme: 'siren', jurisdiction: 'FR', value: '552100554' },
    ]);
  });

  it('已有 SIREN 时必须与 Wikidata 的同一字段吻合，拒绝把集团身份贴给同名法人', async () => {
    const invoke = vi.fn(async (_toolId: string, input: { op: string; props?: string }) => {
      if (input.op === 'search') return { data: { search: [{ qid: 'Q999', label: 'ACME Manufacturing AG' }] }, costCents: 0 };
      if (input.props === 'labels') {
        return { data: { entities: Object.fromEntries(Object.entries(REF_LABELS).map(([qid, value]) => [qid, { labels: { en: { value } } }])) }, costCents: 0 };
      }
      return { data: { entities: { Q999: ACME } }, costCents: 0 };
    });
    const provider = new WikidataEnrichmentProvider({ broker: { invoke } as unknown as ExecutionBroker });

    await expect(provider.enrichCompany(
      { name: 'ACME Manufacturing AG', country: 'DE', identifiers: [{ scheme: 'siren', jurisdiction: 'FR', value: '803086586' }] },
      { workspaceId: 'ws-1' },
    )).resolves.toMatchObject({ matched: false });
    await expect(provider.enrichCompany(
      { name: 'ACME Manufacturing AG', country: 'DE', identifiers: [{ scheme: 'siren', jurisdiction: 'FR', value: '552100554' }] },
      { workspaceId: 'ws-1' },
    )).resolves.toMatchObject({ matched: true });
  });

  it('跨国同名候选按国家过滤，候选顺序不影响结论', async () => {
    const us = structuredCompany('Acme Ltd', 'Q30', 'https://us-acme.example');
    const gb = structuredCompany('Acme Ltd', 'Q145', 'https://gb-acme.example');
    const run = async (order: string[]) => {
      const entities = { QUS: us, QGB: gb };
      const invoke = vi.fn(async (_toolId: string, input: { op: string; props?: string }) => {
        if (input.op === 'search') {
          return { data: { search: order.map((qid) => ({ qid, label: 'Acme Ltd' })) }, costCents: 0 };
        }
        if (input.props === 'labels') {
          return { data: { entities: {
            Q30: { labels: { en: { value: 'United States' } } },
            Q145: { labels: { en: { value: 'United Kingdom' } } },
          } }, costCents: 0 };
        }
        return { data: { entities }, costCents: 0 };
      });
      return new WikidataEnrichmentProvider({ broker: { invoke } as unknown as ExecutionBroker })
        .enrichCompany({ name: 'Acme Ltd', country: 'GB' }, { workspaceId: 'ws-1' });
    };

    await expect(run(['QUS', 'QGB'])).resolves.toMatchObject({
      matched: true,
      attributes: { qid: 'QGB', website: 'gb-acme.example' },
    });
    await expect(run(['QGB', 'QUS'])).resolves.toMatchObject({
      matched: true,
      attributes: { qid: 'QGB', website: 'gb-acme.example' },
    });
  });

  it('同国完全同名仍有两个候选时安全拒绝，不按搜索热度绑定', async () => {
    const entities = {
      Q1: structuredCompany('Acme Ltd', 'Q145', 'https://one.example'),
      Q2: structuredCompany('Acme Ltd', 'Q145', 'https://two.example'),
    };
    const invoke = vi.fn(async (_toolId: string, input: { op: string; props?: string }) => {
      if (input.op === 'search') return { data: { search: [{ qid: 'Q1', label: 'Acme Ltd' }, { qid: 'Q2', label: 'Acme Ltd' }] }, costCents: 0 };
      if (input.props === 'labels') return { data: { entities: { Q145: { labels: { en: { value: 'United Kingdom' } } } } }, costCents: 0 };
      return { data: { entities }, costCents: 0 };
    });
    const result = await new WikidataEnrichmentProvider({ broker: { invoke } as unknown as ExecutionBroker })
      .enrichCompany({ name: 'Acme Ltd', country: 'GB' }, { workspaceId: 'ws-1' });
    expect(result.matched).toBe(false);
  });

  it('没有国家也没有已有域名时安全拒绝名称强绑定', async () => {
    const invoke = vi.fn();
    const result = await new WikidataEnrichmentProvider({ broker: { invoke } as unknown as ExecutionBroker })
      .enrichCompany({ name: 'Acme Ltd' }, { workspaceId: 'ws-1' });
    expect(result.matched).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

function structuredCompany(label: string, countryQid: string, website: string): RawEntity {
  return {
    labels: { en: { value: label } },
    claims: {
      P31: [entityIdSnak('Q4830453')],
      P17: [entityIdSnak(countryQid)],
      P856: [stringSnak(website)],
      P1128: [quantitySnak('+10')],
    },
  };
}
