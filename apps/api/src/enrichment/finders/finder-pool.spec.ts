import { describe, expect, it } from 'vitest';
import { resolveConfiguredFinderProviders } from './finder-pool';

/**
 * P1-07：finder 池——顺序即瀑布顺序（Hunter → Findymail → Prospeo），
 * 且缺凭据的 finder 不进入池（瀑布不浪费一次调用去确认 unconfigured）。
 */
describe('resolveConfiguredFinderProviders', () => {
  it('三家都有 key → 按瀑布顺序返回；单家缺 key → 被剔除且不改变其余顺序', () => {
    expect(
      resolveConfiguredFinderProviders({
        HUNTER_API_KEY: 'h',
        FINDYMAIL_API_KEY: 'f',
        PROSPEO_API_KEY: 'p',
      }).map((provider) => provider.key),
    ).toEqual(['hunter', 'findymail', 'prospeo']);
    expect(
      resolveConfiguredFinderProviders({
        FINDYMAIL_API_KEY: 'f',
        PROSPEO_API_KEY: 'p',
      }).map((provider) => provider.key),
    ).toEqual(['findymail', 'prospeo']);
    expect(resolveConfiguredFinderProviders({})).toEqual([]);
  });

  it('每个 adapter 的 source_policy 域名与 class 正确（登记面契约）', () => {
    const pool = resolveConfiguredFinderProviders({
      HUNTER_API_KEY: 'h',
      FINDYMAIL_API_KEY: 'f',
      PROSPEO_API_KEY: 'p',
    });
    expect(pool.map((provider) => provider.domain)).toEqual([
      'api.hunter.io',
      'api.findymail.com',
      'api.prospeo.io',
    ]);
    expect(pool.every((provider) => provider.class === 'b2b_company_person')).toBe(true);
  });
});
