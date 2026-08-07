import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { TokenVerifier } from './token-verifier';
import { RequestContext } from './request-context';
import type { JwksRuntimeConfig } from './auth-runtime-admission';
import { requestContextFromClaims } from './token-claims';

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
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockSkewS: number;
  private readonly wsClaim: string;
  private readonly rolesClaim: string;

  constructor(config: JwksRuntimeConfig, keyResolver?: JWTVerifyGetKey) {
    super();
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.keyResolver = keyResolver ?? createRemoteJWKSet(new URL(config.uri)); // 内部按 kid 缓存/轮换
    this.clockSkewS = config.clockSkewSeconds;
    this.wsClaim = config.workspaceClaim;
    this.rolesClaim = config.rolesClaim;
  }

  async verify(token: string): Promise<RequestContext> {
    try {
      if (Buffer.byteLength(token, 'utf8') > 16_384) {
        throw new Error('token is too large');
      }
      const { payload, protectedHeader } = await jwtVerify(token, this.keyResolver, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockSkewS, // exp/nbf 容忍
      });
      validateSignedContract(payload, protectedHeader.kid, this.issuer, this.audience);
      return requestContextFromClaims(payload as Readonly<Record<string, unknown>>, this.wsClaim, this.rolesClaim);
    } catch {
      throw new UnauthorizedException({
        error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
      });
    }
  }
}

function validateSignedContract(payload: JWTPayload, kid: string | undefined, issuer: string, audience: string): void {
  if (!kid || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(kid)) {
    throw new Error('invalid kid');
  }
  if (payload.iss !== issuer || payload.aud !== audience) {
    throw new Error('invalid issuer or audience');
  }
  if (
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.nbf) ||
    (payload.exp as number) <= (payload.nbf as number)
  ) {
    throw new Error('invalid token lifetime');
  }
}
