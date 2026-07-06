import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 按 workspace 维度限流（多租户公平性）：优先用鉴权解出的 workspaceId 作为限流键，
 * 未鉴权请求回落到 IP。避免单租户打满影响其他租户。
 */
@Injectable()
export class WsThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ctx = req.ctx as { workspaceId?: string } | undefined;
    if (ctx?.workspaceId) return `ws:${ctx.workspaceId}`;
    const ip = (req.ip as string) ?? (req.socket as { remoteAddress?: string })?.remoteAddress ?? 'unknown';
    return `ip:${ip}`;
  }
}
