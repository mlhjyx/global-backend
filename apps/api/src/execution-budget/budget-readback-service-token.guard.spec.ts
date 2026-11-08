import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  BUDGET_READBACK_SERVICE_TOKEN_ENV,
  BudgetReadbackServiceTokenGuard,
  isLoopbackAddress,
} from './budget-readback-service-token.guard';

/**
 * ch08 §3.1.1 C1a：读回端点的门 —— 未配置 fail-closed（503）、非回环 403、
 * 缺/错令牌 401、正确令牌放行。顺序与 campaign-plan 服务令牌守卫一致。
 */

function context(request: {
  remoteAddress?: string;
  headers?: Record<string, unknown>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        socket: { remoteAddress: request.remoteAddress },
        headers: request.headers ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

const guard = new BudgetReadbackServiceTokenGuard();
const original = process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV];

beforeEach(() => {
  process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV] = 'budget-readback-token';
});

afterEach(() => {
  if (original === undefined) delete process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV];
  else process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV] = original;
});

describe('BudgetReadbackServiceTokenGuard', () => {
  it('fails closed with 503 when the service token env is missing', () => {
    delete process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV];
    expect(() =>
      guard.canActivate(context({ remoteAddress: '127.0.0.1', headers: {} })),
    ).toThrowError(
      expect.objectContaining({
        response: { error: { code: 'BUDGET_READBACK_NOT_CONFIGURED' } },
      }),
    );
  });

  it('rejects non-loopback callers with 403', () => {
    expect(() =>
      guard.canActivate(
        context({ remoteAddress: '10.1.2.3', headers: { 'x-service-token': 'budget-readback-token' } }),
      ),
    ).toThrowError(
      expect.objectContaining({
        response: { error: { code: 'BUDGET_READBACK_LOOPBACK_ONLY' } },
      }),
    );
  });

  it('requires the x-service-token header', () => {
    expect(() => guard.canActivate(context({ remoteAddress: '127.0.0.1' }))).toThrowError(
      expect.objectContaining({ response: { error: { code: 'SERVICE_TOKEN_REQUIRED' } } }),
    );
  });

  it('rejects a mismatched token with 401', () => {
    expect(() =>
      guard.canActivate(
        context({ remoteAddress: '127.0.0.1', headers: { 'x-service-token': 'wrong' } }),
      ),
    ).toThrowError(
      expect.objectContaining({ response: { error: { code: 'SERVICE_TOKEN_INVALID' } } }),
    );
  });

  it('allows a loopback caller with the matching token', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(
        guard.canActivate(
          context({
            remoteAddress: address,
            headers: { 'x-service-token': 'budget-readback-token' },
          }),
        ),
      ).toBe(true);
    }
  });

  it('recognizes only loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
