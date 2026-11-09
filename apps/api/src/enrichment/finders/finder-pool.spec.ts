import { describe, expect, it } from 'vitest';
import {
  resolveConfiguredFinderProviders,
  resolveConfiguredTailFinderProviders,
} from './finder-pool';

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

describe('resolveConfiguredTailFinderProviders（P1-09 可选尾）', () => {
  it('主池与尾部独立：尾部按 Apollo → PDL 顺序，只收已配置凭据者', () => {
    expect(
      resolveConfiguredTailFinderProviders({ APOLLO_API_KEY: 'a', PDL_API_KEY: 'p' }).map(
        (provider) => provider.key,
      ),
    ).toEqual(['apollo', 'pdl']);
    expect(resolveConfiguredTailFinderProviders({ PDL_API_KEY: 'p' }).map((provider) => provider.key)).toEqual([
      'pdl',
    ]);
    expect(resolveConfiguredTailFinderProviders({})).toEqual([]);
    // 尾部不进主池（仅 A 档追加，不对全量开启）。
    expect(
      resolveConfiguredFinderProviders({ APOLLO_API_KEY: 'a', PDL_API_KEY: 'p' }),
    ).toEqual([]);
  });

  it('尾部域名与 class 契约（api.peopledatalabs.com 为官方域，计划笔误 peerdatalab）', () => {
    const tail = resolveConfiguredTailFinderProviders({ APOLLO_API_KEY: 'a', PDL_API_KEY: 'p' });
    expect(tail.map((provider) => provider.domain)).toEqual([
      'api.apollo.io',
      'api.peopledatalabs.com',
    ]);
    expect(tail.every((provider) => provider.class === 'b2b_company_person')).toBe(true);
  });
});
