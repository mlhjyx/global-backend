/**
 * 评估学 API（获客 vNext W3）。
 *
 * 权限：写评估集/标注用 `acquisition:label:write`（人工判定的写入侧），
 * 读报告与覆盖估计用 `acquisition:read`。BFF（gain-saas 运营台）按角色映射，
 * 本控制器只认 scope。
 *
 * 端点：
 *   POST /evaluation/sets             新建评估集（名称+版本唯一）
 *   POST /evaluation/sets/:id/labels  批量标注（同集同候选键覆盖）
 *   GET  /evaluation/sets/:id/report  precision@k 报告（对照某次 run 的产出）
 *   GET  /evaluation/coverage         双源 Chapman 覆盖估计（自动存证）
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { RequestContext } from "../auth/request-context";
import { ScopesGuard } from "../auth/scopes.guard";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { envelope, Enveloped } from "../common/envelope";
import { EvaluationService, EvaluationSetExistsError, EvaluationSetNotFoundError } from "./evaluation.service";

const SET_SCHEMA = {
  type: "object",
  required: ["id", "name", "version", "icpId", "description", "createdBy", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    version: { type: "integer" },
    icpId: { type: "string", nullable: true },
    description: { type: "string", nullable: true },
    createdBy: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

const LABELS_RESULT_SCHEMA = {
  type: "object",
  required: ["setId", "upserted"],
  properties: {
    setId: { type: "string" },
    upserted: { type: "integer" },
  },
  additionalProperties: false,
} as const;

const REPORT_ROW_SCHEMA = {
  type: "object",
  required: ["canonicalCompanyId", "name", "domain", "country", "verdict", "score", "label"],
  properties: {
    canonicalCompanyId: { type: "string" },
    name: { type: "string" },
    domain: { type: "string", nullable: true },
    country: { type: "string", nullable: true },
    verdict: { type: "string" },
    score: { type: "number" },
    label: { type: "string", enum: ["POSITIVE", "NEGATIVE"], nullable: true },
  },
  additionalProperties: false,
} as const;

const REPORT_SCHEMA = {
  type: "object",
  required: [
    "set",
    "runId",
    "providerKey",
    "k",
    "candidateCount",
    "evaluated",
    "hits",
    "negatives",
    "unlabeled",
    "precisionAtK",
    "precisionAtLabeledK",
    "top",
  ],
  properties: {
    set: SET_SCHEMA,
    runId: { type: "string" },
    providerKey: { type: "string", nullable: true },
    k: { type: "integer" },
    candidateCount: { type: "integer" },
    evaluated: { type: "integer" },
    hits: { type: "integer" },
    negatives: { type: "integer" },
    unlabeled: { type: "integer" },
    precisionAtK: { type: "number", nullable: true },
    precisionAtLabeledK: { type: "number", nullable: true },
    top: { type: "array", items: REPORT_ROW_SCHEMA },
  },
  additionalProperties: false,
} as const;

const COVERAGE_SCHEMA = {
  type: "object",
  required: [
    "region",
    "category",
    "sourceA",
    "sourceB",
    "countA",
    "countB",
    "overlap",
    "estimator",
    "estimable",
    "reason",
    "observedUnion",
    "estimate",
    "ciLow",
    "ciHigh",
    "recallEstimate",
    "warning",
    "computedAt",
  ],
  properties: {
    region: { type: "string" },
    category: { type: "string" },
    sourceA: { type: "string" },
    sourceB: { type: "string" },
    countA: { type: "integer" },
    countB: { type: "integer" },
    overlap: { type: "integer" },
    estimator: { type: "string" },
    estimable: { type: "boolean" },
    reason: { type: "string", enum: ["EMPTY_SOURCE"], nullable: true },
    observedUnion: { type: "integer" },
    estimate: { type: "number", nullable: true },
    ciLow: { type: "number", nullable: true },
    ciHigh: { type: "number", nullable: true },
    recallEstimate: { type: "number", nullable: true },
    warning: { type: "string", enum: ["ZERO_OVERLAP"], nullable: true },
    computedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

class CreateEvaluationSetDto {
  @ApiProperty({ maxLength: 200, description: "评估集名称；与 version 组成唯一键" })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ minimum: 1, default: 1, description: "版本号（同集改名/换口径时递增）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({ description: "ICP 口径引用（可空）；ICP 删除时置空保留历史", nullable: true })
  @IsOptional()
  @IsUUID()
  icpId?: string | null;

  @ApiPropertyOptional({ maxLength: 4000, description: "口径说明：地区×品类、抽样规则、标注约定" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 200, description: "创建者标识；缺省取 token 的 userId" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  createdBy?: string | null;
}

class EvaluationLabelDto {
  @ApiPropertyOptional({ description: "候选公司（本 workspace canonical id）", nullable: true })
  @IsOptional()
  @IsUUID()
  canonicalCompanyId?: string | null;

  @ApiPropertyOptional({ maxLength: 253, description: "候选域名（无 canonical id 时的引用）" })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  domain?: string | null;

  @ApiPropertyOptional({ maxLength: 400, description: "候选公司名（与 country 搭配的引用）" })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  name?: string | null;

  @ApiPropertyOptional({ maxLength: 64, description: "国家（name 引用时建议带上）" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  country?: string | null;

  @ApiProperty({ enum: ["POSITIVE", "NEGATIVE"], description: "人工判定：是否命中 ICP" })
  @IsIn(["POSITIVE", "NEGATIVE"])
  label!: "POSITIVE" | "NEGATIVE";

  @ApiPropertyOptional({ maxLength: 2000, description: "备注（判定依据）" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({ maxLength: 200, description: "标注者标识；缺省取 token 的 userId" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  labeledBy?: string | null;
}

class AddEvaluationLabelsDto {
  @ApiProperty({ type: [EvaluationLabelDto], description: "1..500 条；同集同候选键后写覆盖先写" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => EvaluationLabelDto)
  labels!: EvaluationLabelDto[];
}

function invalid(error: unknown): never {
  if (error instanceof Error && error.message.startsWith("EVALUATION_")) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

@ApiTags("Metrics")
@ApiBearerAuth()
@Controller("evaluation")
@UseGuards(AuthGuard, ScopesGuard)
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @Post("sets")
  @RequireScopes("acquisition:label:write")
  @HttpCode(201)
  @ApiOperation({
    summary: "新建评估集（golden set 的版本化容器）",
  })
  @ApiEnvelope(SET_SCHEMA)
  async createSet(
    @Ctx() ctx: RequestContext,
    @Body() body: CreateEvaluationSetDto,
  ): Promise<Enveloped<unknown>> {
    try {
      return envelope(await this.evaluation.createSet(ctx, body));
    } catch (error) {
      if (error instanceof EvaluationSetExistsError) {
        throw new ConflictException({ error: { code: "EVALUATION_SET_EXISTS", message: error.message } });
      }
      throw error;
    }
  }

  @Post("sets/:id/labels")
  @RequireScopes("acquisition:label:write")
  @HttpCode(201)
  @ApiOperation({
    summary: "批量标注（同集同候选键覆盖，重标注即更新）",
  })
  @ApiEnvelope(LABELS_RESULT_SCHEMA)
  async addLabels(
    @Ctx() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) setId: string,
    @Body() body: AddEvaluationLabelsDto,
  ): Promise<Enveloped<unknown>> {
    if (body.labels.some((entry) => !entry.canonicalCompanyId && !entry.domain && !entry.name)) {
      throw new BadRequestException(
        "EVALUATION_LABEL_CANDIDATE_MISSING: canonicalCompanyId/domain/name 至少一个",
      );
    }
    try {
      return envelope(await this.evaluation.addLabels(ctx, setId, body.labels));
    } catch (error) {
      if (error instanceof EvaluationSetNotFoundError) {
        throw new NotFoundException({ error: { code: "EVALUATION_SET_NOT_FOUND", message: error.message } });
      }
      if (error instanceof Error && error.message.startsWith("EVALUATION_")) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get("sets/:id/report")
  @RequireScopes("acquisition:read")
  @ApiOperation({
    summary: "precision@k 报告：某次 run（可限单源）的候选排名 vs 评估集标注",
  })
  @ApiQuery({
    name: "runId",
    required: true,
    description: "discovery run id（uuid）",
    schema: { type: "string", format: "uuid" },
  })
  @ApiQuery({
    name: "providerKey",
    required: false,
    description: "只看某一发现源（provider_key）产出的候选；缺省用该 run 全部去重候选",
    schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
  })
  @ApiQuery({
    name: "k",
    required: false,
    description: "截断深度，默认 10，最大 50",
    schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  })
  @ApiEnvelope(REPORT_SCHEMA)
  async report(
    @Ctx() ctx: RequestContext,
    @Param("id", new ParseUUIDPipe()) setId: string,
    @Query("runId") runId?: string,
    @Query("providerKey") providerKey?: string,
    @Query("k") k?: string,
  ): Promise<Enveloped<unknown>> {
    if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
      throw new BadRequestException("EVALUATION_REPORT_RUN_INVALID: runId 必须是 uuid");
    }
    const parsedK = k === undefined ? undefined : Number(k);
    if (parsedK !== undefined && (!Number.isInteger(parsedK) || parsedK < 1 || parsedK > 50)) {
      throw new BadRequestException("EVALUATION_REPORT_K_INVALID: k 必须是 1..50 的整数");
    }
    try {
      return envelope(
        await this.evaluation.report(ctx, setId, {
          runId,
          providerKey: providerKey ?? null,
          k: parsedK,
        }),
      );
    } catch (error) {
      if (error instanceof EvaluationSetNotFoundError) {
        throw new NotFoundException({ error: { code: "EVALUATION_SET_NOT_FOUND", message: error.message } });
      }
      invalid(error);
    }
  }

  @Get("coverage")
  @RequireScopes("acquisition:read")
  @ApiOperation({
    summary: "双源 Chapman 覆盖估计（95% CI），结果按口径+计数存证到 coverage_estimate",
  })
  @ApiQuery({
    name: "sourceA",
    required: true,
    description: "发现源 A 的 provider_key",
    schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
  })
  @ApiQuery({
    name: "sourceB",
    required: true,
    description: "发现源 B 的 provider_key（须与 A 不同）",
    schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
  })
  @ApiQuery({
    name: "region",
    required: true,
    description: "地区（匹配 canonical_company.country，大小写不敏感）",
    schema: { type: "string", maxLength: 80 },
  })
  @ApiQuery({
    name: "category",
    required: true,
    description: "品类（匹配 canonical_company.industry，大小写不敏感）",
    schema: { type: "string", maxLength: 200 },
  })
  @ApiEnvelope(COVERAGE_SCHEMA)
  async coverage(
    @Ctx() ctx: RequestContext,
    @Query("sourceA") sourceA?: string,
    @Query("sourceB") sourceB?: string,
    @Query("region") region?: string,
    @Query("category") category?: string,
  ): Promise<Enveloped<unknown>> {
    if (!sourceA || !sourceB || !region || !category) {
      throw new BadRequestException(
        "EVALUATION_COVERAGE_INPUT_MISSING: sourceA/sourceB/region/category 均必填",
      );
    }
    try {
      return envelope(await this.evaluation.coverage(ctx, { sourceA, sourceB, region, category }));
    } catch (error) {
      invalid(error);
    }
  }
}
