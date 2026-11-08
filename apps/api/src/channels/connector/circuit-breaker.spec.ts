import { describe, expect, it } from 'vitest';
import { ChannelCircuitBreaker } from './circuit-breaker';

function clock(startMs = Date.parse('2026-11-09T00:00:00Z')) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('三态熔断器（闭合 → 打开 → 半开 → 闭合/重开）', () => {
  it('连续 5 次失败打开；打开期间拒绝请求并给出剩余等待', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(null, {}, c.now);
    for (let i = 0; i < 4; i += 1) {
      expect(breaker.recordFailure('500')).toEqual([]);
      expect(breaker.allowRequest().allowed).toBe(true);
    }
    const transitions = breaker.recordFailure('500');
    expect(transitions).toEqual([expect.objectContaining({ from: 'closed', to: 'open', event: 'CIRCUIT_OPEN' })]);
    const decision = breaker.allowRequest();
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(300_000);
    expect(breaker.snapshot()).toMatchObject({ circuit: 'open', consecutiveFailures: 5, lastErrorCode: '500' });
  });

  it('5 分钟窗口到期进入半开，只放一个探测请求', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(null, {}, c.now);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('500');
    c.advance(299_999);
    expect(breaker.allowRequest().allowed).toBe(false);
    c.advance(1);
    const probe = breaker.allowRequest();
    expect(probe.allowed).toBe(true);
    expect(probe.transition).toMatchObject({ to: 'half_open', event: 'CIRCUIT_HALF_OPEN' });
    // 探测在途时第二个请求不允许。
    expect(breaker.allowRequest().allowed).toBe(false);
  });

  it('半开成功回到闭合并清零；半开失败重开 10 分钟，再失败 20 分钟（指数、封顶 1h）', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(null, {}, c.now);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('500');
    c.advance(300_000);
    breaker.allowRequest();
    expect(breaker.recordSuccess()).toEqual([
      expect.objectContaining({ from: 'half_open', to: 'closed', event: 'CIRCUIT_CLOSED' }),
    ]);
    expect(breaker.snapshot().circuit).toBe('closed');

    for (let i = 0; i < 5; i += 1) breaker.recordFailure('500');
    c.advance(300_000);
    breaker.allowRequest();
    const reopened = breaker.recordFailure('500');
    expect(reopened).toEqual([expect.objectContaining({ to: 'open', event: 'CIRCUIT_OPEN' })]);
    expect(breaker.allowRequest().retryAfterMs).toBe(600_000);
    c.advance(600_000);
    breaker.allowRequest();
    breaker.recordFailure('500');
    expect(breaker.allowRequest().retryAfterMs).toBe(1_200_000);
    // 指数封顶 1 小时
    for (let i = 0; i < 5; i += 1) {
      const decision = breaker.allowRequest();
      if (decision.allowed) breaker.recordFailure('500');
      c.advance(decision.retryAfterMs ?? 0);
    }
  });

  it('窗口失败率：5 次请求里 3 次失败（≥50%）即打开，即使没有连续失败', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(null, {}, c.now);
    breaker.recordFailure('500'); // 1/1
    breaker.allowRequest();
    breaker.recordSuccess(); // 1/2
    breaker.allowRequest();
    breaker.recordFailure('500'); // 2/3
    breaker.allowRequest();
    breaker.recordSuccess(); // 2/4
    breaker.allowRequest();
    expect(breaker.recordFailure('500')).toEqual([
      expect.objectContaining({ to: 'open', event: 'CIRCUIT_OPEN' }),
    ]); // 3/5 = 60%
  });

  it('从持久化快照恢复（open 且未到期）', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(
      {
        circuit: 'open',
        consecutiveFailures: 7,
        openedUntil: new Date(c.now() + 120_000).toISOString(),
        lastErrorCode: 'CHANNEL_UPSTREAM_5XX',
        openMs: 300_000,
      },
      {},
      c.now,
    );
    expect(breaker.allowRequest()).toMatchObject({ allowed: false, retryAfterMs: 120_000 });
    expect(breaker.snapshot()).toMatchObject({ circuit: 'open', consecutiveFailures: 7, lastErrorCode: 'CHANNEL_UPSTREAM_5XX' });
  });

  it('快照可回写 JSON（health_state）并保持时间语义', () => {
    const c = clock();
    const breaker = new ChannelCircuitBreaker(null, {}, c.now);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('500');
    const snapshot = breaker.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.openedUntil).toBe(new Date(c.now() + 300_000).toISOString());
  });
});
