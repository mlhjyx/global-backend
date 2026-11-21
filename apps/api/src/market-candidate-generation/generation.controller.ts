import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { BudgetStoreUnavailableError } from "../tools/budget-store";
import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { ScopesGuard } from "../auth/scopes.guard";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { Ctx } from "../auth/ctx.decorator";
import type { RequestContext } from "../auth/request-context";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { envelope } from "../common/envelope";
import {
  ApiExecutionBudgetGrant,
  asExecutionBudgetHttpBoundary,
  ExecutionBudgetGrant,
} from "../execution-budget/execution-budget-grant.decorator";
import { normalizeGenerationPrepare } from "./generation-basis";
import {
  MarketCandidateGenerationService,
  type GenerationView,
} from "./generation.service";
import {
  MarketCandidateGenerationDto,
  MarketCandidateGenerationExecuteDto,
  MarketCandidateGenerationPrepareDto,
  generationExecuteBody,
  generationRecoverBody,
} from "./dto/market-candidate-generation.dto";
const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
};
async function generationHttp<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await asExecutionBudgetHttpBoundary(operation);
  } catch (error) {
    if (error instanceof HttpException) throw error;
    if (
      error instanceof ExecutionControlError ||
      error instanceof BudgetStoreUnavailableError
    )
      throw new ServiceUnavailableException({
        error: {
          code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
          message: "生成执行验证暂不可用，请保留原操作恢复",
        },
      });
    if (
      error instanceof Error &&
      error.message ===
        "required context segments exceed the model context budget"
    )
      throw new BadRequestException({
        error: {
          code: "VALIDATION_ERROR",
          message: "完整生成材料超出实际模型上下文，请缩小明确选择的依据范围",
        },
      });
    throw error;
  }
}
function pendingStatus(response: Response, value: GenerationView): void {
  response.status(
    ["RUNNING", "RESULT_UNKNOWN", "RESULT_READY"].includes(value.phase)
      ? 202
      : 200,
  );
}

@ApiTags("Market Candidate Generations")
@ApiBearerAuth()
@ApiResponse({
  status: 400,
  description: "VALIDATION_ERROR：严格输入、依据或输出合同不合法。",
  schema: errorSchema,
})
@ApiResponse({
  status: 401,
  description: "需要有效的普通 SaaS 用户身份。",
  schema: errorSchema,
})
@ApiResponse({
  status: 403,
  description: "缺少当前 workspace 读取/写入权限或不是本意图请求者。",
  schema: errorSchema,
})
@ApiResponse({
  status: 404,
  description: "生成意图或公司不存在、已删除或不属于当前 workspace。",
  schema: errorSchema,
})
@ApiResponse({
  status: 409,
  description:
    "VERSION_CONFLICT 或 IDEMPOTENCY_CONFLICT；保留原账，不覆盖后发意图或反馈。",
  schema: errorSchema,
})
@ApiResponse({
  status: 503,
  description: "运行准入关闭或执行/存储验证暂不可用，不能据此重发模型。",
  schema: errorSchema,
})
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
export class MarketCandidateGenerationsController {
  constructor(
    @Inject(MarketCandidateGenerationService)
    private readonly service: MarketCandidateGenerationService,
  ) {}
  @Post("companies/:companyId/market-candidate-generations")
  @HttpCode(200)
  @RequireScopes("acquisition:write")
  @ApiOperation({
    operationId: "MarketCandidateGenerationsController_prepare_v1",
    summary: "准备一次明确的市场候选生成意图",
    description:
      "持久化严格的结构化依据描述与摘要，按用户/公司/意图幂等。只准备，不消费 Grant，不调用模型、搜索或下游执行。默认来源溢出明确拒绝，不截断。",
  })
  @ApiParam({ name: "companyId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: MarketCandidateGenerationPrepareDto })
  @ApiEnvelope(MarketCandidateGenerationDto)
  async prepare(
    @Ctx() ctx: RequestContext,
    @Param("companyId", ParseUUIDPipe) companyId: string,
    @Body() body: unknown,
  ) {
    return envelope(
      await generationHttp(() =>
        this.service.prepare(ctx, companyId, normalizeGenerationPrepare(body)),
      ),
    );
  }
  @Get("market-candidate-generations/:generationId")
  @RequireScopes("acquisition:read")
  @ApiOperation({
    operationId: "MarketCandidateGenerationsController_get_v1",
    summary: "读取已持久化的生成状态",
    description:
      "普通租户只读入口，不调用模型或消费新授权。PERSISTED 的集合引用必须经 B1 初始修订权威冷读；NOT_APPLIED 只读既有域决定，永不返回可用集合。",
  })
  @ApiParam({
    name: "generationId",
    schema: { type: "string", format: "uuid" },
  })
  @ApiEnvelope(MarketCandidateGenerationDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param("generationId", ParseUUIDPipe) generationId: string,
  ) {
    return envelope(
      await generationHttp(() => this.service.get(ctx, generationId)),
    );
  }
  @Post("market-candidate-generations/:generationId/execute")
  @HttpCode(200)
  @RequireScopes("acquisition:write")
  @ApiOperation({
    operationId: "MarketCandidateGenerationsController_execute_v1",
    summary: "在精确预算授权下执行一次市场候选生成",
    description:
      "先重建完整输入与实际模型上下文，再消费绑定当前意图的 market.candidates.generate 授权。整个逻辑意图全部账户和 attempts 共80美分上界，单任务40美分与原结构化修复倍率2不变。重复调用恢复原结果，UNKNOWN 不重发。",
  })
  @ApiParam({
    name: "generationId",
    schema: { type: "string", format: "uuid" },
  })
  @ApiBody({ type: MarketCandidateGenerationExecuteDto })
  @ApiExecutionBudgetGrant()
  @ApiEnvelope(MarketCandidateGenerationDto, {
    status: 202,
    description: "仍在执行、结果未知或已有结果等待保存；不表示候选集合可用。",
  })
  @ApiEnvelope(MarketCandidateGenerationDto)
  async execute(
    @Ctx() ctx: RequestContext,
    @Param("generationId", ParseUUIDPipe) generationId: string,
    @Body() body: unknown,
    @ExecutionBudgetGrant() grant: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const value = await generationHttp(() =>
      this.service.execute(
        ctx,
        generationId,
        generationExecuteBody(body),
        grant,
      ),
    );
    pendingStatus(response, value);
    return envelope(value);
  }
  @Post("market-candidate-generations/:generationId/recover")
  @HttpCode(200)
  @RequireScopes("acquisition:write")
  @ApiOperation({
    operationId: "MarketCandidateGenerationsController_recover_v1",
    summary: "只恢复原结果及未完成保存",
    description:
      "当前合法请求者读取原账本 SETTLED 投影，恢复同事务 B1 保存/合法未应用决定及准确 ACK。无模型 dispatch、Grant 签发或消费能力；无结果、RESERVED 与 UNKNOWN 都不能触发新 wire。仍受全局写准入，无控制面或恢复豁免。",
  })
  @ApiParam({
    name: "generationId",
    schema: { type: "string", format: "uuid" },
  })
  @ApiEnvelope(MarketCandidateGenerationDto, {
    status: 202,
    description: "已知结果仍待保存或旧执行仍未决；保留原身份，不购买新执行。",
  })
  @ApiEnvelope(MarketCandidateGenerationDto)
  async recover(
    @Ctx() ctx: RequestContext,
    @Param("generationId", ParseUUIDPipe) generationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    generationRecoverBody(body);
    const value = await generationHttp(() =>
      this.service.recover(ctx, generationId),
    );
    pendingStatus(response, value);
    return envelope(value);
  }
}
