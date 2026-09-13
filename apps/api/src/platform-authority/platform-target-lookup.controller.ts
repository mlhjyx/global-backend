import {
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiExtension,
  ApiOperation,
  ApiBody,
  ApiResponse,
} from "@nestjs/swagger";
import {
  PLATFORM_AUTHORITY_TARGET_LOOKUP_OPERATION_ID,
  PLATFORM_AUTHORITY_TARGET_READER_TYPE,
  PLATFORM_AUTHORITY_TARGET_READER_AUDIENCE,
  PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
  type PlatformAuthorityTargetObservation,
} from "@global/contracts/platform-authority/target-lookup";
import { ReadOnlyControlPlane } from "../runtime/read-only-control-plane.decorator";
import {
  PlatformTargetLookupGuard,
  savedPlatformTargetObservation,
} from "./platform-target-lookup.guard";
import {
  PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME,
  PLATFORM_TARGET_LOOKUP_REQUEST_OPENAPI_SCHEMA,
  PLATFORM_TARGET_LOOKUP_RESPONSE_OPENAPI_SCHEMA,
  platformTargetLookupErrorSchema,
} from "./platform-target-lookup.openapi";

@ApiTags("PlatformAuthority")
@Controller("platform-authority")
@ApiBearerAuth(PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME)
@UseGuards(PlatformTargetLookupGuard)
export class PlatformTargetLookupController {
  @Post("target-lookup")
  @ReadOnlyControlPlane()
  @HttpCode(200)
  @ApiConsumes("application/json")
  @ApiExtension(
    "x-required-service-scope",
    PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
  )
  @ApiExtension("x-service-authentication", {
    kind: "growthos-identity-jwks-service-token",
    algorithm: "RS256",
    type: PLATFORM_AUTHORITY_TARGET_READER_TYPE,
    audience: PLATFORM_AUTHORITY_TARGET_READER_AUDIENCE,
    scope: PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
    subject: "fixed deployment configuration",
    identity_token_fallback: false,
    workspace_token_fallback: false,
    unsigned_fallback: false,
  })
  @ApiExtension("x-maximum-request-body-bytes", 4096)
  @ApiExtension("x-maximum-response-body-bytes", 4096)
  @ApiExtension("x-maximum-request-header-count", 64)
  @ApiExtension("x-maximum-request-header-bytes", 32768)
  @ApiExtension("x-content-encoding", "identity-only")
  @ApiExtension("x-maximum-deadline-milliseconds", 2000)
  @ApiOperation({
    operationId: PLATFORM_AUTHORITY_TARGET_LOOKUP_OPERATION_ID,
    summary: "Read an exact committed platform authority target locator",
    description:
      "Service-only read. Never creates authority or fences a schedule. Returns the observation root without a data wrapper; all responses are no-store.",
  })
  @ApiBody({
    required: true,
    schema: PLATFORM_TARGET_LOOKUP_REQUEST_OPENAPI_SCHEMA,
  })
  @ApiResponse({
    status: 200,
    schema: PLATFORM_TARGET_LOOKUP_RESPONSE_OPENAPI_SCHEMA,
  })
  @ApiResponse({
    status: 400,
    schema: platformTargetLookupErrorSchema("invalid"),
  })
  @ApiResponse({
    status: 401,
    schema: platformTargetLookupErrorSchema("denied"),
  })
  @ApiResponse({
    status: 403,
    schema: platformTargetLookupErrorSchema("scope"),
  })
  @ApiResponse({
    status: 404,
    schema: platformTargetLookupErrorSchema("notFound"),
  })
  @ApiResponse({
    status: 429,
    schema: platformTargetLookupErrorSchema("rateLimited"),
  })
  @ApiResponse({
    status: 503,
    schema: platformTargetLookupErrorSchema("unavailable"),
  })
  read(
    @Req() request: RawBodyRequest<Request>,
  ): PlatformAuthorityTargetObservation {
    return savedPlatformTargetObservation(request);
  }
}
