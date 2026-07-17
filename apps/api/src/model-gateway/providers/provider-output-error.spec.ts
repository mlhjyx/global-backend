import { describe, expect, it } from 'vitest';
import { ProviderOutputError } from './provider-output-error';

/**
 * ProviderOutputError（M1-b fast-follow · 改动 2）：provider 消费了 token 但结构化输出不可用
 * （空输出/截断/JSON 解析失败）时抛出，携带 usage 让网关 catch 能结算真实消耗，而非静默记 0¢。
 */
describe('ProviderOutputError', () => {
  it('is an Error 且带 name', () => {
    const err = new ProviderOutputError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect(err.name).toBe('ProviderOutputError');
    expect(err.message).toBe('boom');
  });

  it('携带 usage（供网关 centsFromTokens 结算）', () => {
    const err = new ProviderOutputError('truncated', { inputTokens: 100, outputTokens: 2000 });
    expect(err.usage).toEqual({ inputTokens: 100, outputTokens: 2000 });
    expect(err.callCount).toBe(1);
  });

  it('无 usage 时 usage 为 undefined', () => {
    const err = new ProviderOutputError('empty');
    expect(err.usage).toBeUndefined();
  });

  it('保留 cause（preserve-caught-error）', () => {
    const root = new SyntaxError('Unterminated string');
    const err = new ProviderOutputError('parse failed', { outputTokens: 5 }, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('can represent a failed schema-repair pair of provider calls', () => {
    const err = new ProviderOutputError('repair failed', undefined, { callCount: 2 });
    expect(err.callCount).toBe(2);
  });
});
