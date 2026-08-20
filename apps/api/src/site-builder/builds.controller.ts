import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { RequestContext } from "../auth/request-context";
import { ScopesGuard } from "../auth/scopes.guard";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { Enveloped, envelope } from "../common/envelope";
import { BuildsService } from "./builds.service";
import {
  SITE_BUILD_BUDGET_GRANT_HEADER,
  SiteBuildBudgetGrantVerifier,
} from "./site-build-budget-grant";
import { buildRequestHash, normalizeBuildRequest } from "./build-request-contract";
import { BUILD_PHASES } from "./build-progress";
import { CreateBuildDto } from "./dto/build.dto";
import { IDEMPOTENCY_KEY_PATTERN_SOURCE } from "./idempotency-key";

class BuildActionResponseDto {
  @ApiProperty({ format: "uuid" })
  buildId!: string;

  @ApiProperty()
  status!: string;
}

const COST_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "currency",
    "unit",
    "budget",
    "totals",
    "usage",
    "operations",
    "reconciliation",
  ],
  properties: {
    schemaVersion: {
      type: "string",
      enum: ["site-builder-cost-summary/v2"],
    },
    currency: { type: "string", enum: ["USD"] },
    unit: { type: "string", enum: ["microusd"] },
    budget: {
      type: "object",
      additionalProperties: false,
      required: [
        "capMicrousd",
        "authorizedCapMicrousd",
        "reservedMicrousd",
        "chargedMicrousd",
        "conservativeChargedMicrousd",
        "remainingMicrousd",
        "paidCallsEnabled",
        "disabledReason",
        "exhaustedAt",
      ],
      properties: {
        authorizedCapMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        conservativeChargedMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        capMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        reservedMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        chargedMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        remainingMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        paidCallsEnabled: { type: "boolean" },
        disabledReason: { type: "string", nullable: true },
        exhaustedAt: {
          type: "string",
          format: "date-time",
          nullable: true,
        },
      },
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: [
        "reportedCostMicrousd",
        "calculatedCostMicrousd",
        "estimatedCostMicrousd",
        "unknownOperations",
        "exactCostMicrousd",
        "upperBoundCostMicrousd",
      ],
      properties: {
        reportedCostMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        calculatedCostMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        estimatedCostMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        unknownOperations: { type: "integer", minimum: 0 },
        exactCostMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        upperBoundCostMicrousd: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["inputTokens", "outputTokens", "modelCalls", "toolCalls"],
      properties: {
        inputTokens: { type: "integer", minimum: 0 },
        outputTokens: { type: "integer", minimum: 0 },
        modelCalls: { type: "integer", minimum: 0 },
        toolCalls: { type: "integer", minimum: 0 },
      },
    },
    operations: {
      type: "object",
      additionalProperties: false,
      required: ["succeeded", "failed", "unknown", "released"],
      properties: {
        succeeded: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        unknown: { type: "integer", minimum: 0 },
        released: { type: "integer", minimum: 0 },
      },
    },
    reconciliation: {
      type: "object",
      additionalProperties: false,
      required: [
        "pendingOperations",
        "resolvedOperations",
        "conflictOperations",
        "asOf",
        "revision",
      ],
      properties: {
        pendingOperations: { type: "integer", minimum: 0 },
        resolvedOperations: { type: "integer", minimum: 0 },
        conflictOperations: { type: "integer", minimum: 0 },
        asOf: { type: "string", format: "date-time", nullable: true },
        revision: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

class BuildStatusResponseDto {
  @ApiProperty({ format: "uuid" })
  buildId!: string;

  @ApiProperty()
  kind!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: String, nullable: true, enum: BUILD_PHASES })
  phase!: string | null;

  @ApiProperty()
  progress!: number;

  @ApiProperty({
    type: "array",
    nullable: true,
    items: {
      type: "object",
      required: ["key", "status"],
      properties: {
        key: { type: "string" },
        status: { type: "string" },
        attempt: { type: "integer", minimum: 1 },
        progress: { type: "number", minimum: 0, maximum: 1 },
        degraded: { type: "boolean" },
        itemCount: { type: "integer", minimum: 0 },
        startedAt: { type: "string", format: "date-time", nullable: true },
        finishedAt: { type: "string", format: "date-time", nullable: true },
        errorCode: { type: "string", nullable: true },
        error: { type: "string", nullable: true },
      },
      // 旧 history 的 processed/failed/gaps 等字段继续兼容；R3-B2 的稳定字段显式声明。
      additionalProperties: true,
    },
  })
  steps!: Array<Record<string, unknown>> | null;

  @ApiProperty({
    ...COST_SUMMARY_SCHEMA,
    nullable: true,
  } as unknown as Parameters<typeof ApiProperty>[0])
  costSummary!: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "泛化错误；不含 worker/provider 诊断",
  })
  error!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  finishedAt!: Date | null;
}

function publicBuildFailure(run: {
  error: string | null;
  phase: string | null;
  steps: unknown;
}): { code: string; message: string } | null {
  if (!run.error) return null;
  const failedStep = Array.isArray(run.steps)
    ? [...run.steps]
        .reverse()
        .find(
          (step): step is Record<string, unknown> =>
            !!step && typeof step === "object" && step.status === "failed",
        )
    : undefined;
  const candidate = failedStep?.errorCode;
  const code =
    typeof candidate === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(candidate)
      ? candidate
      : "BUILD_FAILED";
  const phase =
    run.phase && BUILD_PHASES.includes(run.phase as (typeof BUILD_PHASES)[number])
      ? run.phase
      : "unknown_phase";
  const message =
    code.startsWith("BUDGET_") || code.includes("PAID_CALL")
      ? `build budget authorization failed during ${phase}`
      : code.includes("SETTLEMENT")
        ? `model cost reconciliation is pending during ${phase}`
        : `build could not complete during ${phase}`;
  return { code, message };
}

const BUILD_ERROR_CODES = [
  "VALIDATION_ERROR",
  "INVALID_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_KEY_REUSED",
  "NOT_FOUND",
  "BUILD_IN_PROGRESS",
  "BUILD_SCOPE_UNAVAILABLE",
  "BUILD_OPTION_UNAVAILABLE",
  "BUILD_TARGET_NOT_FOUND",
  "BUILD_TARGET_AMBIGUOUS",
  "BUILD_ACTIVE_SPEC_INVALID",
  "BUILD_NOT_CANCELLABLE",
  "BUILD_ALREADY_TERMINAL",
  "BUILD_LAUNCH_UNAVAILABLE",
  "BUDGET_GRANT_REQUIRED",
  "BUDGET_GRANT_INVALID",
  "BUDGET_GRANT_EXPIRED",
  "BUDGET_GRANT_SCOPE_MISMATCH",
  "BUDGET_GRANT_REUSED",
  "BUDGET_GRANT_VERIFICATION_UNAVAILABLE",
  "SITE_BUILD_RUNTIME_NOT_READY",
  "BUILD_CANCEL_UNAVAILABLE",
  "QUOTA_EXCEEDED",
] as const;

const BUILD_ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: [...BUILD_ERROR_CODES] },
        message: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
    },
  },
};

@ApiTags("SiteBuilder")
@ApiBearerAuth()
@Controller("site-builder")
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes("acquisition:read")
export class BuildsController {
  constructor(
    private readonly builds: BuildsService,
    private readonly budgetGrants: SiteBuildBudgetGrantVerifier,
  ) {}

  @Post("sites/:id/builds")
  @RequireScopes("acquisition:write")
  @HttpCode(201)
  @ApiOperation({
    summary: "触发精装修构建（07 §5；409=进行中，429=当日配额）",
  })
  @ApiEnvelope(BuildActionResponseDto, { status: 201 })
  @ApiBody({
    description:
      "R3-B2/M1-d：整站或 active SiteSpec 的 page/section/pages 局部构建；文案生成仅支持 en 与 de-DE",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: { type: "string", enum: ["site", "page", "section"] },
        targetId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "page/section 必填；site 禁止",
        },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            stylePreset: {
              type: "string",
              enum: ["modern-industrial", "precision-light"],
            },
            locales: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              uniqueItems: true,
              items: { type: "string", enum: ["en", "de-DE"] },
            },
            pages: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "UUID 或 build scope 校验失败",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: "当前 workspace 不可见该 Site，或 BUILD_TARGET_NOT_FOUND",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: "BUILD_IN_PROGRESS 或 IDEMPOTENCY_KEY_REUSED",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description:
      "BUILD_OPTION_UNAVAILABLE、BUILD_TARGET_AMBIGUOUS 或 BUILD_ACTIVE_SPEC_INVALID；未实现能力 fail-closed",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 429,
    description: "QUOTA_EXCEEDED；details.remaining 为剩余额度",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 502,
    description:
      "BUILD_LAUNCH_UNAVAILABLE；仅同一合法 Idempotency-Key 可安全重放",
    schema: BUILD_ERROR_SCHEMA,
  })
  // name 必须与 @Headers('idempotency-key') 推断名精确一致（含大小写）才会合并成单个 required:false 参数；
  // 大小写不一致会生成两个仅大小写不同的 header 参数，令 oasdiff 把契约与自身误判为破坏性变更（见 company.controller 同款约定）
  @ApiHeader({
    name: "idempotency-key",
    required: false,
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: `^${IDEMPOTENCY_KEY_PATTERN_SOURCE}$`,
    },
    description: "幂等键；同 key 异请求返回 409",
  })
  @ApiHeader({
    name: SITE_BUILD_BUDGET_GRANT_HEADER,
    required: true,
    schema: { type: "string", minLength: 1, maxLength: 16_384 },
    description: "SaaS 签发、绑定本次构建请求的一次性费用授权 JWS",
  })
  @ApiResponse({
    status: 402,
    description: "BUDGET_GRANT_REQUIRED、BUDGET_GRANT_INVALID 或 BUDGET_GRANT_EXPIRED",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 403,
    description: "BUDGET_GRANT_SCOPE_MISMATCH",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 503,
    description: "BUDGET_GRANT_VERIFICATION_UNAVAILABLE 或 SITE_BUILD_RUNTIME_NOT_READY",
    schema: BUILD_ERROR_SCHEMA,
  })
  async create(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) siteId: string,
    @Body() dto: CreateBuildDto,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers(SITE_BUILD_BUDGET_GRANT_HEADER) rawBudgetGrant?: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    const normalized = normalizeBuildRequest(dto);
    const budgetGrant = await this.budgetGrants.verify(rawBudgetGrant, {
      workspaceId: ctx.workspaceId,
      siteId,
      operation: "refurbish",
      requestSha256: buildRequestHash(siteId, normalized),
    });
    return envelope(
      await this.builds.create(ctx, siteId, {
        ...dto,
        idempotencyKey: idempotencyKey ?? null,
      }, budgetGrant),
    );
  }

  @Get("builds/:id")
  @ApiOperation({ summary: "构建进度（轮询；SSE 事件流按 07 §5 后置）" })
  @ApiEnvelope(BuildStatusResponseDto)
  @ApiResponse({
    status: 400,
    description: "Build UUID 格式错误",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: "当前 workspace 不可见该 Build",
    schema: BUILD_ERROR_SCHEMA,
  })
  async get(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) buildId: string,
  ): Promise<Enveloped<Record<string, unknown>>> {
    const run = await this.builds.get(ctx, buildId);
    const failure = publicBuildFailure(run);
    return envelope({
      buildId: run.id,
      kind: run.kind,
      status: run.status,
      phase: run.phase,
      progress: run.progress,
      steps: run.steps,
      costSummary: run.costSummary,
      // DB error 供内部诊断，可能含 provider/网络细节；公共 API 只返回稳定 code/message。
      error: failure?.message ?? null,
      errorCode: failure?.code ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  }

  @Post("builds/:id/cancel")
  @RequireScopes("acquisition:write")
  @HttpCode(200)
  @ApiOperation({ summary: "取消构建（终态 409）" })
  @ApiEnvelope(BuildActionResponseDto)
  @ApiResponse({
    status: 400,
    description: "Build UUID 格式错误",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: "当前 workspace 不可见该 Build",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: "BUILD_NOT_CANCELLABLE 或 BUILD_ALREADY_TERMINAL",
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 502,
    description:
      "BUILD_CANCEL_UNAVAILABLE；Temporal 未确认取消，run 保持 active，可按同 buildId 重试",
    schema: BUILD_ERROR_SCHEMA,
  })
  async cancel(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) buildId: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    return envelope(await this.builds.cancel(ctx, buildId));
  }
}
