import { describe, expect, it } from 'vitest';
import { buildDirectorySearches } from './directory.provider';
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
});
