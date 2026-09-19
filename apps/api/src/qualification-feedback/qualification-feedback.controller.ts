import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { ScopesGuard } from "../auth/scopes.guard";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { Ctx } from "../auth/ctx.decorator";
import type { RequestContext } from "../auth/request-context";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { envelope } from "../common/envelope";
import { QualificationFeedbackService } from "./qualification-feedback.service";
import { QUALIFICATION_FEEDBACK_SCHEMA } from "./qualification-feedback.contract";

export const QUALIFICATION_FEEDBACK_RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "receiptId",
    "eventId",
    "workspaceId",
    "eventDigest",
    "receivedAt",
  ],
  properties: {
    status: { type: "string", enum: ["RECORDED"] },
    receiptId: { type: "string", format: "uuid" },
    eventId: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    eventDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    receivedAt: { type: "string", format: "date-time" },
  },
};
const statusSchema = {
  oneOf: [
    QUALIFICATION_FEEDBACK_RECEIPT_SCHEMA,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "eventId", "workspaceId"],
      properties: {
        status: { type: "string", enum: ["NOT_RECEIVED"] },
        eventId: { type: "string", format: "uuid" },
        workspaceId: { type: "string", format: "uuid" },
      },
    },
  ],
};
const headers = {
  "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
};
@ApiTags("QualificationFeedback")
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes("acquisition:label:write")
@Controller({ path: "qualification-feedback", version: "1" })
export class QualificationFeedbackController {
  constructor(
    @Inject(QualificationFeedbackService)
    private readonly service: QualificationFeedbackService,
  ) {}
  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "QualificationFeedbackController_receive_v1",
    summary: "Record one SaaS qualification feedback reference",
    description:
      "Requires the verified growthos-qualification-feedback service subject and acquisition:label:write. Does not change Lead status, scoring or ICP labels.",
  })
  @ApiBody({
    schema: structuredClone(
      QUALIFICATION_FEEDBACK_SCHEMA,
    ) as unknown as SchemaObject,
  })
  @ApiEnvelope(QUALIFICATION_FEEDBACK_RECEIPT_SCHEMA, { headers })
  async receive(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return envelope(await this.service.receive(ctx, body));
  }

  @Get(":eventId/receipt")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "QualificationFeedbackController_receipt_v1",
    summary: "Read a workspace-scoped qualification feedback receipt",
    description:
      "Read-only reconciliation after response loss. NOT_RECEIVED is a current observation, not permission to change the source event identity.",
  })
  @ApiParam({ name: "eventId", format: "uuid" })
  @ApiEnvelope(statusSchema, { headers })
  async receipt(@Ctx() ctx: RequestContext, @Param("eventId") eventId: string) {
    return envelope(await this.service.receipt(ctx, eventId));
  }
}
