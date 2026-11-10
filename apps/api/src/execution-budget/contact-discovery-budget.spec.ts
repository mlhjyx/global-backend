import { describe, expect, it } from 'vitest';
import {
  CONTACT_DISCOVERY_BUDGET_SCOPE,
  CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD,
  CONTACT_DISCOVERY_RUN_CAP_MICROUSD,
  contactDiscoveryCapMicrousd,
  createContactDiscoverySubBudget,
  deriveContactDiscoveryAccountKey,
} from './contact-discovery-budget';

/**
 * D7 联系人阶段独立预算账户（设计稿 §5.3d / D5）：
 * - scope=contact.discovery，accountKey 按 run 派生；
 * - 上限动态计算 = min(每家上限 × 本轮公司数, 整轮上限)（2026-11-02 重校：每家 20¢、封顶 $2）；
 * - 撞自己的上限即停，不挤占 run 的查询/画像/评分额度。
 */
describe('contact.discovery 预算账户派生（D7）', () => {
  it('scope 常量与按 run 派生的 accountKey', () => {
    expect(CONTACT_DISCOVERY_BUDGET_SCOPE).toBe('contact.discovery');
    expect(deriveContactDiscoveryAccountKey('run-1')).toBe('contact.discovery:run-1');
    expect(deriveContactDiscoveryAccountKey('run-2')).not.toBe(
      deriveContactDiscoveryAccountKey('run-1'),
    );
  });

  it('拒绝空 runId 与超出账户键长度上界的 runId', () => {
    expect(() => deriveContactDiscoveryAccountKey('')).toThrow(TypeError);
    expect(() => deriveContactDiscoveryAccountKey('   ')).toThrow(TypeError);
    expect(() => deriveContactDiscoveryAccountKey('r'.repeat(190))).toThrow(TypeError);
  });

  it('D5 重校（2026-11-02）：每家 $0.20、整轮封顶 $2.00，8 家 → $1.60', () => {
    expect(CONTACT_DISCOVERY_RUN_CAP_MICROUSD).toBe(2_000_000n);
    expect(CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD).toBe(200_000n);
    expect(contactDiscoveryCapMicrousd(8)).toBe(1_600_000n);
    expect(contactDiscoveryCapMicrousd(1)).toBe(200_000n);
    expect(contactDiscoveryCapMicrousd(16)).toBe(2_000_000n);
  });

  it('0 家 → 0 上限；非法公司数拒绝', () => {
    expect(contactDiscoveryCapMicrousd(0)).toBe(0n);
    expect(() => contactDiscoveryCapMicrousd(-1)).toThrow(TypeError);
    expect(() => contactDiscoveryCapMicrousd(1.5)).toThrow(TypeError);
    expect(() => contactDiscoveryCapMicrousd(Number.NaN)).toThrow(TypeError);
  });

  it('去帽模式（DISCOVERY_UNCAPPED=on）：整轮 $2 产品帽退场，只保留每家 $0.20 安全界', () => {
    const on = { DISCOVERY_UNCAPPED: 'on' } as NodeJS.ProcessEnv;
    // 16 家 × 20¢ = $3.20：off 口径封顶 $2.00，去帽模式不再封顶（余额是唯一收紧条件）。
    expect(contactDiscoveryCapMicrousd(16, on)).toBe(3_200_000n);
    expect(contactDiscoveryCapMicrousd(8, on)).toBe(1_600_000n);
    expect(contactDiscoveryCapMicrousd(0, on)).toBe(0n);
    expect(() => contactDiscoveryCapMicrousd(-1, on)).toThrow(TypeError);
    // off 显式传入时保持旧口径。
    expect(contactDiscoveryCapMicrousd(16, {} as NodeJS.ProcessEnv)).toBe(
      CONTACT_DISCOVERY_RUN_CAP_MICROUSD,
    );
  });
});

describe('联系人子账户的窗口计量', () => {
  it('用 run 账户的剩余额差值计量子账户花费，达到上限即 exhausted', () => {
    const budget = createContactDiscoverySubBudget({
      runId: 'run-1',
      companyCount: 8,
      startRemainingMicrousd: 10_000_000n,
    });
    expect(budget.accountKey).toBe('contact.discovery:run-1');
    expect(budget.capMicrousd).toBe(1_600_000n);
    expect(budget.spentMicrousd).toBe(0n);
    expect(budget.exhausted()).toBe(false);

    expect(budget.observe(8_600_000n)).toBe(1_400_000n);
    expect(budget.spentMicrousd).toBe(1_400_000n);
    expect(budget.exhausted()).toBe(false);

    expect(budget.observe(8_300_000n)).toBe(1_700_000n);
    expect(budget.exhausted()).toBe(true);
  });

  it('整轮上限封顶 $2：16 家也只到 $2.00', () => {
    const budget = createContactDiscoverySubBudget({
      runId: 'run-1',
      companyCount: 16,
      startRemainingMicrousd: 10_000_000n,
    });
    expect(budget.capMicrousd).toBe(2_000_000n);
    budget.observe(8_400_000n);
    expect(budget.spentMicrousd).toBe(1_600_000n);
    expect(budget.exhausted()).toBe(false);
  });

  it('剩余额回升（预留释放/低结算）不会抹掉已观察到的花费（单调高水位）', () => {
    const budget = createContactDiscoverySubBudget({
      runId: 'run-1',
      companyCount: 8,
      startRemainingMicrousd: 1_000_000n,
    });
    budget.observe(900_000n);
    expect(budget.spentMicrousd).toBe(100_000n);
    // 阶段开始前持有的预留释放 → 剩余额升回起点之上；已观察的花费保持，不重开整份额度。
    budget.observe(1_200_000n);
    expect(budget.spentMicrousd).toBe(100_000n);
    budget.observe(800_000n);
    expect(budget.spentMicrousd).toBe(200_000n);
  });

  it('非法起点（负数/超出账本 BIGINT 上界）拒绝', () => {
    expect(() =>
      createContactDiscoverySubBudget({
        runId: 'run-1',
        companyCount: 8,
        startRemainingMicrousd: -1n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createContactDiscoverySubBudget({
        runId: 'run-1',
        companyCount: 8,
        startRemainingMicrousd: 9_223_372_036_854_775_808n,
      }),
    ).toThrow(RangeError);
  });
});
