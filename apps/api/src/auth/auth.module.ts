import { Global, Logger, Module } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { DevTokenVerifier } from './dev-token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';
import { AuthGuard } from './auth.guard';
import { DisabledTokenVerifier } from './disabled-token-verifier';
import { AuthRuntimeAdmission, resolveAuthRuntimeAdmission } from './auth-runtime-admission';
import { ROLE_SCOPE_POLICY } from './auth-scopes';
import { ScopesGuard } from './scopes.guard';

/**
 * 身份 seam（PRD：身份归外部 SaaS 平台，我方只校验其签发的 token）。
 * 选择器由 auth-runtime-admission 在 Nest 构造 verifier 前 fail-closed：
 *  - pilot/production：完整 JWKS URI + issuer + audience，永不允许 dev token。
 *  - development：只有显式 dev-token flag + loopback bind 才能使用 base64 stub。
 *  - OpenAPI export：非 serving 进程使用拒绝所有 token 的 verifier。
 */
const logger = new Logger('AuthModule');
const AUTH_RUNTIME_ADMISSION = Symbol('AUTH_RUNTIME_ADMISSION');

function tokenVerifierFactory(admission: AuthRuntimeAdmission): TokenVerifier {
  if (admission.verifierKind === 'jwks') {
    if (!admission.jwks) {
      throw new Error('JWKS verifier admission is missing validated runtime configuration');
    }
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return new JwksTokenVerifier(admission.jwks);
  }
  if (admission.verifierKind === 'disabled') {
    logger.log('using rejecting verifier for non-serving OpenAPI export');
    return new DisabledTokenVerifier();
  }
  logger.warn('using DevTokenVerifier (base64 stub — NOT for production)');
  return new DevTokenVerifier();
}

@Global()
@Module({
  providers: [
    {
      provide: AUTH_RUNTIME_ADMISSION,
      useFactory: () => resolveAuthRuntimeAdmission(process.env, process.argv),
    },
    {
      provide: ROLE_SCOPE_POLICY,
      useFactory: (admission: AuthRuntimeAdmission) => admission.roleScopePolicy,
      inject: [AUTH_RUNTIME_ADMISSION],
    },
    {
      provide: TokenVerifier,
      useFactory: tokenVerifierFactory,
      inject: [AUTH_RUNTIME_ADMISSION],
    },
    AuthGuard,
    ScopesGuard,
  ],
  exports: [TokenVerifier, AuthGuard, ScopesGuard, ROLE_SCOPE_POLICY],
})
export class AuthModule {}
