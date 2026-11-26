import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { envelope, type Enveloped } from "../common/envelope";
import {
  resolvePlatformAuthorityMode,
  type PlatformAuthorityMode,
} from "./platform-authority-mode";
import {
  CANONICAL_PLATFORM_SCHEDULE_IDS,
  PlatformScheduleConfigError,
  PlatformScheduleConfigService,
  type PlatformScheduleConfigRow,
  type PlatformScheduleConfigToggleAudit,
} from "./platform-schedule-config.service";
import { PlatformScheduleConfigServiceTokenGuard } from "./platform-schedule-config-service-token.guard";

export class UpdatePlatformScheduleConfigDto {
  @ApiProperty({
    description: "是否启用该平台定时调度（false 表示立即触发 Kill Switch 停用）",
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    description: "操作者身份标识（写入数据库与审计日志）",
    example: "ops-admin@example.com",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  updatedBy!: string;

  @ApiPropertyOptional({
    description: "本次启停原因说明（写入操作审计日志）",
    example: "enable daily sanctions refresh after smoke verification",
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}

export interface PlatformScheduleConfigResponseItem {
  readonly scheduleId: string;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface ListPlatformScheduleConfigsResponse {
  readonly mode: PlatformAuthorityMode;
  readonly schedules: readonly PlatformScheduleConfigResponseItem[];
}

export interface UpdatePlatformScheduleConfigResponse {
  readonly mode: PlatformAuthorityMode;
  readonly config: PlatformScheduleConfigResponseItem;
  readonly audit: PlatformScheduleConfigToggleAudit;
}

function serializeConfig(
  row: PlatformScheduleConfigRow,
): PlatformScheduleConfigResponseItem {
  return {
    scheduleId: row.scheduleId,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapConfigError(error: unknown): never {
  if (error instanceof PlatformScheduleConfigError) {
    if (
      error.code === "PLATFORM_SCHEDULE_ID_INVALID" ||
      error.code === "PLATFORM_SCHEDULE_UPDATED_BY_INVALID" ||
      error.code === "PLATFORM_SCHEDULE_REASON_INVALID"
    ) {
      throw new BadRequestException({
        error: { code: error.code, message: error.code },
      });
    }
    throw new ServiceUnavailableException({
      error: { code: error.code, message: error.code },
    });
  }
  throw new ServiceUnavailableException({
    error: {
      code: "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      message: "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
    },
  });
}

@ApiTags("PlatformAuthority")
@Controller("internal/platform-schedules")
@UseGuards(PlatformScheduleConfigServiceTokenGuard)
export class PlatformScheduleConfigInternalController {
  constructor(private readonly configs: PlatformScheduleConfigService) {}

  @Get()
  @ApiOperation({
    operationId: "listInternalPlatformScheduleConfigs_v1",
    summary: "只读查询当前平台权威模式与 4 个平台调度的数据库 Kill Switch 配置",
  })
  @ApiHeader({
    name: "x-service-token",
    required: true,
    description:
      "内部服务令牌（env PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN）",
  })
  @ApiResponse({ status: 200, description: "返回当前模式及 4 个平台调度配置" })
  @ApiResponse({ status: 401, description: "缺少或无效的内部服务令牌" })
  @ApiResponse({ status: 503, description: "服务令牌未配置或数据库不可用" })
  async list(): Promise<Enveloped<ListPlatformScheduleConfigsResponse>> {
    try {
      const mode = resolvePlatformAuthorityMode(process.env);
      const rows = await this.configs.listAll();
      return envelope({
        mode,
        schedules: rows.map(serializeConfig),
      });
    } catch (error) {
      return mapConfigError(error);
    }
  }

  @Patch(":scheduleId")
  @HttpCode(200)
  @ApiOperation({
    operationId: "updateInternalPlatformScheduleConfig_v1",
    summary: "受内部服务鉴权保护的平台调度 Kill Switch 启停切换（含操作审计）",
  })
  @ApiParam({
    name: "scheduleId",
    enum: [...CANONICAL_PLATFORM_SCHEDULE_IDS],
    description: "4 个平台标准调度 ID 之一",
  })
  @ApiHeader({
    name: "x-service-token",
    required: true,
    description:
      "内部服务令牌（env PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN）",
  })
  @ApiResponse({ status: 200, description: "更新成功并返回配置与审计回执" })
  @ApiResponse({ status: 400, description: "scheduleId 或请求体参数非法" })
  @ApiResponse({ status: 401, description: "缺少或无效的内部服务令牌" })
  @ApiResponse({
    status: 503,
    description: "服务令牌未配置、platform_writer 未连接或数据库不可用",
  })
  async update(
    @Param("scheduleId") scheduleId: string,
    @Body() dto: UpdatePlatformScheduleConfigDto,
  ): Promise<Enveloped<UpdatePlatformScheduleConfigResponse>> {
    try {
      const result = await this.configs.setEnabled({
        scheduleId,
        enabled: dto.enabled,
        updatedBy: dto.updatedBy,
        reason: dto.reason,
      });
      return envelope({
        mode: result.audit.mode,
        config: serializeConfig(result.config),
        audit: result.audit,
      });
    } catch (error) {
      return mapConfigError(error);
    }
  }
}
