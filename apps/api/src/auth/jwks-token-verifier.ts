import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';

/**
 * 生产鉴权：校验外部 SaaS 平台签发的 JWT（PRD 12.2；评审点名的越权漏洞修复）。
 * 用 JWKS 公钥端点验签（支持 kid 轮换），强制校验 iss/aud/exp/nbf。
 * 身份仍归 SaaS 平台——我方只校验、不签发、不刷新。
 *
 * 配置（.env）：
 *   AUTH_JWKS_URI      SaaS 平台的 JWKS 端点（必填，启用本验证器的开关）
 *   AUTH_ISSUER        期望 iss（必填）
 *   AUTH_AUDIENCE      期望 aud（可选但强烈建议）
 *   AUTH_CLOCK_SKEW_S  允许时钟偏移秒（默认 60）
 *   AUTH_WORKSPACE_CLAIM  workspace 所在 claim 名（默认 'workspace_id'）
 *   AUTH_ROLES_CLAIM      roles 所在 claim 名（默认 'roles'）
 *
 * ⚠️ 上线前必须与 SaaS 平台**书面确认** claim 名与命名空间、一人多 workspace 的传法。
 */
@Injectable()
export class JwksTokenVerifier extends TokenVerifier {
  private readonly logger = new Logger('JwksTokenVerifier');
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience?: string;
  private readonly clockSkewS: number;
  private readonly wsClaim: string;
  private readonly rolesClaim: string;

  constructor() {
    super();
    const jwksUri = process.env.AUTH_JWKS_URI;
    this.issuer = process.env.AUTH_ISSUER ?? '';
    if (!jwksUri || !this.issuer) {
      throw new Error('JwksTokenVerifier requires AUTH_JWKS_URI and AUTH_ISSUER');
    }
    this.jwks = createRemoteJWKSet(new URL(jwksUri)); // 内部按 kid 缓存/轮换
    this.audience = process.env.AUTH_AUDIENCE || undefined;
    this.clockSkewS = Number(process.env.AUTH_CLOCK_SKEW_S) || 60;
    this.wsClaim = process.env.AUTH_WORKSPACE_CLAIM ?? 'workspace_id';
    this.rolesClaim = process.env.AUTH_ROLES_CLAIM ?? 'roles';
  }

  async verify(token: string): Promise<RequestContext> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        ...(this.audience ? { audience: this.audience } : {}),
        clockTolerance: this.clockSkewS, // exp/nbf 容忍
      }));
    } catch (err) {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: `token verification failed: ${String((err as Error).message).slice(0, 120)}` },
      });
    }

    const sub = payload.sub;
    const workspaceId = payload[this.wsClaim];
    if (!sub || !workspaceId) {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: `token missing sub or ${this.wsClaim}` },
      });
    }
    const rolesRaw = payload[this.rolesClaim];
    return {
      userId: String(sub),
      workspaceId: String(workspaceId),
      roles: Array.isArray(rolesRaw) ? rolesRaw.map(String) : [],
    };
  }
}
