import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";

/**
 * Temporary hard stop for acquisition endpoints whose least-privilege scopes
 * are declared but not yet bound to the runtime authorization guard.
 *
 * This guard must be removed only when the authorization integration adds the
 * exact per-operation scope checks. Authentication alone is not sufficient.
 */
@Injectable()
export class AcquisitionAuthorizationIntegrationPendingGuard implements CanActivate {
  canActivate(_context: ExecutionContext): never {
    throw new ServiceUnavailableException({
      error: {
        code: "AUTHORIZATION_INTEGRATION_PENDING",
        message:
          "This acquisition endpoint is unavailable until authorization scopes are integrated",
      },
    });
  }
}
