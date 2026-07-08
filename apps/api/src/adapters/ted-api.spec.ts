import { describe, expect, it } from 'vitest';
import { buildAwardQuery, mapAwardNotice } from './ted-api';

describe('TED expert query 构造（buildAwardQuery）', () => {
  it('单 CPV + 单国：= 算子 + notice-type + 相对日期 + SORT DESC', () => {
    const q = buildAwardQuery({ cpvCodes: ['42120000'], buyerCountries: ['DEU'] });
    expect(q).toBe(
      'classification-cpv=42120000 AND buyer-country=DEU AND notice-type=can-standard ' +
        'AND publication-date>=today(-30) SORT BY publication-date DESC',
    );
  });

  it('多 CPV + 多国：IN (...) 空格分隔、括号', () => {
    const q = buildAwardQuery({ cpvCodes: ['42120000', '42122000'], buyerCountries: ['DEU', 'FRA'] });
    expect(q).toContain('classification-cpv IN (42120000 42122000)');
    expect(q).toContain('buyer-country IN (DEU FRA)');
    expect(q).toContain('notice-type=can-standard');
    expect(q.endsWith('SORT BY publication-date DESC')).toBe(true);
  });

  it('无国别过滤时省略 buyer-country 子句（不拼空串）', () => {
    const q = buildAwardQuery({ cpvCodes: ['42120000'] });
    expect(q).not.toContain('buyer-country');
    expect(q).toContain('classification-cpv=42120000');
  });

  it('国别统一大写为 ISO-3', () => {
    const q = buildAwardQuery({ cpvCodes: ['42120000'], buyerCountries: ['deu'] });
    expect(q).toContain('buyer-country=DEU');
  });

  it('自定义 sinceDays 落进相对日期函数', () => {
    const q = buildAwardQuery({ cpvCodes: ['42120000'], sinceDays: 90 });
    expect(q).toContain('publication-date>=today(-90)');
  });

  it('CPV 前缀通配 421* 原样透传', () => {
    const q = buildAwardQuery({ cpvCodes: ['421*'] });
    expect(q).toContain('classification-cpv=421*');
  });

  it('空 CPV 抛错（TED 发现必须带分类过滤，绝不裸拉全库）', () => {
    expect(() => buildAwardQuery({ cpvCodes: [] })).toThrow();
  });
});

describe('TED 中标公告映射（mapAwardNotice）—— 多语言解包 / 缺键当 null / 别天真 zip', () => {
  it('多语言对象 eng 优先解包 winner-name', () => {
    const n = mapAwardNotice({
      'publication-number': '123456-2026',
      'winner-name': { eng: ['Acme Pumps Ltd'], deu: ['Acme Pumpen GmbH'] },
      'winner-country': ['DEU'],
    });
    expect(n.winners).toHaveLength(1);
    expect(n.winners[0].name).toBe('Acme Pumps Ltd');
    expect(n.winners[0].country).toBe('DEU');
  });

  it('无 eng 键时回退到该 notice 自身语言', () => {
    const n = mapAwardNotice({
      'winner-name': { hun: ['GRUNDFOS South East Europe Kft.'] },
      'winner-country': ['HUN'],
    });
    expect(n.winners[0].name).toBe('GRUNDFOS South East Europe Kft.');
  });

  it('缺 winner-name 键 → winners 为空（缺键当 null，不臆造）', () => {
    const n = mapAwardNotice({ 'publication-number': '999-2026', 'buyer-country': ['DEU'] });
    expect(n.winners).toEqual([]);
    expect(n.buyerCountries).toEqual(['DEU']);
  });

  it('多中标方：country/identifier 按位对齐（per-winner 数组）', () => {
    const n = mapAwardNotice({
      'winner-name': { eng: ['Alpha AG', 'Beta SA'] },
      'winner-country': ['DEU', 'FRA'],
      'winner-identifier': ['DE111', 'FR222'],
    });
    expect(n.winners.map((w) => w.name)).toEqual(['Alpha AG', 'Beta SA']);
    expect(n.winners[0].identifier).toBe('DE111');
    expect(n.winners[1].country).toBe('FRA');
  });

  it('单中标方 + 单 URL → URL 归属该方（可做域名 key）', () => {
    const n = mapAwardNotice({
      'winner-name': { eng: ['Acme Pumps Ltd'] },
      'winner-internet-address': ['https://acme-pumps.example'],
    });
    expect(n.winners[0].internetAddress).toBe('https://acme-pumps.example');
  });

  it('多中标方但 URL 数不匹配 → 不臆造归属（绝不贴错身份）', () => {
    const n = mapAwardNotice({
      'winner-name': { eng: ['Alpha AG', 'Beta SA'] },
      'winner-internet-address': ['https://only-one.example'],
    });
    expect(n.winners[0].internetAddress).toBeUndefined();
    expect(n.winners[1].internetAddress).toBeUndefined();
  });

  it('多中标方 + URL 数相等 → 按位对齐', () => {
    const n = mapAwardNotice({
      'winner-name': { eng: ['Alpha AG', 'Beta SA'] },
      'winner-internet-address': ['https://alpha.example', 'https://beta.example'],
    });
    expect(n.winners[0].internetAddress).toBe('https://alpha.example');
    expect(n.winners[1].internetAddress).toBe('https://beta.example');
  });

  it('提取 CPV / buyer / notice 元字段（标量与数组）', () => {
    const n = mapAwardNotice({
      'publication-number': '123456-2026',
      'publication-date': '2026-07-08+02:00',
      'notice-type': 'can-standard',
      'form-type': 'result',
      'classification-cpv': ['42120000', '42122000'],
      'buyer-name': { eng: ['City of Munich'] },
      'buyer-country': ['DEU'],
      'winner-name': { eng: ['Acme Pumps Ltd'] },
    });
    expect(n.publicationNumber).toBe('123456-2026');
    expect(n.publicationDate).toBe('2026-07-08+02:00');
    expect(n.noticeType).toBe('can-standard');
    expect(n.cpvCodes).toEqual(['42120000', '42122000']);
    expect(n.buyerNames).toEqual(['City of Munich']);
    expect(n.buyerCountries).toEqual(['DEU']);
  });
});
