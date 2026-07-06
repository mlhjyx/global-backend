import { Global, Logger, Module } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { DevTokenVerifier } from './dev-token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';
import { AuthGuard } from './auth.guard';

/**
 * 身份 seam（PRD：身份归外部 SaaS 平台，我方只校验其签发的 token）。
 * 选择器（确定性）：
 *  - 配了 AUTH_JWKS_URI + AUTH_ISSUER → JwksTokenVerifier（生产：真验签）。
 *  - 未配 → DevTokenVerifier（base64 stub）；但**生产环境禁用 dev stub**，
 *    未配 JWKS 就在生产启动即失败，杜绝"任何人构造 claim 冒充租户"的越权漏洞。
 */
const logger = new Logger('AuthModule');

function tokenVerifierFactory(): TokenVerifier {
  const jwksConfigured = !!process.env.AUTH_JWKS_URI && !!process.env.AUTH_ISSUER;
  const isProd = process.env.NODE_ENV === 'production';
  if (jwksConfigured) {
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return new JwksTokenVerifier();
  }
  if (isProd && process.env.AUTH_ALLOW_DEV_TOKENS !== 'true') {
    throw new Error(
      'Production requires AUTH_JWKS_URI + AUTH_ISSUER (real token verification). ' +
        'Dev token stub is disabled in production — set AUTH_ALLOW_DEV_TOKENS=true only to override intentionally.',
    );
  }
  logger.warn('using DevTokenVerifier (base64 stub — NOT for production)');
  return new DevTokenVerifier();
}

@Global()
@Module({
  providers: [{ provide: TokenVerifier, useFactory: tokenVerifierFactory }, AuthGuard],
  exports: [TokenVerifier, AuthGuard],
})
export class AuthModule {}
