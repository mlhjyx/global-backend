import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const OUTREACH_INTERNAL_SERVICE_TOKEN_ENV = 'OUTREACH_INTERNAL_SERVICE_TOKEN';
export const OUTREACH_INTERNAL_SERVICE_TOKEN_HEADER = 'x-service-token';

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 平台级抑制写入的内部服务门（M2 步 11-4）。
 * 跨租户抑制不能被任意租户 admin 直接写：除租户 JWT/scope 外，还要求 gain-saas
 * 控制面持有的服务令牌。env 未配置时 503 fail-closed。
 */
@Injectable()
export class OutreachDncServiceTokenGuard implements CanActivate {
  // 子类（contact-eligibility 等）通过覆盖这四个字段复用同一令牌机制与错误语义。
  protected readonly unavailableCode: string = 'OUTREACH_SUPPRESS_NOT_CONFIGURED';
  protected readonly unavailableMessage: string = '平台级抑制未配置服务令牌，拒绝写入';
  protected readonly forbiddenCode: string = 'OUTREACH_SUPPRESS_FORBIDDEN';
  protected readonly forbiddenMessage: string = '平台级抑制只接受控制面服务令牌';

  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env[OUTREACH_INTERNAL_SERVICE_TOKEN_ENV] ?? '').trim();
    if (!expected) {
      throw new ServiceUnavailableException({
        error: { code: this.unavailableCode, message: this.unavailableMessage },
      });
    }
    const request = context.switchToHttp().getRequest<Request>();
    const provided = String(
      request.headers[OUTREACH_INTERNAL_SERVICE_TOKEN_HEADER] ?? '',
    ).trim();
    if (!provided || !sameToken(provided, expected)) {
      throw new ForbiddenException({
        error: { code: this.forbiddenCode, message: this.forbiddenMessage },
      });
    }
    return true;
  }
}
