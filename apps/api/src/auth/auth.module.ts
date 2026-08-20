import { Global, Logger, Module } from '@nestjs/common';
import { TokenVerifier, UnavailableTokenVerifier } from './token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';
import { AuthGuard } from './auth.guard';
import { ScopesGuard } from './scopes.guard';
import {
  createRolesToScopesPolicy,
  ROLES_TO_SCOPES_POLICY,
  type RolesToScopesPolicy,
} from './scopes';
import {
  resolveRuntimeMode,
} from '../runtime/runtime-environment';

/**
 * 身份 seam（PRD：身份归外部 SaaS 平台，我方只校验其签发的 token）。
 * 选择器（确定性）：
 * 所有 managed runtime 都只接受 SaaS 平台通过 JWKS 签发的 token。
 * development 仅替换 issuer/JWKS 信任根，不替换认证协议或授权语义。
 */
const logger = new Logger('AuthModule');

export function createTokenVerifier(
  env: NodeJS.ProcessEnv = process.env,
): TokenVerifier {
  const hasJwksUri = Boolean(env.AUTH_JWKS_URI?.trim());
  const hasIssuer = Boolean(env.AUTH_ISSUER?.trim());
  const hasAudience = Boolean(env.AUTH_AUDIENCE?.trim());
  if (!(hasJwksUri && hasIssuer && hasAudience)) {
    logger.error('JWKS authentication configuration is incomplete; verifier is unavailable');
    return new UnavailableTokenVerifier();
  }
  try {
    const verifier = new JwksTokenVerifier(env);
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return verifier;
  } catch {
    logger.error('JWKS authentication configuration is invalid; verifier is unavailable');
    return new UnavailableTokenVerifier();
  }
}

export function createRuntimeRolesToScopesPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RolesToScopesPolicy {
  try {
    return createRolesToScopesPolicy(env, resolveRuntimeMode(env));
  } catch {
    logger.error('role-to-scope configuration is unavailable; authorization is deny-all');
    return Object.freeze({
      resolve: (): readonly [] => Object.freeze([]),
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: TokenVerifier, useFactory: createTokenVerifier },
    {
      provide: ROLES_TO_SCOPES_POLICY,
      useFactory: (): RolesToScopesPolicy =>
        createRuntimeRolesToScopesPolicy(process.env),
    },
    AuthGuard,
    ScopesGuard,
  ],
  exports: [
    TokenVerifier,
    ROLES_TO_SCOPES_POLICY,
    AuthGuard,
    ScopesGuard,
  ],
})
export class AuthModule {}
