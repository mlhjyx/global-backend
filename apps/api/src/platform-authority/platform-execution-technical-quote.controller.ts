import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiExtension,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES } from "@global/contracts/platform-authority";

import { envelope, type Enveloped } from "../common/envelope";
import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_OPENAPI_SCHEMA,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_RESPONSE_OPENAPI_SCHEMA,
  platformTechnicalQuoteErrorSchema,
} from "./platform-execution-technical-quote.openapi";
import { PlatformExecutionTechnicalQuoteReaderService } from "./platform-execution-technical-quote-reader";
import {
  PlatformExecutionTechnicalQuoteError,
  type PlatformExecutionTechnicalQuoteV1,
} from "./platform-execution-technical-quote";
import {
  PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_BYTES,
  PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_COUNT,
  PlatformTechnicalQuoteServiceAuthenticationGuard,
} from "./platform-technical-quote-service-auth";

function requestInvalid(): never {
  throw new BadRequestException({
    error: {
      code: "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
      message: "platform technical quote request is invalid",
    },
  });
}

function quoteUnavailable(code: string): never {
  throw new ServiceUnavailableException({
    error: {
      code,
      message: "platform technical quote is unavailable",
    },
  });
}

@ApiTags("PlatformAuthority")
@Controller("platform-authority")
@UseGuards(PlatformTechnicalQuoteServiceAuthenticationGuard)
export class PlatformExecutionTechnicalQuoteController {
  constructor(
    private readonly quotes: PlatformExecutionTechnicalQuoteReaderService,
  ) {}

  @Post("technical-quote")
  @HttpCode(200)
  @ApiConsumes("application/json")
  @ApiExtension("x-required-service-scope", "platform-technical-quote.read")
  @ApiExtension("x-service-authentication", {
    kind: "injected-dedicated-service-verifier",
    identity_token_fallback: false,
    workspace_token_fallback: false,
    unsigned_fallback: false,
  })
  @ApiExtension(
    "x-maximum-request-body-bytes",
    PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES,
  )
  @ApiExtension(
    "x-maximum-request-header-bytes",
    PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_BYTES,
  )
  @ApiExtension(
    "x-maximum-request-header-count",
    PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_COUNT,
  )
  @ApiExtension(
    "x-maximum-response-body-bytes",
    PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES,
  )
  @ApiOperation({
    operationId: "readPlatformExecutionTechnicalQuote",
    summary: "Read one pure Platform execution technical quote",
    description:
      "Service-only, zero-side-effect technical safety envelope; not a customer price, balance or quota.",
  })
  @ApiBody({
    required: true,
    schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_OPENAPI_SCHEMA,
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["data"],
      properties: {
        data: PLATFORM_EXECUTION_TECHNICAL_QUOTE_RESPONSE_OPENAPI_SCHEMA,
      },
    },
  })
  @ApiResponse({
    status: 400,
    schema: platformTechnicalQuoteErrorSchema([
      "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
    ]),
  })
  @ApiResponse({
    status: 401,
    schema: platformTechnicalQuoteErrorSchema([
      "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED",
    ]),
  })
  @ApiResponse({
    status: 503,
    schema: platformTechnicalQuoteErrorSchema([
      "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
      "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
      "PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT",
    ]),
  })
  read(
    @Req() request: RawBodyRequest<Request>,
  ): Enveloped<PlatformExecutionTechnicalQuoteV1> {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !request.rawBody) {
      return requestInvalid();
    }
    try {
      return envelope(
        this.quotes.read({ contentType, rawBody: request.rawBody }),
      );
    } catch (error) {
      if (
        error instanceof PlatformExecutionTechnicalQuoteError &&
        error.code === "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID"
      ) {
        return requestInvalid();
      }
      if (
        error instanceof PlatformExecutionTechnicalQuoteError &&
        (error.code === "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE" ||
          error.code === "PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT")
      ) {
        return quoteUnavailable(error.code);
      }
      return quoteUnavailable("PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE");
    }
  }
}
