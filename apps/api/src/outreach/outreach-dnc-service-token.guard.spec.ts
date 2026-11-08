import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OUTREACH_INTERNAL_SERVICE_TOKEN_ENV,
  OutreachDncServiceTokenGuard,
} from './outreach-dnc-service-token.guard';

function context(headers: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

describe('OutreachDncServiceTokenGuard（M2 步 11-4）', () => {
  const original = process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    else process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = original;
  });

  it('未配置服务令牌时 fail closed（503）', () => {
    delete process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV];
    try {
      new OutreachDncServiceTokenGuard().canActivate(context());
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_SUPPRESS_NOT_CONFIGURED');
    }
  });

  it('令牌缺失或不匹配时 403', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    const guard = new OutreachDncServiceTokenGuard();
    try {
      guard.canActivate(context());
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_SUPPRESS_FORBIDDEN');
    }
    try {
      guard.canActivate(context({ 'x-service-token': 'wrong-token' }));
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_SUPPRESS_FORBIDDEN');
    }
  });

  it('令牌匹配时放行', () => {
    process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] = 'expected-token';
    expect(
      new OutreachDncServiceTokenGuard().canActivate(
        context({ 'x-service-token': 'expected-token' }),
      ),
    ).toBe(true);
  });
});
