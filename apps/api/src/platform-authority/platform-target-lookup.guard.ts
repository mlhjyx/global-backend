import {
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  PlatformAuthorityTargetObservationSchema,
  type PlatformAuthorityTargetObservation,
} from "@global/contracts/platform-authority/target-lookup";
import { PlatformTargetReaderDeniedError } from "./platform-target-reader-jwks-verifier";
import {
  PlatformTargetLookupService,
  PlatformTargetLookupInvalidError,
  PlatformTargetLookupScopeMismatchError,
  PlatformTargetLookupNotFoundError,
  PlatformTargetLookupRateLimitedError,
} from "./platform-target-lookup.service";
import { PLATFORM_TARGET_LOOKUP_HTTP_ERRORS } from "./platform-target-lookup.openapi";

const VERIFIED_OBSERVATION = Symbol(
  "platform-authority-target-verified-observation",
);
const COMMITTED_LOOKUP_NOT_FOUND = new WeakSet<object>();

/** Read-only provenance check; status/body/prototype copies cannot mint this brand. */
export function isCommittedPlatformTargetLookupNotFound(
  error: unknown,
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    COMMITTED_LOOKUP_NOT_FOUND.has(error)
  );
}
function failure(
  kind: keyof typeof PLATFORM_TARGET_LOOKUP_HTTP_ERRORS,
): HttpException {
  const { status, code, message } = PLATFORM_TARGET_LOOKUP_HTTP_ERRORS[kind];
  return new HttpException({ error: { code, message } }, status);
}
/** No caller-provided body/property can stand in for the guard's private result. */
export function savedPlatformTargetObservation(
  request: object,
): PlatformAuthorityTargetObservation {
  try {
    const stored = Object.getOwnPropertyDescriptor(
      request,
      VERIFIED_OBSERVATION,
    )?.value;
    return Object.freeze(
      PlatformAuthorityTargetObservationSchema.parse(stored),
    );
  } catch {
    throw failure("unavailable");
  }
}
@Injectable()
export class PlatformTargetLookupGuard implements CanActivate {
  constructor(
    @Inject(PlatformTargetLookupService)
    private readonly service: PlatformTargetLookupService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    http.getResponse<Response>().setHeader("Cache-Control", "no-store");
    const request = http.getRequest<RawBodyRequest<Request>>();
    try {
      if (Object.hasOwn(request, VERIFIED_OBSERVATION))
        throw failure("unavailable");
      const observation = await this.service.read({
        method: request.method,
        originalUrl: request.originalUrl,
        rawHeaders: request.rawHeaders,
        rawBody: request.rawBody as Buffer,
      });
      const validated = Object.freeze(
        PlatformAuthorityTargetObservationSchema.parse(observation),
      );
      Object.defineProperty(request, VERIFIED_OBSERVATION, {
        value: validated,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      return true;
    } catch (error) {
      if (error instanceof PlatformTargetLookupInvalidError)
        throw failure("invalid");
      if (error instanceof PlatformTargetReaderDeniedError)
        throw failure("denied");
      if (error instanceof PlatformTargetLookupScopeMismatchError)
        throw failure("scope");
      if (error instanceof PlatformTargetLookupNotFoundError) {
        const mapped = failure("notFound");
        COMMITTED_LOOKUP_NOT_FOUND.add(mapped);
        throw mapped;
      }
      if (error instanceof PlatformTargetLookupRateLimitedError)
        throw failure("rateLimited");
      throw failure("unavailable");
    }
  }
}
