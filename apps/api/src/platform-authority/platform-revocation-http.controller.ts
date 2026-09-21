import {
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UseFilters,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiExtension,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { PlatformRevocationRecovery } from "../runtime/recovery-control-plane.decorator";
import {
  PlatformRevocationHttpGuard,
  consumePlatformFenceAck,
} from "./platform-revocation-http.guard";
import { PLATFORM_REVOCATION_HTTP_DEADLINE_MS } from "./platform-revocation-http.contract";
import { PlatformRevocationHttpFilter } from "./platform-revocation-http.filter";

@ApiTags("PlatformAuthority")
@Controller("platform-authority")
@UseGuards(PlatformRevocationHttpGuard)
@UseFilters(PlatformRevocationHttpFilter)
export class PlatformRevocationHttpController {
  @Post("revocations")
  @PlatformRevocationRecovery()
  @HttpCode(200)
  @ApiConsumes("application/jose")
  @ApiProduces("application/jose")
  @ApiOperation({
    operationId: "receivePlatformAuthorityRevocation_v1",
    summary: "Apply signed revocation or replay its exact committed ACK",
  })
  @ApiExtension("x-service-authentication", {
    kind: "signed-jws-request-body",
    algorithm: "RS256",
    type: "execution-budget-authority-revocation+jwt",
    user_token_fallback: false,
  })
  @ApiExtension("x-maximum-request-body-bytes", 16384)
  @ApiExtension("x-maximum-response-body-bytes", 16384)
  @ApiExtension(
    "x-maximum-deadline-milliseconds",
    PLATFORM_REVOCATION_HTTP_DEADLINE_MS,
  )
  @ApiBody({
    required: true,
    schema: {
      type: "string",
      maxLength: 16384,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
  })
  @ApiResponse({
    status: 200,
    description:
      "Original durable ACK JWS; expired exact ACKs are not re-signed or refreshed",
    schema: { type: "string", maxLength: 16384 },
  })
  @ApiResponse({ status: 400, description: "Invalid bounded representation" })
  @ApiResponse({
    status: 401,
    description: "Invalid signature or token family",
  })
  @ApiResponse({ status: 403, description: "Target/schedule scope mismatch" })
  @ApiResponse({
    status: 409,
    description:
      "Expired new command, reused identity or sequence conflict; not an ACK",
  })
  @ApiResponse({
    status: 429,
    description: "Authenticated issuer rate limited",
  })
  @ApiResponse({
    status: 503,
    description:
      "Unavailable or ambiguous; exact replay may recover committed state",
  })
  receive(@Req() request: Request, @Res() response: Response): void {
    response
      .status(200)
      .type("application/jose")
      .setHeader("Cache-Control", "no-store");
    response.send(Buffer.from(consumePlatformFenceAck(request), "ascii"));
  }
}
