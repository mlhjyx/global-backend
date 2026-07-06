import { Global, Module } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';
import { DevTokenVerifier } from './dev-token-verifier';
import { AuthGuard } from './auth.guard';

/**
 * Wires the identity seam. Swap the TokenVerifier binding to point at the
 * external platform's real verifier in non-dev environments.
 */
@Global()
@Module({
  providers: [{ provide: TokenVerifier, useClass: DevTokenVerifier }, AuthGuard],
  exports: [TokenVerifier, AuthGuard],
})
export class AuthModule {}
