import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCOVERY_PROVIDER_RECORDS_MAX,
  MAX_COMPANY_DISCOVERY_ADAPTERS,
  MAX_DISCOVERY_FIT_COMPANIES,
  MAX_DISCOVERY_PLAN_QUERIES,
  MAX_DISCOVERY_PROVIDER_RECORDS,
  UNCAPPED_DISCOVERY_PROVIDER_RECORDS,
  discoveryUncappedEnabled,
  resolveMaxDiscoveryProviderRecords,
} from './execution-envelope';

const off = {} as NodeJS.ProcessEnv;
const on = { DISCOVERY_UNCAPPED: 'on' } as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('DISCOVERY_UNCAPPED 去帽开关', () => {
  it('默认与畸形值一律 off（失败方向取「保持产品帽」）', () => {
    expect(discoveryUncappedEnabled(off)).toBe(false);
    for (const value of ['off', '', '  ', 'banana', 'y', '0', '2']) {
      expect(
        discoveryUncappedEnabled({ DISCOVERY_UNCAPPED: value } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it.each(['on', 'ON', ' true ', '1'])('显式 %s 开启', (value) => {
    expect(
      discoveryUncappedEnabled({ DISCOVERY_UNCAPPED: value } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('resolveMaxDiscoveryProviderRecords —— 产品帽 vs 防爆安全界', () => {
  it('off：产品帽 25，忽略记录上限 env（off 行为逐字节不变）', () => {
    expect(resolveMaxDiscoveryProviderRecords(off)).toBe(25);
    expect(
      resolveMaxDiscoveryProviderRecords({
        DISCOVERY_MAX_PROVIDER_RECORDS: '5000',
      } as NodeJS.ProcessEnv),
    ).toBe(25);
  });

  it('on：默认防爆界 1000（40× 产品帽）', () => {
    expect(resolveMaxDiscoveryProviderRecords(on)).toBe(
      UNCAPPED_DISCOVERY_PROVIDER_RECORDS,
    );
    expect(UNCAPPED_DISCOVERY_PROVIDER_RECORDS).toBe(1_000);
  });

  it('on：env 可调，畸形/越界值回退默认', () => {
    const withOverride = (raw: string): number =>
      resolveMaxDiscoveryProviderRecords({
        DISCOVERY_UNCAPPED: 'on',
        DISCOVERY_MAX_PROVIDER_RECORDS: raw,
      } as NodeJS.ProcessEnv);

    expect(withOverride('5000')).toBe(5_000);
    expect(withOverride('1')).toBe(1);
    expect(withOverride(`${DISCOVERY_PROVIDER_RECORDS_MAX}`)).toBe(
      DISCOVERY_PROVIDER_RECORDS_MAX,
    );
    for (const raw of ['0', '-1', '1e3', '100abc', '10.5', '', `${DISCOVERY_PROVIDER_RECORDS_MAX + 1}`]) {
      expect(withOverride(raw)).toBe(UNCAPPED_DISCOVERY_PROVIDER_RECORDS);
    }
  });
});

describe('模块级常量按进程 env 解析', () => {
  it('默认进程（flag off）：provider 记录 25、fit 上界 = 66×9×25', () => {
    expect(MAX_DISCOVERY_PROVIDER_RECORDS).toBe(25);
    expect(MAX_DISCOVERY_FIT_COMPANIES).toBe(
      MAX_DISCOVERY_PLAN_QUERIES * MAX_COMPANY_DISCOVERY_ADAPTERS * 25,
    );
    expect(MAX_DISCOVERY_FIT_COMPANIES).toBe(14_850);
  });

  it('进程 env DISCOVERY_UNCAPPED=on：常量整体切到防爆界（含派生的 fit 上界）', async () => {
    vi.resetModules();
    vi.stubEnv('DISCOVERY_UNCAPPED', 'on');
    const mod = await import('./execution-envelope');

    expect(mod.MAX_DISCOVERY_PROVIDER_RECORDS).toBe(1_000);
    expect(mod.MAX_DISCOVERY_FIT_COMPANIES).toBe(
      mod.MAX_DISCOVERY_PLAN_QUERIES * mod.MAX_COMPANY_DISCOVERY_ADAPTERS * 1_000,
    );
    expect(mod.MAX_DISCOVERY_FIT_COMPANIES).toBe(594_000);
  });
});
