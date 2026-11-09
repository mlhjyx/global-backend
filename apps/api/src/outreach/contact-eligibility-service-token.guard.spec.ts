import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactEligibilityServiceTokenGuard } from './contact-eligibility-service-token.guard';
import { OUTREACH_INTERNAL_SERVICE_TOKEN_ENV } from './outreach-dnc-service-token.guard';

function context(headers: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

/** 子类只换错误码与文案；令牌机制（env/header/恒定时间比较）与 DNC 完全同源。 */
describe('ContactEligibilityServiceTokenGuard（P1-16）', () => {
  const original = process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    else process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = original;
  });

  it('未配置服务令牌时 fail closed（503，eligibility 语境错误码）', () => {
    delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    try {
      new ContactEligibilityServiceTokenGuard().canActivate(context());
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_ELIGIBILITY_NOT_CONFIGURED');
    }
  });

  it('令牌缺失或不匹配时 403（eligibility 语境错误码）', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    const guard = new ContactEligibilityServiceTokenGuard();
    for (const headers of [{}, { 'x-service-token': 'wrong-token' }]) {
      try {
        guard.canActivate(context(headers));
        throw new Error('should have thrown');
      } catch (error) {
        expect(errorCode(error)).toBe('OUTREACH_ELIGIBILITY_FORBIDDEN');
      }
    }
  });

  it('令牌匹配时放行', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    expect(
      new ContactEligibilityServiceTokenGuard().canActivate(
        context({ 'x-service-token': 'expected-token' }),
      ),
    ).toBe(true);
  });
});
