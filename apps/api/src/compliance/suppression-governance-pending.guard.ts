import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";

/**
 * Temporary, fail-closed admission for suppression governance HTTP surfaces.
 *
 * The authoritative roles-to-scopes guard is delivered on the authz branch.
 * Until that guard is integrated, exposing decrypted suppression values or
 * accepting governance decisions would turn authentication into authorization.
 * This guard must be replaced by `compliance:manage` during integration.
 */
@Injectable()
export class SuppressionGovernancePendingGuard implements CanActivate {
  canActivate(): never {
    throw new ServiceUnavailableException({
      error: {
        code: "SUPPRESSION_GOVERNANCE_AUTHZ_PENDING",
        message:
          "suppression governance is unavailable until server-side scope enforcement is integrated",
      },
    });
  }
}
