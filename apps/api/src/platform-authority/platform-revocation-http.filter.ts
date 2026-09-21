import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import {
  PLATFORM_REVOCATION_HTTP_ERRORS,
  revocationErrorBody,
  type RevocationHttpErrorKind,
} from "./platform-revocation-http.contract";

/** Includes global admission/throttler failures. Never reflect a foreign message,
 * classify generic409 as a committed outcome, or log exception/body/JWS values. */
@Catch()
export class PlatformRevocationHttpFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let kind: RevocationHttpErrorKind = "unavailable";
    try {
      if (error instanceof HttpException) {
        const status = error.getStatus();
        const body = error.getResponse();
        if (status === 429) kind = "rateLimited";
        else if ([400, 413, 415].includes(status)) kind = "invalid";
        if (body !== null && typeof body === "object") {
          const nested = Object.getOwnPropertyDescriptor(body, "error")?.value;
          const code =
            nested && Object.getOwnPropertyDescriptor(nested, "code")?.value;
          const message =
            nested && Object.getOwnPropertyDescriptor(nested, "message")?.value;
          for (const [candidate, definition] of Object.entries(
            PLATFORM_REVOCATION_HTTP_ERRORS,
          )) {
            if (
              status === definition.status &&
              code === definition.code &&
              message === revocationErrorBody("unavailable").error.message
            )
              kind = candidate as RevocationHttpErrorKind;
          }
        }
      }
    } catch {
      kind = "unavailable";
    }
    if (
      !response.destroyed &&
      !response.headersSent &&
      !response.writableEnded
    ) {
      response.setHeader("Cache-Control", "no-store");
      response
        .status(PLATFORM_REVOCATION_HTTP_ERRORS[kind].status)
        .json(revocationErrorBody(kind));
    }
  }
}
