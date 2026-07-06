import { describe, expect, it } from 'vitest';
import { parseCompanyFacts, referencedQids, RawEntity } from '../../adapters/wikidata';

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
    P1278: [stringSnak('529900TESTLEI0000ACME')],
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
    expect(f.lei).toBe('529900TESTLEI0000ACME');
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
