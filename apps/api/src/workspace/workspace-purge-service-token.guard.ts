import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

function constantTimeTokenEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * gain-saas → 引擎的整工作空间物理清理服务令牌守卫：
 * - env `WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN` 未配置 → 503 fail-closed；
 * - 缺 `x-service-token` 或不匹配 → 401；
 * - 不限制来源 IP 为 loopback，支持 Docker 内网调用（http://global-api:3000）。
 */
@Injectable()
export class WorkspacePurgeServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN ?? '').trim();
    if (expected.length === 0) {
      throw new ServiceUnavailableException({
        error: {
          code: 'WORKSPACE_PURGE_INTERNAL_NOT_CONFIGURED',
          message: 'WORKSPACE_PURGE_INTERNAL_NOT_CONFIGURED',
        },
      });
    }
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
    }>();
    const provided = request.headers?.['x-service-token'];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException({
        error: { code: 'SERVICE_TOKEN_REQUIRED', message: 'SERVICE_TOKEN_REQUIRED' },
      });
    }
    if (!constantTimeTokenEquals(provided, expected)) {
      throw new UnauthorizedException({
        error: { code: 'SERVICE_TOKEN_INVALID', message: 'SERVICE_TOKEN_INVALID' },
      });
    }
    return true;
  }
}
