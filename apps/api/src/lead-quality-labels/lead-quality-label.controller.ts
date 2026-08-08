import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHideProperty,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  IsEmpty,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from "class-validator";
import { AuthGuard } from "../auth/auth.guard";
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from "../auth/acquisition-scope-inventory";
import { Ctx } from "../auth/ctx.decorator";
import { RequireScopes } from "../auth/require-scopes.decorator";
import type { RequestContext } from "../auth/request-context";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { envelope } from "../common/envelope";
import {
  LEAD_QUALITY_COMMERCIAL_RESULTS,
  LEAD_QUALITY_HELD_REASONS,
  LEAD_QUALITY_LABELS,
  LEAD_QUALITY_REASON_CODES,
  type LeadQualityCommercialResult,
  type LeadQualityLabel,
  type LeadQualityReasonCode,
} from "./lead-quality-label.domain";
import { LeadQualityLabelsService } from "./lead-quality-label.service";

const VISIBLE_ASCII = /^[!-~]+$/;
const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9._-]*$/;
const LABEL_SCOPES =
  ACQUISITION_CONTROLLER_SCOPE_INVENTORY.LeadQualityLabelsController.operations;

export class CreateLeadQualityLabelDto {
  @ApiHideProperty()
  @IsEmpty({
    message: "workspace_id is derived from the authenticated request context",
  })
  workspace_id?: never;

  @ApiHideProperty()
  @IsEmpty({
    message: "actor_id is derived from the authenticated request context",
  })
  actor_id?: never;

  @ApiProperty({
    description: "Opaque idempotency key from source_system",
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  @Matches(VISIBLE_ASCII)
  source_event_id!: string;

  @ApiProperty({ format: "uuid" })
  @IsUUID("4")
  lead_id!: string;

  @ApiProperty({
    format: "uuid",
    description: "Exact LeadQualified envelope event_id",
  })
  @IsUUID("4")
  lead_qualified_event_id!: string;

  @ApiProperty({ enum: LEAD_QUALITY_LABELS })
  @IsIn(LEAD_QUALITY_LABELS)
  label!: LeadQualityLabel;

  @ApiProperty({ format: "date-time" })
  @IsISO8601({ strict: true, strictSeparator: true })
  occurred_at!: string;

  @ApiProperty({ minLength: 1, maxLength: 64, pattern: SOURCE_SYSTEM.source })
  @IsString()
  @Length(1, 64)
  @Matches(SOURCE_SYSTEM)
  source_system!: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 256 })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  @Matches(VISIBLE_ASCII)
  external_object_ref?: string;

  @ApiPropertyOptional({ enum: LEAD_QUALITY_REASON_CODES })
  @IsOptional()
  @IsIn(LEAD_QUALITY_REASON_CODES)
  reason_code?: LeadQualityReasonCode;

  @ApiPropertyOptional({ enum: LEAD_QUALITY_COMMERCIAL_RESULTS })
  @IsOptional()
  @IsIn(LEAD_QUALITY_COMMERCIAL_RESULTS)
  commercial_result?: LeadQualityCommercialResult;
}

const LABEL_RESPONSE_SCHEMA = {
  type: "object",
  required: [
    "id",
    "source_event_id",
    "lead_id",
    "lead_qualified_event_id",
    "label",
    "occurred_at",
    "source_system",
    "external_object_ref",
    "reason_code",
    "commercial_result",
    "disposition",
    "held_reason",
    "ingested_at",
    "replayed",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    source_event_id: { type: "string" },
    lead_id: { type: "string", format: "uuid" },
    lead_qualified_event_id: { type: "string", format: "uuid" },
    label: { type: "string", enum: LEAD_QUALITY_LABELS },
    occurred_at: { type: "string", format: "date-time" },
    source_system: { type: "string" },
    external_object_ref: { type: "string", nullable: true },
    reason_code: {
      type: "string",
      enum: LEAD_QUALITY_REASON_CODES,
      nullable: true,
    },
    commercial_result: {
      type: "string",
      enum: LEAD_QUALITY_COMMERCIAL_RESULTS,
      nullable: true,
    },
    disposition: { type: "string", enum: ["ACCEPTED", "HELD"] },
    held_reason: {
      type: "string",
      enum: LEAD_QUALITY_HELD_REASONS,
      nullable: true,
    },
    ingested_at: { type: "string", format: "date-time" },
    replayed: { type: "boolean" },
  },
};

@ApiTags("Lead quality labels")
@ApiBearerAuth()
@Controller("lead-quality-labels")
@UseGuards(AuthGuard)
export class LeadQualityLabelsController {
  constructor(private readonly labels: LeadQualityLabelsService) {}

  @Post()
  @RequireScopes(...LABEL_SCOPES.create)
  @HttpCode(201)
  @ApiOperation({
    summary:
      "Append a downstream lead quality fact without creating Opportunity/QGO state",
  })
  @ApiEnvelope(LABEL_RESPONSE_SCHEMA, { status: 201 })
  @ApiResponse({
    status: 409,
    description:
      "source_system + source_event_id was replayed with different content",
    schema: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string", enum: ["SOURCE_EVENT_CONFLICT"] },
            message: { type: "string" },
          },
        },
      },
    },
  })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateLeadQualityLabelDto,
  ) {
    const result = await this.labels.create(ctx, dto);
    return envelope({ ...result.record, replayed: result.replayed });
  }
}
