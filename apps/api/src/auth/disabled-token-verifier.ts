import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from './token-verifier';

/** Rejecting verifier used only while generating OpenAPI in a non-listening process. */
@Injectable()
export class DisabledTokenVerifier extends TokenVerifier {
  async verify(): Promise<never> {
    throw new UnauthorizedException({
      error: {
        code: 'TOKEN_VERIFICATION_DISABLED',
        message: 'token verification is disabled in this process',
      },
    });
  }
}
