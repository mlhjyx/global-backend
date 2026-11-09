import { describe, expect, it } from 'vitest';
import { resolveConfiguredVerificationProviders } from './provider-pool';

describe('resolveConfiguredVerificationProviders', () => {
  it('无凭据 → 空池（瀑布不会出现 provider_unconfigured 空转）', () => {
    expect(resolveConfiguredVerificationProviders({})).toEqual([]);
  });

  it('只有 MillionVerifier key → 单元素池（主验）', () => {
    const providers = resolveConfiguredVerificationProviders({ MILLIONVERIFIER_API_KEY: 'mv' });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier']);
  });

  it('两家 key 都在 → 固定顺序 [millionverifier, emailable]（主验在前）', () => {
    const providers = resolveConfiguredVerificationProviders({
      MILLIONVERIFIER_API_KEY: 'mv',
      EMAILABLE_API_KEY: 'em',
    });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier', 'emailable']);
  });

  it('ZeroBounce 作为仲裁席排在最后；Truelist 不入池（解析分支未接线）', () => {
    const providers = resolveConfiguredVerificationProviders({
      MILLIONVERIFIER_API_KEY: 'mv',
      EMAILABLE_API_KEY: 'em',
      ZEROBOUNCE_API_KEY: 'zb',
      TRUELIST_API_KEY: 'tl',
    });
    expect(providers.map((p) => p.key)).toEqual(['millionverifier', 'emailable', 'zerobounce']);
  });

  it('Emailable 单独配置也可用（主验降级但仍能出单票 UNKNOWN）', () => {
    const providers = resolveConfiguredVerificationProviders({ EMAILABLE_API_KEY: 'em' });
    expect(providers.map((p) => p.key)).toEqual(['emailable']);
  });
});
