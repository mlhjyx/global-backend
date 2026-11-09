import { describe, expect, it } from 'vitest';
import { CapBudget, CompositeBudget } from './enrichment-budget';

/**
 * P1-08：预算端口——reserve/settle 语义（预留不足即拒；结算按实际扣减；组合取最紧）。
 */
describe('CapBudget', () => {
  it('无上限：恒可预留，remaining 为 undefined', () => {
    const budget = new CapBudget(undefined);
    expect(budget.remainingMicrousd()).toBeUndefined();
    expect(budget.reserve(1_000_000)).toBe(true);
    budget.settle(1_000_000, 5);
    expect(budget.remainingMicrousd()).toBeUndefined();
  });

  it('上限内可预留；超限拒绝；结算后按实际成本扣减', () => {
    const budget = new CapBudget(10_000);
    expect(budget.reserve(6_000)).toBe(true);
    expect(budget.remainingMicrousd()).toBe(4_000);
    expect(budget.reserve(5_000)).toBe(false);
    expect(budget.remainingMicrousd()).toBe(4_000);
    budget.settle(6_000, 1_700);
    expect(budget.remainingMicrousd()).toBe(8_300);
    expect(budget.reserve(8_300)).toBe(true);
  });

  it('实际成本高于预估时如实扣减（可透支到 0，不为负）', () => {
    const budget = new CapBudget(10_000);
    budget.reserve(1_000);
    budget.settle(1_000, 12_000);
    expect(budget.remainingMicrousd()).toBe(0);
    expect(budget.reserve(1)).toBe(false);
  });

  it('负数/非有限结算值被归零（不放大预算）', () => {
    const budget = new CapBudget(10_000);
    budget.reserve(1_000);
    budget.settle(1_000, -500);
    expect(budget.remainingMicrousd()).toBe(10_000);
    budget.settle(0, Number.NaN);
    expect(budget.remainingMicrousd()).toBe(10_000);
  });
});

describe('CompositeBudget', () => {
  it('剩余取最紧；任一子预算拒绝则整体拒绝并回滚已预留', () => {
    const loose = new CapBudget(100_000);
    const tight = new CapBudget(5_000);
    const budget = new CompositeBudget([loose, tight]);
    expect(budget.remainingMicrousd()).toBe(5_000);
    expect(budget.reserve(6_000)).toBe(false);
    expect(loose.remainingMicrousd()).toBe(100_000);
    expect(budget.reserve(4_000)).toBe(true);
    budget.settle(4_000, 1_700);
    expect(loose.remainingMicrousd()).toBe(98_300);
    expect(tight.remainingMicrousd()).toBe(3_300);
  });

  it('全部无上限时 remaining 为 undefined', () => {
    expect(new CompositeBudget([new CapBudget(undefined)]).remainingMicrousd()).toBeUndefined();
  });
});
