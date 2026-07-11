import { describe, expect, it } from 'vitest';
import { BudgetLedger, BudgetExceededError } from './budget';

/**
 * BudgetLedger.wasExhausted 生命周期单测（Codex PR #51 P1 根治）：预算打穿的**唯一真相点**在 reserve。
 * provider 的 fail-safe catch 会把 BudgetExceededError 吞成空结果，编排层从返回值区分不出「真没数据」还是
 * 「打穿被吞」——故 reserve 失败即打标，编排层（executeQuery / discoverContactsBacklog）用 wasExhausted
 * 独立于 provider 是否吞错地检出截断。打标与账户同生命周期（close 真正删账户时清除）。
 */
describe('BudgetLedger.wasExhausted', () => {
  it('reserve 打穿即打标；未打穿账户为 false', () => {
    const l = new BudgetLedger();
    l.open('run-1', 100);
    expect(l.wasExhausted('run-1')).toBe(false);
    l.reserve('run-1', 40); // 40 ≤ 100 → 不打标
    expect(l.wasExhausted('run-1')).toBe(false);
    expect(() => l.reserve('run-1', 1000)).toThrow(BudgetExceededError); // 打穿
    expect(l.wasExhausted('run-1')).toBe(true);
  });

  it('未开账户 reserve 不打标（无预算约束的内部调用）', () => {
    const l = new BudgetLedger();
    l.reserve('nope', 10_000); // 未开账户 → 返回 0 估算，不抛不打标
    expect(l.wasExhausted('nope')).toBe(false);
  });

  it('close 真正删账户时清除打标（与账户同生命周期，防跨轮/跨测泄漏）', () => {
    const l = new BudgetLedger();
    l.open('run-1', 10);
    expect(() => l.reserve('run-1', 999)).toThrow();
    expect(l.wasExhausted('run-1')).toBe(true);
    l.close('run-1'); // refs 1→0 → 删账户 + 清标
    expect(l.wasExhausted('run-1')).toBe(false);
  });

  it('引用计数未归零时 close 不清标（并发同键页共享，先完成者不误清）', () => {
    const l = new BudgetLedger();
    l.open('run-1', 10);
    l.open('run-1', 10); // refs=2
    expect(() => l.reserve('run-1', 999)).toThrow();
    l.close('run-1'); // refs 2→1，账户仍在 → 标记保留
    expect(l.wasExhausted('run-1')).toBe(true);
    l.close('run-1'); // refs 1→0 → 清
    expect(l.wasExhausted('run-1')).toBe(false);
  });

  it('force close 立即清标（run 生命周期终点，如 finalizeRun）', () => {
    const l = new BudgetLedger();
    l.open('run-1', 10);
    l.open('run-1', 10);
    expect(() => l.reserve('run-1', 999)).toThrow();
    l.close('run-1', { force: true });
    expect(l.wasExhausted('run-1')).toBe(false);
  });

  it('重开同键（上次已 close 清标）从干净状态起', () => {
    const l = new BudgetLedger();
    l.open('run-1', 10);
    expect(() => l.reserve('run-1', 999)).toThrow();
    l.close('run-1');
    l.open('run-1', 100); // 复用同键
    expect(l.wasExhausted('run-1')).toBe(false); // 不带旧打标
  });
});
