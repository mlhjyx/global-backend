import { describe, expect, it } from 'vitest';
import {
  isFreeWebmailDomain,
  isSameCorporateGroupDomain,
  splitRegistrableDomain,
} from './corporate-group-domains';

describe('corporate-group-domains (L1 集团/母子公司域名同源校验)', () => {
  it('允许精确域、子域、经核验别名域与企业集团后缀变体', () => {
    expect(isSameCorporateGroupDomain('coesa.it', 'coesaenergy.it')).toBe(true);
    expect(isSameCorporateGroupDomain('coesaenergy.it', 'coesa.it')).toBe(true);
    expect(isSameCorporateGroupDomain('mail.acme.de', 'acme.de')).toBe(true);
    expect(isSameCorporateGroupDomain('solarplace.net', 'solarplace.it')).toBe(true);
    expect(
      isSameCorporateGroupDomain('parent-holding.com', 'subsidiary-brand.de', ['parent-holding.com']),
    ).toBe(true);
  });

  it('严格拒绝免费公共邮箱与无关域名', () => {
    expect(isFreeWebmailDomain('gmail.com')).toBe(true);
    expect(isFreeWebmailDomain('libero.it')).toBe(true);
    expect(isSameCorporateGroupDomain('gmail.com', 'coesaenergy.it')).toBe(false);
    expect(isSameCorporateGroupDomain('gmail.com', 'coesaenergy.it', ['gmail.com'])).toBe(false);
    expect(isSameCorporateGroupDomain('othercompany.it', 'coesaenergy.it')).toBe(false);
    expect(isSameCorporateGroupDomain('sol.it', 'solenergy.it')).toBe(false); // 词根过短 <5 拒绝
  });

  it('正确解析 .co.uk / .com.br 双段公共后缀', () => {
    expect(splitRegistrableDomain('www.epc.co.uk')).toEqual({
      root: 'epc',
      suffix: 'co.uk',
      registrable: 'epc.co.uk',
    });
    expect(splitRegistrableDomain('solar.com.br')).toEqual({
      root: 'solar',
      suffix: 'com.br',
      registrable: 'solar.com.br',
    });
  });
});
