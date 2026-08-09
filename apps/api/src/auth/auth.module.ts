import { Global, Logger, Module } from '@nestjs/common';
import { isIP } from 'node:net';
import { TokenVerifier } from './token-verifier';
import { DevTokenVerifier } from './dev-token-verifier';
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
  resolveRuntimeSettings,
} from '../runtime/runtime-environment';

/**
 * 身份 seam（PRD：身份归外部 SaaS 平台，我方只校验其签发的 token）。
 * 选择器（确定性）：
 *  - 配了 AUTH_JWKS_URI + AUTH_ISSUER → JwksTokenVerifier（真验签）。
 *  - DevTokenVerifier 只允许显式 development + 显式 opt-in + loopback bind。
 *  - 半配置 JWKS、test、pilot、production 或非 loopback 一律 fail-closed。
 */
const logger = new Logger('AuthModule');

function isLoopbackBindHost(host: string): boolean {
  if (host === '127.0.0.1') return true;
  if (isIP(host) !== 6) return false;
  return new URL(`http://[${host}]/`).hostname.slice(1, -1) === '::1';
}

export function createTokenVerifier(
  env: NodeJS.ProcessEnv = process.env,
): TokenVerifier {
  const hasJwksUri = Boolean(env.AUTH_JWKS_URI?.trim());
  const hasIssuer = Boolean(env.AUTH_ISSUER?.trim());
  if (hasJwksUri !== hasIssuer) {
    throw new Error(
      'AUTH_JWKS_URI and AUTH_ISSUER must be configured together',
    );
  }
  if (hasJwksUri && hasIssuer) {
    logger.log('using JwksTokenVerifier (verifies SaaS-platform signed tokens)');
    return new JwksTokenVerifier(env);
  }

  const runtime = resolveRuntimeSettings(env);
  if (
    runtime.mode !== 'development' ||
    env.AUTH_ALLOW_DEV_TOKENS !== 'true' ||
    !isLoopbackBindHost(runtime.bindHost)
  ) {
    throw new Error(
      'DevTokenVerifier requires APP_ENVIRONMENT=development, ' +
        'AUTH_ALLOW_DEV_TOKENS=true, and a loopback API_BIND_HOST; ' +
        'otherwise configure AUTH_JWKS_URI + AUTH_ISSUER.',
    );
  }
  logger.warn(
    'using explicitly enabled DevTokenVerifier on a development loopback bind',
  );
  return new DevTokenVerifier();
}

@Global()
@Module({
  providers: [
    { provide: TokenVerifier, useFactory: createTokenVerifier },
    {
      provide: ROLES_TO_SCOPES_POLICY,
      useFactory: (): RolesToScopesPolicy =>
        createRolesToScopesPolicy(process.env, resolveRuntimeMode(process.env)),
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
