import { describe, expect, it } from 'vitest';
import { buildDirectorySearches, isDirectoryListingShaped } from './directory.provider';
import { CompanyDiscoveryQuery } from '../provider-contract';

function q(filters: Record<string, unknown>, keywords: string[] = []): CompanyDiscoveryQuery {
  return { sourceClass: 'industry_data', filters, keywords, limit: 40 };
}

describe('名录发现检索串构造', () => {
  it('行业 × 意图词（EN+DE）× 地区，去重且非空', () => {
    const searches = buildDirectorySearches(q({ industry: 'sheet metal working', region: 'Germany' }, ['laser cutting']));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.length).toBeLessThanOrEqual(4);
    // 覆盖协会名录（EN）与德语意图词
    expect(searches.some((s) => /members directory|member companies/i.test(s))).toBe(true);
    expect(searches.some((s) => /Mitglied/i.test(s))).toBe(true);
    // 主题词与地区注入
    expect(searches.every((s) => /sheet metal working|laser cutting/i.test(s))).toBe(true);
    expect(searches.every((s) => /Germany/.test(s))).toBe(true);
  });

  it('无地区时也能构造（不拼空串）', () => {
    const searches = buildDirectorySearches(q({ industry: 'automotive' }));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((s) => s.trim().length > 5)).toBe(true);
    expect(searches.some((s) => s.includes('  '))).toBe(false); // 无双空格（空段被过滤）
  });

  it('无行业时回退到关键词/默认词', () => {
    const searches = buildDirectorySearches(q({}, ['CNC machining']));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((s) => /CNC machining/i.test(s))).toBe(true);
  });

  it('中文行业词、地区词不进检索串，地区换成目标国的当地名称', () => {
    const searches = buildDirectorySearches(q({ industry: '工业泵', country: '德国' }, ['Pumpen Großhandel', '泵 批发']));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.join(' | ')).not.toMatch(/\p{Script=Han}/u);
    expect(searches.every((s) => /Pumpen Großhandel/.test(s) && /Deutschland/.test(s))).toBe(true);
    expect(searches.some((s) => s.includes('Pumpen Großhandel Pumpen Großhandel'))).toBe(false);
  });

  it('主题词全是中文时不构造检索串，也不退回通用的 manufacturing', () => {
    expect(buildDirectorySearches(q({ industry: '工业泵', country: '德国' }, ['泵 批发']))).toEqual([]);
    expect(buildDirectorySearches(q({ industry: '', country: '德国' }, ['泵 批发']))).toEqual([]);
    expect(buildDirectorySearches(q({ industry: ['工业泵', ''] }, ['', '泵']))).toEqual([]);
  });

  it('给了地理范围却写不出当地名称时不检索，避免全球名录', () => {
    expect(buildDirectorySearches(q({ industry: 'pumps', country: '加拿大' }))).toEqual([]);
  });

  it('中文地区词让位给可用的拉丁文国家词', () => {
    const searches = buildDirectorySearches(q({ industry: 'pumps', region: '巴伐利亚', country: 'Japan' }));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((s) => /Japan/.test(s) && !/\p{Script=Han}/u.test(s))).toBe(true);
  });

  it('结果去重（同一串不重复出现）', () => {
    const searches = buildDirectorySearches(q({ industry: 'metalworking', region: 'France' }));
    expect(new Set(searches).size).toBe(searches.length);
  });

  // 2026-11-06：中文市场回归——旧版把中文主题词整段剥掉，检索退化为
  // "manufacturing members directory 中国"，真实 ICP 两轮 10 查询零名录页。
  it('中文市场保留中文主题词、配中文名录意图词与中文地区词', () => {
    const searches = buildDirectorySearches(
      q({ industry: '电子元件制造', region: '珠三角', country: '中国' }, ['线路板制造', '精密电子零件']),
    );
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.length).toBeLessThanOrEqual(4);
    // 每条都带中文名录意图词，且以中文主题词开头（不退化成 manufacturing）
    expect(
      searches.every((s) => /企业名录|企业黄页|参展商名单|供应商目录/.test(s)),
    ).toBe(true);
    expect(searches.every((s) => /电子元件制造/.test(s))).toBe(true);
    expect(searches.every((s) => /珠三角/.test(s))).toBe(true);
    expect(searches.join(' | ')).not.toMatch(/manufacturing|members directory|Mitglied/i);
  });

  it('中文市场只有中文关键词（无行业）时也能构造检索串', () => {
    const searches = buildDirectorySearches(q({ country: '中国' }, ['电子元件制造']));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((s) => /电子元件制造/.test(s))).toBe(true);
  });

  it('名录/黄页相貌识别覆盖中文标题与 URL', () => {
    expect(isDirectoryListingShaped('https://www.example.cn/企业名录/', '')).toBe(true);
    expect(isDirectoryListingShaped('https://www.huangye88.com/shandong/', '黄页88 - 企业黄页')).toBe(true);
    expect(isDirectoryListingShaped('https://x.example.com/a', '中国电子元件企业大全')).toBe(true);
    expect(isDirectoryListingShaped('https://x.example.com/a', '参展商名单 | 2026 展会')).toBe(true);
    expect(isDirectoryListingShaped('https://baike.baidu.com/item/电子', '电子元件 - 百科')).toBe(false);
  });
});
