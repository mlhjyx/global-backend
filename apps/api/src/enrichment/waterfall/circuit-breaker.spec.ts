import { describe, expect, it } from 'vitest';
import {
  applyCircuitOutcome,
  CIRCUIT_OPEN_MS,
  circuitAllowsCall,
  emptyCircuitState,
  parseCircuitState,
  type CircuitState,
} from './circuit-breaker';

/**
 * P1-08：熔断器状态机——连续 5 次失败 / 15 分钟窗口错误率 >20%（≥5 样本）→ OPEN 15 分钟；
 * 到期放 1 个探针，成功 CLOSED、失败重开；miss 计成功不计错误率。
 */
const T0 = new Date('2026-11-09T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const fail = (state: CircuitState, now: Date) => applyCircuitOutcome(state, 'failure', now);
const pass = (state: CircuitState, now: Date) => applyCircuitOutcome(state, 'success', now);

describe('circuitAllowsCall', () => {
  it('CLOSED 放行；OPEN 未到期拒绝；到期放行（探针）；HALF_OPEN 探针在途拒绝', () => {
    expect(circuitAllowsCall(emptyCircuitState(), T0)).toBe(true);
    const open: CircuitState = { ...emptyCircuitState(), status: 'OPEN', openedAt: T0.toISOString() };
    expect(circuitAllowsCall(open, at(CIRCUIT_OPEN_MS - 1))).toBe(false);
    expect(circuitAllowsCall(open, at(CIRCUIT_OPEN_MS))).toBe(true);
    expect(
      circuitAllowsCall({ ...emptyCircuitState(), status: 'HALF_OPEN', probeInFlight: true }, T0),
    ).toBe(false);
    expect(circuitAllowsCall({ ...emptyCircuitState(), status: 'HALF_OPEN' }, T0)).toBe(true);
  });
});

describe('applyCircuitOutcome：CLOSED 窗口', () => {
  it('连续 5 次失败 → OPEN；第 4 次仍 CLOSED', () => {
    let state = emptyCircuitState();
    for (let i = 0; i < 4; i += 1) state = fail(state, at(i * 1000));
    expect(state.status).toBe('CLOSED');
    expect(state.consecutiveFailures).toBe(4);
    state = fail(state, at(5000));
    expect(state.status).toBe('OPEN');
    expect(state.openedAt).toBe(at(5000).toISOString());
  });

  it('成功清零连续失败计数', () => {
    let state = fail(fail(fail(emptyCircuitState(), T0), T0), T0);
    expect(state.consecutiveFailures).toBe(3);
    state = pass(state, T0);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('错误率 >20%（≥5 样本）→ OPEN；样本不足不触发', () => {
    // 4 样本 2 失败（50%）→ 不触发（样本 <5）。
    let small = emptyCircuitState();
    small = fail(pass(fail(pass(small, T0), T0), T0), T0);
    expect(small.status).toBe('CLOSED');
    // 5 样本 2 失败（40%）→ 触发。
    let enough: CircuitState = { ...emptyCircuitState(), windowStartedAt: T0.toISOString(), windowFailures: 1, windowSuccesses: 3 };
    enough = fail(enough, at(1000));
    expect(enough.status).toBe('OPEN');
    // 5 样本 1 失败（20%，非 >20%）→ 不触发。
    let ok: CircuitState = { ...emptyCircuitState(), windowStartedAt: T0.toISOString(), windowFailures: 0, windowSuccesses: 4 };
    ok = fail(ok, at(1000));
    expect(ok.status).toBe('CLOSED');
  });

  it('窗口滚动：上一窗口的失败不计入新窗口', () => {
    let state: CircuitState = {
      ...emptyCircuitState(),
      windowStartedAt: T0.toISOString(),
      windowFailures: 4,
      windowSuccesses: 0,
      consecutiveFailures: 4,
    };
    // 新窗口开始后成功一次，旧窗口的 4 次失败清空。
    state = pass(state, at(16 * 60_000));
    expect(state).toMatchObject({ windowFailures: 0, windowSuccesses: 1, consecutiveFailures: 0 });
  });
});

describe('applyCircuitOutcome：OPEN/HALF_OPEN 与探针', () => {
  it('OPEN 到期后探针成功 → CLOSED（窗口清零）', () => {
    const open: CircuitState = {
      ...emptyCircuitState(),
      status: 'OPEN',
      openedAt: T0.toISOString(),
      windowFailures: 5,
      consecutiveFailures: 5,
    };
    const closed = pass(open, at(CIRCUIT_OPEN_MS));
    expect(closed).toMatchObject({
      status: 'CLOSED',
      windowFailures: 0,
      consecutiveFailures: 0,
    });
  });

  it('OPEN 到期后探针失败 → 重新 OPEN（新的 openedAt）', () => {
    const open: CircuitState = { ...emptyCircuitState(), status: 'OPEN', openedAt: T0.toISOString() };
    const reopened = fail(open, at(CIRCUIT_OPEN_MS + 1000));
    expect(reopened.status).toBe('OPEN');
    expect(reopened.openedAt).toBe(at(CIRCUIT_OPEN_MS + 1000).toISOString());
  });

  it('OPEN 未到期时到达的结果不改变状态（拒绝已在调用前发生）', () => {
    const open: CircuitState = { ...emptyCircuitState(), status: 'OPEN', openedAt: T0.toISOString() };
    expect(pass(open, at(1000))).toEqual(open);
    expect(fail(open, at(1000))).toEqual(open);
  });

  it('HALF_OPEN 探针成功/失败', () => {
    const half: CircuitState = { ...emptyCircuitState(), status: 'HALF_OPEN', probeInFlight: true };
    expect(pass(half, T0).status).toBe('CLOSED');
    expect(fail(half, T0).status).toBe('OPEN');
  });
});

describe('parseCircuitState', () => {
  it('损坏/缺字段 → 空状态；合法 JSON 往返', () => {
    expect(parseCircuitState(null)).toEqual(emptyCircuitState());
    expect(parseCircuitState({ circuit: 'nope' })).toEqual(emptyCircuitState());
    expect(parseCircuitState({ circuit: { status: 'WEIRD' } })).toEqual(emptyCircuitState());
    const state: CircuitState = {
      status: 'OPEN',
      windowStartedAt: T0.toISOString(),
      windowSuccesses: 1,
      windowFailures: 5,
      consecutiveFailures: 5,
      openedAt: T0.toISOString(),
      probeInFlight: false,
    };
    expect(parseCircuitState({ circuit: state })).toEqual(state);
  });
});
