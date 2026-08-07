import { Global, Logger, Module } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { DevTokenVerifier } from './dev-token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';
import { AuthGuard } from './auth.guard';
import {
  RuntimeIdentityService,
  type RuntimeProcessSnapshot,
} from '../runtime/runtime-admission';

/**
 * 身份 seam（PRD：身份归外部 SaaS 平台，我方只校验其签发的 token）。
 * 选择器（确定性）：
 *  - 配了 AUTH_JWKS_URI + AUTH_ISSUER → JwksTokenVerifier（生产：真验签）。
 *  - canonical development 未配 → DevTokenVerifier（base64 stub）。
 *  - pilot/production 的 pre-Nest snapshot 强制 JWKS 且拒绝 dev override，
 *    本模块只消费该 snapshot，不再独立重算 stage 或读取 mutable env。
 */
const logger = new Logger('AuthModule');

export function createTokenVerifier(
  runtime: RuntimeProcessSnapshot,
): TokenVerifier {
  if (runtime.safety.auth.mode === 'jwks') {
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return new JwksTokenVerifier(runtime.safety.auth);
  }
  logger.warn('using DevTokenVerifier (base64 stub — NOT for production)');
  return new DevTokenVerifier();
}

@Global()
@Module({
  providers: [
    {
      provide: TokenVerifier,
      useFactory: (runtime: RuntimeIdentityService) =>
        createTokenVerifier(runtime.getProcessSnapshot()),
      inject: [RuntimeIdentityService],
    },
    AuthGuard,
  ],
  exports: [TokenVerifier, AuthGuard],
})
export class AuthModule {}
