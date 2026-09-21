import {
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { PlatformRevocationHttpService } from "./platform-revocation-http.service";
import { revocationRequestScope } from "./platform-revocation-http.middleware";
import {
  PlatformRevocationHttpError,
  PLATFORM_REVOCATION_HTTP_ERRORS,
  revocationErrorBody,
  revocationFailure,
} from "./platform-revocation-http.contract";
import type { SignedFenceAck } from "./platform-fence-ack-crypto";

const replies = new WeakMap<object, SignedFenceAck>();
export function consumePlatformFenceAck(request: object): string {
  revocationRequestScope(request).assertActive();
  const ack = replies.get(request);
  replies.delete(request);
  if (!ack) return revocationFailure();
  return ack.token;
}
@Injectable()
export class PlatformRevocationHttpGuard implements CanActivate {
  constructor(
    @Inject(PlatformRevocationHttpService)
    private readonly service: PlatformRevocationHttpService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp(),
      request = http.getRequest<Request>();
    http.getResponse<Response>().setHeader("Cache-Control", "no-store");
    try {
      const scope = revocationRequestScope(request);
      const ack = await this.service.receive(
        {
          method: request.method,
          originalUrl: request.originalUrl,
          rawHeaders: request.rawHeaders,
          rawBody: scope.body,
        },
        scope,
      );
      scope.assertActive();
      replies.set(request, ack);
      return true;
    } catch (error) {
      const kind =
        error instanceof PlatformRevocationHttpError
          ? error.kind
          : "unavailable";
      throw new HttpException(
        revocationErrorBody(kind),
        PLATFORM_REVOCATION_HTTP_ERRORS[kind].status,
      );
    }
  }
}
