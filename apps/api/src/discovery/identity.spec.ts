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

describe('§8.4 identifier 身份规则（税号/注册号）—— 优先级 domain > identifier > name+country', () => {
  it('无域名 + identifier → identifier_exact（scheme:归一值）', () => {
    expect(
      companyIdentity({ name: 'SPIE GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE 291499156' } }),
    ).toEqual({ dedupeKey: 'id:ted-natid:de291499156', matchRule: 'identifier_exact' });
  });

  it('有域名时 domain 仍压过 identifier（域名最强）', () => {
    const k = companyIdentity({
      name: 'SPIE',
      domain: 'spie.de',
      identifier: { scheme: 'ted-natid', value: 'DE 291499156' },
    });
    expect(k).toEqual({ dedupeKey: 'd:spie.de', matchRule: 'domain_exact' });
  });

  it('同名同国、identifier 不同 → 不同 key（根治 §8.4 误并）', () => {
    const a = companyIdentity({ name: 'Müller GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE111' } });
    const b = companyIdentity({ name: 'Müller GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE222' } });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('同值不同 scheme（ted-natid vs lei）→ 不同 key（绝不跨 id 体系串号）', () => {
    const a = companyIdentity({ name: 'X', country: 'DE', identifier: { scheme: 'ted-natid', value: '529900X' } });
    const b = companyIdentity({ name: 'X', country: 'DE', identifier: { scheme: 'lei', value: '529900X' } });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('空/空白 identifier 值 → 回退 name_country（不产生 id:scheme: 空 key）', () => {
    expect(companyIdentity({ name: 'Acme GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: '  ' } })).toEqual({
      dedupeKey: 'n:acme:de',
      matchRule: 'name_country',
    });
  });
});
