import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";

export const PLATFORM_SCHEDULE_CONFIG_SERVICE_TOKEN_ENV =
  "PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN" as const;

function constantTimeTokenEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Internal service-token guard for `/internal/platform-schedules`:
 * - env `PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN` unset -> 503 fail-closed;
 * - missing/mismatched `x-service-token` -> 401;
 * - constant-time SHA-256 digest comparison to avoid timing leaks.
 */
@Injectable()
export class PlatformScheduleConfigServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (
      process.env[PLATFORM_SCHEDULE_CONFIG_SERVICE_TOKEN_ENV] ?? ""
    ).trim();
    if (expected.length === 0) {
      throw new ServiceUnavailableException({
        error: {
          code: "PLATFORM_SCHEDULE_CONFIG_INTERNAL_NOT_CONFIGURED",
          message: "PLATFORM_SCHEDULE_CONFIG_INTERNAL_NOT_CONFIGURED",
        },
      });
    }
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
    }>();
    const provided = request.headers?.["x-service-token"];
    if (typeof provided !== "string" || provided.length === 0) {
      throw new UnauthorizedException({
        error: {
          code: "SERVICE_TOKEN_REQUIRED",
          message: "SERVICE_TOKEN_REQUIRED",
        },
      });
    }
    if (!constantTimeTokenEquals(provided, expected)) {
      throw new UnauthorizedException({
        error: {
          code: "SERVICE_TOKEN_INVALID",
          message: "SERVICE_TOKEN_INVALID",
        },
      });
    }
    return true;
  }
}
