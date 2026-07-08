import { describe, expect, it } from 'vitest';
import { resolveEvidenceLicense } from './evidence-license';

describe('§8.5 discovery 证据许可归一（resolveEvidenceLicense）', () => {
  it('记录声明许可优先（TED 绿事实 CC BY 4.0 署名义务）', () => {
    expect(resolveEvidenceLicense('CC BY 4.0', 'ted')).toBe('CC BY 4.0');
  });

  it('未声明 + sandbox → sandbox（既有行为不变）', () => {
    expect(resolveEvidenceLicense(undefined, 'sandbox')).toBe('sandbox');
  });

  it('未声明 + 其它 provider → licensed（既有行为字节级不变）', () => {
    expect(resolveEvidenceLicense(undefined, 'wikidata')).toBe('licensed');
    expect(resolveEvidenceLicense(undefined, 'public_web')).toBe('licensed');
  });

  it('未声明 + ted → licensed（不因 providerKey 静默假定许可，必须记录显式声明）', () => {
    expect(resolveEvidenceLicense(undefined, 'ted')).toBe('licensed');
  });

  it('声明可覆盖回退（如 CC0 源）', () => {
    expect(resolveEvidenceLicense('CC0-1.0', 'wikidata')).toBe('CC0-1.0');
  });
});
