import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequestContext } from "../auth/request-context";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { Enveloped, envelope } from "../common/envelope";
import { IntakeDto, IntakeResultDto } from "./dto/intake.dto";
import { IntakeService } from "./intake.service";

function intakeErrorSchema(codes: string[]) {
  return {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", enum: codes },
          message: { type: "string" },
        },
      },
    },
  };
}

@ApiTags("SiteBuilder")
@ApiBearerAuth()
@Controller("site-builder")
@UseGuards(AuthGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post("intake")
  @HttpCode(201)
  @ApiOperation({
    summary: "注册引导提交：无条件建站档案并秒级触发 demo v0",
  })
  // 与 @Headers 参数保持完全同名，避免 OpenAPI 生成两个大小写不同的 header。
  @ApiHeader({
    name: "idempotency-key",
    required: false,
    description: "幂等键（1–128 位字母、数字、点、下划线、冒号或连字符）",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  })
  @ApiResponse({
    status: 400,
    description: "请求字段或 idempotency-key 非法",
    schema: intakeErrorSchema(["INVALID_IDEMPOTENCY_KEY", "VALIDATION_ERROR"]),
  })
  @ApiResponse({
    status: 409,
    description: "幂等键复用冲突或 workspace 已有站点",
    schema: intakeErrorSchema(["IDEMPOTENCY_KEY_REUSED", "SITE_LIMIT_REACHED"]),
  })
  @ApiResponse({
    status: 502,
    description: "demo workflow 启动 ACK 不可用；有 key 时应同 key 重试",
    schema: intakeErrorSchema(["DEMO_LAUNCH_UNAVAILABLE"]),
  })
  @ApiEnvelope(IntakeResultDto, { status: 201 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: IntakeDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<Enveloped<IntakeResultDto>> {
    return envelope(
      IntakeResultDto.from(await this.intake.create(ctx, dto, idempotencyKey)),
    );
  }
}
