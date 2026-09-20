import { Controller, Get, Req, Res } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import {
  RuntimeClockService,
  RUNTIME_CLOCK_SCHEMA,
} from "./runtime-clock.service";

@ApiTags("System")
@Controller("health")
export class RuntimeClockController {
  constructor(private readonly clock: RuntimeClockService) {}
  @Get("clock")
  @ApiOperation({
    operationId: "readRuntimeClock_v1",
    summary: "Nonce-bound admitted relative clock observation",
  })
  @ApiQuery({
    name: "nonce",
    required: true,
    schema: { type: "string", pattern: "^[a-f0-9]{32}$" },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "nonce",
        "observedAt",
        "buildSha",
        "imageDigest",
        "artifactDigest",
      ],
      properties: {
        schemaVersion: { type: "string", enum: [RUNTIME_CLOCK_SCHEMA] },
        nonce: { type: "string", pattern: "^[a-f0-9]{32}$" },
        observedAt: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        buildSha: { type: "string", pattern: "^[a-f0-9]{40}$" },
        imageDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        artifactDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    },
  })
  @ApiBadRequestResponse({
    description: "Noncanonical clock observation request",
  })
  @ApiServiceUnavailableResponse({
    description: "Own release admission or local clock unavailable",
  })
  read(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return this.clock.observe(request.originalUrl);
  }
}
