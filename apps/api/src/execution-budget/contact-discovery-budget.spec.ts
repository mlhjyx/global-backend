import { describe, expect, it } from 'vitest';
import {
  CONTACT_DISCOVERY_BUDGET_SCOPE,
  CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD,
  CONTACT_DISCOVERY_RUN_CAP_MICROUSD,
  DEFAULT_CONTACT_DISCOVERY_COMPANIES,
  MAX_RUN_EMAIL_PROBES_PER_COMPANY,
  contactDiscoveryCapMicrousd,
  createContactDiscoverySubBudget,
  deriveContactDiscoveryAccountKey,
} from './contact-discovery-budget';

/**
 * D7 联系人阶段独立预算账户（设计稿 §5.3d / D5）：
 * - scope=contact.discovery，accountKey 按 run 派生；
 * - 上限动态计算 = 每家上限 × 本轮公司数，默认对齐 D5（$0.5 / 8 家 → 每家 $0.0625）；
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

  it('默认值对齐 D5：$0.50 / 8 家，每家 $0.0625', () => {
    expect(DEFAULT_CONTACT_DISCOVERY_COMPANIES).toBe(8);
    expect(CONTACT_DISCOVERY_RUN_CAP_MICROUSD).toBe(500_000n);
    expect(CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD).toBe(62_500n);
    expect(contactDiscoveryCapMicrousd(8)).toBe(500_000n);
    expect(contactDiscoveryCapMicrousd(1)).toBe(62_500n);
    expect(contactDiscoveryCapMicrousd(16)).toBe(1_000_000n);
  });

  it('0 家 → 0 上限；非法公司数拒绝', () => {
    expect(contactDiscoveryCapMicrousd(0)).toBe(0n);
    expect(() => contactDiscoveryCapMicrousd(-1)).toThrow(TypeError);
    expect(() => contactDiscoveryCapMicrousd(1.5)).toThrow(TypeError);
    expect(() => contactDiscoveryCapMicrousd(Number.NaN)).toThrow(TypeError);
  });

  it('每公司 ≤6 次 SMTP 探测（D5 §六；MAX_EMAIL_PROBE_CANDIDATES=8 是单次调用上界）', () => {
    expect(MAX_RUN_EMAIL_PROBES_PER_COMPANY).toBe(6);
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
    expect(budget.capMicrousd).toBe(500_000n);
    expect(budget.spentMicrousd).toBe(0n);
    expect(budget.exhausted()).toBe(false);

    expect(budget.observe(9_600_000n)).toBe(400_000n);
    expect(budget.spentMicrousd).toBe(400_000n);
    expect(budget.exhausted()).toBe(false);

    expect(budget.observe(9_500_000n)).toBe(500_000n);
    expect(budget.exhausted()).toBe(true);
  });

  it('上限随本轮公司数放大：16 家 → $1.00', () => {
    const budget = createContactDiscoverySubBudget({
      runId: 'run-1',
      companyCount: 16,
      startRemainingMicrousd: 10_000_000n,
    });
    expect(budget.capMicrousd).toBe(1_000_000n);
    budget.observe(9_400_000n);
    expect(budget.spentMicrousd).toBe(600_000n);
    expect(budget.exhausted()).toBe(false);
  });

  it('剩余额回升（预留释放）不会把已花费算成负数', () => {
    const budget = createContactDiscoverySubBudget({
      runId: 'run-1',
      companyCount: 8,
      startRemainingMicrousd: 1_000_000n,
    });
    budget.observe(900_000n);
    expect(budget.spentMicrousd).toBe(100_000n);
    budget.observe(1_200_000n);
    expect(budget.spentMicrousd).toBe(0n);
  });

  it('非法起点（负数）拒绝', () => {
    expect(() =>
      createContactDiscoverySubBudget({
        runId: 'run-1',
        companyCount: 8,
        startRemainingMicrousd: -1n,
      }),
    ).toThrow(TypeError);
  });
});
