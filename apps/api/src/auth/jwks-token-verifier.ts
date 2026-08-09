import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';
import { normalizeTokenRoles } from './scopes';
import {
  normalizeSubjectClaim,
  normalizeWorkspaceClaim,
  resolveClockToleranceSeconds,
  resolveTokenClaimName,
} from './token-claims';

/**
 * 生产鉴权：校验外部 SaaS 平台签发的 JWT（PRD 12.2；评审点名的越权漏洞修复）。
 * 用 JWKS 公钥端点验签（支持 kid 轮换），强制校验 iss/aud/exp/nbf。
 * 身份仍归 SaaS 平台——我方只校验、不签发、不刷新。
 *
 * 配置（.env）：
 *   AUTH_JWKS_URI      SaaS 平台的 JWKS 端点（必填，启用本验证器的开关）
 *   AUTH_ISSUER        期望 iss（必填）
 *   AUTH_AUDIENCE      期望 aud（必填）
 *   AUTH_CLOCK_SKEW_S  允许时钟偏移秒（默认 60）
 *   AUTH_WORKSPACE_CLAIM  workspace 所在 claim 名（默认 'workspace_id'）
 *   AUTH_ROLES_CLAIM      roles 所在 claim 名（默认 'roles'）
 *
 * ⚠️ 上线前必须与 SaaS 平台**书面确认** claim 名与命名空间、一人多 workspace 的传法。
 */
@Injectable()
export class JwksTokenVerifier extends TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockSkewS: number;
  private readonly wsClaim: string;
  private readonly rolesClaim: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    super();
    const jwksUri = env.AUTH_JWKS_URI;
    const issuer = env.AUTH_ISSUER;
    const audience = env.AUTH_AUDIENCE;
    if (
      !jwksUri ||
      !issuer ||
      !audience ||
      jwksUri !== jwksUri.trim() ||
      issuer !== issuer.trim() ||
      audience !== audience.trim() ||
      audience.length > 256
    ) {
      throw new Error(
        'JwksTokenVerifier requires canonical AUTH_JWKS_URI, AUTH_ISSUER, and AUTH_AUDIENCE',
      );
    }
    this.issuer = issuer;
    this.audience = audience;
    this.jwks = createRemoteJWKSet(new URL(jwksUri)); // 内部按 kid 缓存/轮换
    this.clockSkewS = resolveClockToleranceSeconds(env.AUTH_CLOCK_SKEW_S);
    this.wsClaim = resolveTokenClaimName(
      env.AUTH_WORKSPACE_CLAIM,
      'workspace_id',
    );
    this.rolesClaim = resolveTokenClaimName(env.AUTH_ROLES_CLAIM, 'roles');
    if (this.wsClaim === this.rolesClaim) {
      throw new Error('token claim names must be distinct');
    }
  }

  async verify(token: string): Promise<RequestContext> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockSkewS, // exp/nbf 容忍
      }));
    } catch {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
      });
    }

    try {
      return {
        userId: normalizeSubjectClaim(payload.sub),
        workspaceId: normalizeWorkspaceClaim(payload[this.wsClaim]),
        roles: normalizeTokenRoles(payload[this.rolesClaim]),
      };
    } catch {
      throw new UnauthorizedException({
        error: {
          code: 'TOKEN_INVALID',
          message: 'token identity or roles claims are invalid',
        },
      });
    }
  }
}
