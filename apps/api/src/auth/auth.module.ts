import { Global, Logger, Module } from '@nestjs/common';
import {
  RuntimeIdentityService,
  type RuntimeProcessSnapshot,
} from '../runtime/runtime-admission';
import { RoleScopePolicy, ROLE_SCOPE_POLICY } from './auth-scopes';
import { AuthGuard } from './auth.guard';
import { DevTokenVerifier } from './dev-token-verifier';
import {
  JwksTokenVerifier,
  type JwksRuntimeConfig,
} from './jwks-token-verifier';
import { ScopesGuard } from './scopes.guard';
import { TokenVerifier } from './token-verifier';

/**
 * Identity and authorization consume the single immutable pre-Nest runtime
 * snapshot. No provider re-reads mutable environment state or recomputes stage.
 */
const logger = new Logger('AuthModule');

function jwksConfig(runtime: RuntimeProcessSnapshot): JwksRuntimeConfig {
  const config = runtime.safety.auth;
  if (
    config.mode !== 'jwks' ||
    !config.jwksUri ||
    !config.issuer ||
    !config.audience
  ) {
    throw new Error(
      'JwksTokenVerifier requires AUTH_JWKS_URI, AUTH_ISSUER, and AUTH_AUDIENCE',
    );
  }
  return Object.freeze({
    uri: config.jwksUri,
    issuer: config.issuer,
    audience: config.audience,
    clockSkewSeconds: config.clockSkewSeconds,
    workspaceClaim: config.workspaceClaim,
    rolesClaim: config.rolesClaim,
  });
}

export function createTokenVerifier(
  runtime: RuntimeProcessSnapshot,
): TokenVerifier {
  if (runtime.safety.auth.mode === 'jwks') {
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return new JwksTokenVerifier(jwksConfig(runtime));
  }
  logger.warn('using DevTokenVerifier (base64 stub — NOT for production)');
  return new DevTokenVerifier();
}

function roleScopePolicy(runtime: RuntimeProcessSnapshot): RoleScopePolicy {
  return RoleScopePolicy.parse(runtime.environment.AUTH_ROLE_SCOPE_MAP);
}

@Global()
@Module({
  providers: [
    {
      provide: ROLE_SCOPE_POLICY,
      useFactory: (runtime: RuntimeIdentityService) =>
        roleScopePolicy(runtime.getProcessSnapshot()),
      inject: [RuntimeIdentityService],
    },
    {
      provide: TokenVerifier,
      useFactory: (runtime: RuntimeIdentityService) =>
        createTokenVerifier(runtime.getProcessSnapshot()),
      inject: [RuntimeIdentityService],
    },
    AuthGuard,
    ScopesGuard,
  ],
  exports: [TokenVerifier, AuthGuard, ScopesGuard, ROLE_SCOPE_POLICY],
})
export class AuthModule {}
