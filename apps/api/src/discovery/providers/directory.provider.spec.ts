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

  it('结果去重（同一串不重复出现）', () => {
    const searches = buildDirectorySearches(q({ industry: 'metalworking', region: 'France' }));
    expect(new Set(searches).size).toBe(searches.length);
  });
});
