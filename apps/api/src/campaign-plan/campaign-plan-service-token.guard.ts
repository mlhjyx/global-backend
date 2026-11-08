import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { campaignServiceTokenMatches } from '../temporal/campaign-control-plane.client';

/**
 * gain-saas → 引擎的服务身份守卫（M2.1），沿用 gain-saas M2.0 verify 端点的
 * `x-service-token` 常量时间比对模式：
 *  - env `CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN` 未配置 → 503 fail-closed；
 *  - 缺 header → 401；不匹配 → 401。
 */
@Injectable()
export class CampaignPlanServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN ?? '').trim();
    if (expected.length === 0) {
      throw new ServiceUnavailableException({
        error: {
          code: 'CAMPAIGN_PLAN_INTERNAL_NOT_CONFIGURED',
          message: 'CAMPAIGN_PLAN_INTERNAL_NOT_CONFIGURED',
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
    if (!campaignServiceTokenMatches(provided, expected)) {
      throw new UnauthorizedException({
        error: { code: 'SERVICE_TOKEN_INVALID', message: 'SERVICE_TOKEN_INVALID' },
      });
    }
    return true;
  }
}
