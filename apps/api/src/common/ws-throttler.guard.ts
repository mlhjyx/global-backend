import { Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { TokenVerifier } from '../auth/token-verifier';
import { candidateWorkspaceAllowed } from '../runtime/development-candidate';

const MAX_BEARER_TOKEN_BYTES = 16_384;

/**
 * 按 workspace 维度限流（多租户公平性）：优先使用已挂载的 req.requestContext.workspaceId，
 * 否则在 Bearer JWT 校验通过且所属 workspace 获准时取 verified.workspaceId 作为限流键
 * （不提前写 req.requestContext，保持 AuthGuard 为唯一上下文写入方）；
 * 未鉴权/无效令牌/服务令牌请求回落到 IP。避免单租户打满影响其他租户。
 */
@Injectable()
export class WsThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Optional() @Inject(TokenVerifier) private readonly tokenVerifier?: TokenVerifier,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const requestContext = req.requestContext as { workspaceId?: unknown } | undefined;
    if (typeof requestContext?.workspaceId === 'string' && requestContext.workspaceId.length > 0) {
      return `ws:${requestContext.workspaceId}`;
    }

    if (this.tokenVerifier) {
      const headers = req.headers as Record<string, unknown> | undefined;
      const auth = headers?.['authorization'];
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        const token = auth.slice('Bearer '.length);
        if (token.length > 0 && Buffer.byteLength(token, 'utf8') <= MAX_BEARER_TOKEN_BYTES) {
          try {
            const verified = await this.tokenVerifier.verify(token);
            if (
              typeof verified.workspaceId === 'string' &&
              verified.workspaceId.length > 0 &&
              candidateWorkspaceAllowed(verified.workspaceId)
            ) {
              return `ws:${verified.workspaceId}`;
            }
          } catch {
            // Fail-open to IP so public, x-service-token, and invalid-JWT requests reach their own guards.
          }
        }
      }
    }

    const ip =
      (typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined) ??
      (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ??
      'unknown';
    return `ip:${ip}`;
  }
}
