import { describe, it, expect } from 'vitest';
import { normalizeJurisdiction } from './jurisdiction';

/**
 * 国别归一（Codex P1 on PR #72）：收 alpha-2 / ISO alpha-3 / 常见英文国名 → 有限法域集。
 * 核心回归守：CHN/China 必须归 CN、DEU/Germany 必须归 EU、GBR/United Kingdom 归 UK——
 * 否则存储权利判定会漏掉 CN(ALLOW_WITH_BASIS) 与跨境(REQUIRE_APPROVAL) 规则。
 */
describe('normalizeJurisdiction', () => {
  it('alpha-2 保持既有语义（GB/UK→UK, US→US, CN→CN, DE→EU, 未知→OTHER）', () => {
    expect(normalizeJurisdiction('GB')).toBe('UK');
    expect(normalizeJurisdiction('UK')).toBe('UK');
    expect(normalizeJurisdiction('US')).toBe('US');
    expect(normalizeJurisdiction('CN')).toBe('CN');
    expect(normalizeJurisdiction('DE')).toBe('EU');
    expect(normalizeJurisdiction('NO')).toBe('EU'); // EEA
    expect(normalizeJurisdiction('BR')).toBe('OTHER');
  });

  it('ISO alpha-3 归一（CHN→CN, DEU→EU, GBR→UK, USA→US, NOR→EU, 未知 BRA→OTHER）', () => {
    expect(normalizeJurisdiction('CHN')).toBe('CN');
    expect(normalizeJurisdiction('DEU')).toBe('EU');
    expect(normalizeJurisdiction('FRA')).toBe('EU');
    expect(normalizeJurisdiction('GBR')).toBe('UK');
    expect(normalizeJurisdiction('USA')).toBe('US');
    expect(normalizeJurisdiction('NOR')).toBe('EU'); // EEA
    expect(normalizeJurisdiction('BRA')).toBe('OTHER');
  });

  it('常见英文国名归一（China→CN, Germany→EU, United Kingdom→UK, United States→US, 未知→OTHER）', () => {
    expect(normalizeJurisdiction('China')).toBe('CN');
    expect(normalizeJurisdiction('Germany')).toBe('EU');
    expect(normalizeJurisdiction('France')).toBe('EU');
    expect(normalizeJurisdiction('United Kingdom')).toBe('UK');
    expect(normalizeJurisdiction('Great Britain')).toBe('UK');
    expect(normalizeJurisdiction('United States')).toBe('US');
    expect(normalizeJurisdiction('United States of America')).toBe('US');
    expect(normalizeJurisdiction('Brazil')).toBe('OTHER');
  });

  it('大小写/空白无关', () => {
    expect(normalizeJurisdiction('  chn ')).toBe('CN');
    expect(normalizeJurisdiction('germany')).toBe('EU');
    expect(normalizeJurisdiction('CHINA')).toBe('CN');
  });

  it('空/缺失 → OTHER', () => {
    expect(normalizeJurisdiction(null)).toBe('OTHER');
    expect(normalizeJurisdiction(undefined)).toBe('OTHER');
    expect(normalizeJurisdiction('')).toBe('OTHER');
    expect(normalizeJurisdiction('   ')).toBe('OTHER');
  });
});
