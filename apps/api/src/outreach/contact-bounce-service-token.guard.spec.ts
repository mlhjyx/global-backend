import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactBounceServiceTokenGuard } from './contact-bounce-service-token.guard';
import { OUTREACH_INTERNAL_SERVICE_TOKEN_ENV } from './outreach-dnc-service-token.guard';

function context(headers: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

describe('ContactBounceServiceTokenGuard（P1-13）', () => {
  const original = process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    else process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = original;
  });

  it('未配置令牌 → 503（bounce 语境错误码）', () => {
    delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    try {
      new ContactBounceServiceTokenGuard().canActivate(context());
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_BOUNCE_NOT_CONFIGURED');
    }
  });

  it('令牌缺失/不符 → 403', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    const guard = new ContactBounceServiceTokenGuard();
    for (const headers of [{}, { 'x-service-token': 'wrong' }]) {
      try {
        guard.canActivate(context(headers));
        throw new Error('should have thrown');
      } catch (error) {
        expect(errorCode(error)).toBe('OUTREACH_BOUNCE_FORBIDDEN');
      }
    }
  });

  it('令牌匹配 → 放行', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    expect(
      new ContactBounceServiceTokenGuard().canActivate(
        context({ 'x-service-token': 'expected-token' }),
      ),
    ).toBe(true);
  });
});
