import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * ch08 §3.1.1 C1a：窗口实扣读回端点（gain-saas → 引擎）的服务身份守卫。
 *
 * 沿用 campaign-plan / outreach 的 `x-service-token` 常量时间比对模式：
 *  - env `BUDGET_READBACK_SERVICE_TOKEN` 未配置 → 503 fail-closed；
 *  - 非回环来源 → 403（设计：仅允许回环/服务网段；引擎 API 默认只绑 127.0.0.1）；
 *  - 缺 header → 401；不匹配 → 401。
 */
export const BUDGET_READBACK_SERVICE_TOKEN_ENV = 'BUDGET_READBACK_SERVICE_TOKEN';
export const BUDGET_READBACK_SERVICE_TOKEN_HEADER = 'x-service-token';

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function tokenMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

@Injectable()
export class BudgetReadbackServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env[BUDGET_READBACK_SERVICE_TOKEN_ENV] ?? '').trim();
    if (expected.length === 0) {
      throw new ServiceUnavailableException({
        error: {
          code: 'BUDGET_READBACK_NOT_CONFIGURED',
          message: 'BUDGET_READBACK_NOT_CONFIGURED',
        },
      });
    }
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
      socket?: { remoteAddress?: string };
    }>();
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      throw new ForbiddenException({
        error: {
          code: 'BUDGET_READBACK_LOOPBACK_ONLY',
          message: 'BUDGET_READBACK_LOOPBACK_ONLY',
        },
      });
    }
    const provided = request.headers?.[BUDGET_READBACK_SERVICE_TOKEN_HEADER];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException({
        error: { code: 'SERVICE_TOKEN_REQUIRED', message: 'SERVICE_TOKEN_REQUIRED' },
      });
    }
    if (!tokenMatches(provided, expected)) {
      throw new UnauthorizedException({
        error: { code: 'SERVICE_TOKEN_INVALID', message: 'SERVICE_TOKEN_INVALID' },
      });
    }
    return true;
  }
}
