import { describe, expect, it } from 'vitest';
import { ProviderOutputError, TaskOutputValidationError } from './provider-output-error';

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

  it('takes its reason code from the leading code token, never from the detail after it', () => {
    expect(new ProviderOutputError('STRUCTURED_OUTPUT_TRUNCATED').reasonCode).toBe(
      'STRUCTURED_OUTPUT_TRUNCATED',
    );
    expect(
      new ProviderOutputError('VISION_REVIEW_SCHEMA_INVALID: /name must be shorter than 200: "Acme"')
        .reasonCode,
    ).toBe('VISION_REVIEW_SCHEMA_INVALID');
  });

  it('prefers an explicit reason code and marks a descriptive message without one as unclassified', () => {
    expect(
      new ProviderOutputError('gateway m: structured output is not valid JSON', undefined, {
        reasonCode: 'STRUCTURED_OUTPUT_NOT_JSON',
      }).reasonCode,
    ).toBe('STRUCTURED_OUTPUT_NOT_JSON');
    expect(new ProviderOutputError('gateway m: something odd').reasonCode).toBe(
      'PROVIDER_OUTPUT_UNCLASSIFIED',
    );
  });

  it('refuses an explicit reason code that could carry free text', () => {
    expect(
      () => new ProviderOutputError('boom', undefined, { reasonCode: 'not a code: Acme GmbH' }),
    ).toThrow('PROVIDER_OUTPUT_REASON_CODE_INVALID');
  });

  it('gives a task-gate rejection its own reason code', () => {
    expect(new TaskOutputValidationError('task output hard gate rejected: x').reasonCode).toBe(
      'TASK_OUTPUT_REJECTED',
    );
  });
});
