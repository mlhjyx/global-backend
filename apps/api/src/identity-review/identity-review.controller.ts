import { Type } from "class-transformer";
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  IsEmpty,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHideProperty,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from "../auth/acquisition-scope-inventory";
import { Ctx } from "../auth/ctx.decorator";
import { RequireScopes } from "../auth/require-scopes.decorator";
import type { RequestContext } from "../auth/request-context";
import { ApiEnvelope, ApiPageEnvelope } from "../common/api-envelope.decorator";
import { envelope, pageEnvelope } from "../common/envelope";
import { HUMAN_IDENTITY_REVIEW_DECISIONS } from "./identity-review.domain";
import { IdentityReviewService } from "./identity-review.service";

const SCOPES =
  ACQUISITION_CONTROLLER_SCOPE_INVENTORY.IdentityReviewController.operations;

class IdentityEvidenceRefDto {
  @ApiProperty({ enum: ["FIELD_EVIDENCE"] })
  @IsIn(["FIELD_EVIDENCE"])
  type!: "FIELD_EVIDENCE";

  @ApiProperty({ format: "uuid" })
  @IsUUID("4")
  id!: string;
}

export class AppendHumanIdentityDecisionDto {
  @ApiHideProperty()
  @IsEmpty()
  workspace_id?: never;

  @ApiHideProperty()
  @IsEmpty()
  actor_id?: never;

  @ApiHideProperty()
  @IsEmpty()
  actor_type?: never;

  @ApiHideProperty()
  @IsEmpty()
  decided_at?: never;

  @ApiHideProperty()
  @IsEmpty()
  created_at?: never;

  @ApiProperty({ format: "uuid" })
  @IsUUID("4")
  canonical_company_id!: string;

  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  linked_canonical_company_id?: string;

  @ApiProperty({ enum: HUMAN_IDENTITY_REVIEW_DECISIONS })
  @IsIn(HUMAN_IDENTITY_REVIEW_DECISIONS)
  decision!: "REVIEW_LINK" | "REJECT_LINK" | "SPLIT";

  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  rule_version!: string;

  @ApiProperty({ type: () => IdentityEvidenceRefDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => IdentityEvidenceRefDto)
  evidence_refs!: IdentityEvidenceRefDto[];
}

export class IdentityDecisionListQueryDto {
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

const DECISION_SCHEMA = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "canonicalCompanyId",
    "linkedCanonicalCompanyId",
    "decision",
    "ruleVersion",
    "evidenceRefs",
    "actorType",
    "actorId",
    "decidedAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    canonicalCompanyId: { type: "string", format: "uuid" },
    linkedCanonicalCompanyId: { type: "string", format: "uuid", nullable: true },
    decision: {
      type: "string",
      enum: ["AUTO_LINK", "REVIEW_LINK", "REJECT_LINK", "SPLIT"],
    },
    ruleVersion: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "object" } },
    actorType: { type: "string", enum: ["SYSTEM", "USER"] },
    actorId: { type: "string" },
    decidedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
  },
};

@ApiTags("Identity reviews")
@ApiBearerAuth()
@Controller("identity-reviews")
@UseGuards(AuthGuard)
export class IdentityReviewController {
  constructor(private readonly reviews: IdentityReviewService) {}

  @Post("decisions")
  @RequireScopes(...SCOPES.create)
  @ApiOperation({ summary: "Append an immutable human company identity decision" })
  @ApiEnvelope(DECISION_SCHEMA, { status: 201 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: AppendHumanIdentityDecisionDto,
  ) {
    return envelope(await this.reviews.create(ctx, dto));
  }

  @Get("companies/:canonicalCompanyId/decisions")
  @RequireScopes(...SCOPES.list)
  @ApiOperation({ summary: "List immutable identity decision history for a company" })
  @ApiPageEnvelope(DECISION_SCHEMA)
  async list(
    @Ctx() ctx: RequestContext,
    @Param("canonicalCompanyId", new ParseUUIDPipe({ version: "4" }))
    canonicalCompanyId: string,
    @Query() query: IdentityDecisionListQueryDto,
  ) {
    const result = await this.reviews.list(ctx, canonicalCompanyId, {
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    return pageEnvelope(result.records, result);
  }
}
