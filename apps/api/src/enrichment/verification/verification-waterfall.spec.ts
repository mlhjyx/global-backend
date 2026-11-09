import { describe, expect, it, vi } from 'vitest';
import type { EmailVerificationProvider, EmailVerificationProviderResult } from './email-verification-provider';
import { eventVerdictFromProviderResult, runVerificationWaterfall } from './verification-waterfall';

/**
 * P1-06：验证瀑布的停止规则与预算——主验 invalid 即停、主验 VALID 才买第二票、
 * 未收敛才仲裁；调用次数与成本上限在步与步之间生效。
 */
function result(overrides: Partial<EmailVerificationProviderResult>): EmailVerificationProviderResult {
  return {
    providerKey: 'unknown',
    state: 'UNKNOWN',
    catchAll: 'unknown',
    catchAllClass: 'unknown',
    score: 20,
    acceptAll: null,
    disposable: null,
    role: null,
    detail: 'ok',
    error: null,
    costMicrousd: 1_000,
    latencyMs: 5,
    ...overrides,
  };
}

function provider(key: string, res: EmailVerificationProviderResult): EmailVerificationProvider & {
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    key,
    domain: `${key}.example`,
    isConfigured: () => true,
    verify: vi.fn(async () => ({ ...res, providerKey: res.providerKey === 'unknown' ? key : res.providerKey })),
  };
}

const valid = (key: string, cost = 1_000) => provider(key, result({ state: 'VALID', catchAll: 'not_catch_all', catchAllClass: 'not_catch_all', costMicrousd: cost }));
const invalid = (key: string) => provider(key, result({ state: 'INVALID', costMicrousd: 1_000 }));
const unknownVote = (key: string) => provider(key, result({ state: 'UNKNOWN', costMicrousd: 1_000 }));
const errored = (key: string) => provider(key, result({ state: 'UNKNOWN', error: 'timeout', costMicrousd: 0 }));

describe('runVerificationWaterfall：停止规则', () => {
  it('主验 VALID + 二次确认 VALID → 双正 VALID（恰好 2 次调用）', async () => {
    const a = valid('millionverifier');
    const b = valid('emailable');
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [a, b] });
    expect(outcome.resolved.state).toBe('VALID');
    expect(outcome.resolved.reason).toBe('two_positive_votes');
    expect(outcome.providerCalls).toBe(2);
    expect(outcome.costMicrousd).toBe(2_000);
    expect(a.verify).toHaveBeenCalledOnce();
    expect(b.verify).toHaveBeenCalledOnce();
  });

  it('主验 VALID 但无第二家 → 单票 UNKNOWN（单验证器永不判 VALID）', async () => {
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [valid('millionverifier')] });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.resolved.reason).toBe('single_positive_requires_second_vote');
    expect(outcome.providerCalls).toBe(1);
  });

  it('主验 INVALID → 立即停（1 次调用，强否定不需要第二票）', async () => {
    const b = valid('emailable');
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [invalid('millionverifier'), b] });
    expect(outcome.resolved.state).toBe('INVALID');
    expect(outcome.providerCalls).toBe(1);
    expect(b.verify).not.toHaveBeenCalled();
    expect(outcome.stopReason).toBe('settled');
  });

  it('主验 catch_all / unknown → 停（解析器未接入前不烧第二票）', async () => {
    const catchAll = provider('millionverifier', result({ state: 'CATCH_ALL_RISKY', catchAll: 'catch_all', catchAllClass: 'true_catch_all' }));
    const second = valid('emailable');
    const one = await runVerificationWaterfall({ email: 'x@acme.example', providers: [catchAll, second] });
    expect(one.resolved.state).toBe('CATCH_ALL_RISKY');
    expect(one.providerCalls).toBe(1);
    const unk = await runVerificationWaterfall({ email: 'x@acme.example', providers: [unknownVote('millionverifier'), second] });
    expect(unk.resolved.state).toBe('UNKNOWN');
    expect(unk.providerCalls).toBe(1);
    expect(second.verify).not.toHaveBeenCalled();
  });

  it('主验供应商错误 → 停（provider_error；不换家）', async () => {
    const second = valid('emailable');
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [errored('millionverifier'), second] });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.stopReason).toBe('provider_error');
    expect(outcome.providerCalls).toBe(1);
    expect(second.verify).not.toHaveBeenCalled();
  });

  it('两份 VALID 但第二票带 accept_all=true → CATCH_ALL_RISKY（accept_all 优先）', async () => {
    const a = valid('millionverifier');
    const b = provider('emailable', result({ state: 'VALID', catchAll: 'not_catch_all', catchAllClass: 'not_catch_all', acceptAll: true }));
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [a, b] });
    expect(outcome.resolved.state).toBe('CATCH_ALL_RISKY');
    expect(outcome.resolved.reason).toBe('accept_all_flag');
    expect(outcome.providerCalls).toBe(2);
  });
});

describe('runVerificationWaterfall：未收敛与仲裁', () => {
  it('主验 VALID + 二次 risky/unknown → 未收敛，有仲裁者就调第三家（2 个 positive 才 VALID）', async () => {
    const risly = unknownVote('emailable');
    const arbiter = valid('zerobounce');
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), risly, arbiter],
    });
    expect(outcome.providerCalls).toBe(3);
    expect(outcome.resolved.state).toBe('VALID');
    expect(arbiter.verify).toHaveBeenCalledOnce();
  });

  it('正负冲突（1:1）+ 仲裁 INVALID → INVALID（负票优先，绝不判 VALID）', async () => {
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), invalid('emailable'), invalid('zerobounce')],
    });
    expect(outcome.resolved.state).toBe('INVALID');
    expect(outcome.resolved.reason).toBe('verifier_conflict_negative_majority');
  });

  it('1:1 冲突 + 正票仲裁 → 仍 UNKNOWN（冲突未决绝不判 VALID）', async () => {
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), invalid('emailable'), valid('zerobounce')],
    });
    expect(outcome.providerCalls).toBe(3);
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.resolved.reason).toBe('verifier_conflict_unresolved');
  });

  it('二次确认供应商错误 → 停 provider_error，单票保持 UNKNOWN（不因主验 positive 判 VALID）', async () => {
    const arbiter = valid('zerobounce');
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), errored('emailable'), arbiter],
    });
    expect(outcome.stopReason).toBe('provider_error');
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.providerCalls).toBe(2);
    expect(arbiter.verify).not.toHaveBeenCalled();
  });

  it('负票与 accept_all 并存 → 负票优先（INVALID，不得被 accept_all 抬成 CATCH_ALL_RISKY）', async () => {
    const acceptAllValid = provider(
      'emailable',
      result({ state: 'VALID', catchAll: 'not_catch_all', catchAllClass: 'not_catch_all', acceptAll: true }),
    );
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [invalid('millionverifier'), acceptAllValid],
    });
    expect(outcome.resolved.state).toBe('INVALID');
  });

  it('无仲裁者时未收敛 → UNKNOWN（exhausted）', async () => {
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), unknownVote('emailable')],
    });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.stopReason).toBe('exhausted');
  });

  it('空 provider 列表 → UNKNOWN(no_votes)，零调用', async () => {
    const outcome = await runVerificationWaterfall({ email: 'x@acme.example', providers: [] });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.resolved.reason).toBe('no_votes');
    expect(outcome.providerCalls).toBe(0);
  });
});

describe('runVerificationWaterfall：预算', () => {
  it('maxCalls=1 时主验 VALID 不再买第二票 → 单票 UNKNOWN，stopReason=budget', async () => {
    const b = valid('emailable');
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), b],
      maxCalls: 1,
    });
    expect(outcome.providerCalls).toBe(1);
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.stopReason).toBe('budget');
    expect(b.verify).not.toHaveBeenCalled();
  });

  it('maxCalls=2 时二次确认后停（不调仲裁，stopReason=budget）', async () => {
    const arbiter = valid('zerobounce');
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), unknownVote('emailable'), arbiter],
      maxCalls: 2,
    });
    expect(outcome.providerCalls).toBe(2);
    expect(outcome.stopReason).toBe('budget');
    expect(arbiter.verify).not.toHaveBeenCalled();
  });

  it('beforeCall 抛错则该步不发起（限流器故障不外呼）', async () => {
    const a = valid('millionverifier');
    const b = valid('emailable');
    await expect(
      runVerificationWaterfall({
        email: 'x@acme.example',
        providers: [a, b],
        beforeCall: () => {
          throw new Error('limiter down');
        },
      }),
    ).rejects.toThrow('limiter down');
    expect(a.verify).not.toHaveBeenCalled();
    expect(b.verify).not.toHaveBeenCalled();
  });

  it('成本上限在主验后耗尽 → 不买第二票（stopReason=budget）', async () => {
    const b = valid('emailable');
    const outcome = await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier', 5_000), b],
      maxCostMicrousd: 5_000,
    });
    expect(outcome.costMicrousd).toBe(5_000);
    expect(b.verify).not.toHaveBeenCalled();
    expect(outcome.stopReason).toBe('budget');
  });

  it('beforeCall 钩子每步调用一次（限流/计数挂点）', async () => {
    const beforeCall = vi.fn();
    await runVerificationWaterfall({
      email: 'x@acme.example',
      providers: [valid('millionverifier'), valid('emailable')],
      beforeCall,
    });
    expect(beforeCall).toHaveBeenCalledTimes(2);
  });
});

describe('eventVerdictFromProviderResult', () => {
  it('供应商原始裁决 → 事件账词表（错误优先）', () => {
    expect(eventVerdictFromProviderResult(result({ state: 'VALID' }))).toBe('valid');
    expect(eventVerdictFromProviderResult(result({ state: 'INVALID' }))).toBe('invalid');
    expect(eventVerdictFromProviderResult(result({ state: 'CATCH_ALL_RISKY' }))).toBe('catch_all');
    expect(eventVerdictFromProviderResult(result({ state: 'UNKNOWN' }))).toBe('unknown');
    expect(eventVerdictFromProviderResult(result({ state: 'UNKNOWN', error: 'timeout' }))).toBe('error');
  });
});
