import { describe, expect, it } from 'vitest';
import { companyIdentity, normalizeCompanyName, normalizeDomain } from './identity';

describe('identity resolution（PRD 8.8 确定性规则）', () => {
  it('域名规范化：协议/www/路径剥离', () => {
    expect(normalizeDomain('https://www.Acme-Tech.COM/en/about')).toBe('acme-tech.com');
    expect(normalizeDomain(null)).toBeNull();
  });

  it('公司名规范化：法律后缀剥离 + 大小写', () => {
    expect(normalizeCompanyName('Acme Manufacturing GmbH')).toBe('acme manufacturing');
    expect(normalizeCompanyName('深圳精密制造有限公司')).toBe('深圳精密制造');
  });

  it('有域名 → domain_exact；无域名 → name_country', () => {
    expect(companyIdentity({ name: 'Acme', domain: 'acme.com' })).toEqual({
      dedupeKey: 'd:acme.com',
      matchRule: 'domain_exact',
    });
    expect(companyIdentity({ name: 'Acme GmbH', country: 'DE' })).toEqual({
      dedupeKey: 'n:acme:de',
      matchRule: 'name_country',
    });
  });

  it('同公司不同来源（www 变体）解析到同一 dedupeKey', () => {
    const a = companyIdentity({ name: 'Acme', domain: 'www.acme.com' });
    const b = companyIdentity({ name: 'ACME Inc.', domain: 'https://acme.com' });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});
