import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequestContext } from "../auth/request-context";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { ScopesGuard } from "../auth/scopes.guard";
import { ApiEnvelope } from "../common/api-envelope.decorator";
import { envelope } from "../common/envelope";
import { SkillsService, type SkillStatus } from "./skills.service";

/**
 * S0 Skill Runtime ops 面：技能列表/详情、平台 kill switch、workspace 启停覆盖。
 * 仅运营身份（ops:read / ops:write）；租户 token 一律 403（ScopesGuard）。
 * 生效时延：worker 解析缓存 TTL（默认 30s）；停用对在飞 run 是显性失败（fail-closed）。
 */
@ApiTags("Skills")
@ApiBearerAuth()
@Controller("skills")
@UseGuards(AuthGuard, ScopesGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "技能列表（平台目录 + 当前版本 + 启停状态）" })
  @ApiEnvelope({ type: "array", items: { type: "object", additionalProperties: true } })
  async list(@Ctx() ctx: RequestContext) {
    return envelope(await this.skills.listSkills(ctx.workspaceId));
  }

  @Get(":skillKey/workspaces/:workspaceId")
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "目标 workspace 的技能生效状态（平台状态 + 覆盖行）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async workspaceEnablement(
    @Param("skillKey") skillKey: string,
    @Param("workspaceId", ParseUUIDPipe) workspaceId: string,
  ) {
    return envelope(await this.skills.getWorkspaceEnablement(workspaceId, skillKey));
  }

  @Get(":skillKey")
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "技能详情（manifest、正文与版本历史）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async detail(@Ctx() ctx: RequestContext, @Param("skillKey") skillKey: string) {
    return envelope(await this.skills.getSkill(ctx.workspaceId, skillKey));
  }

  @Patch(":skillKey/status")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "平台级启停（kill switch，所有 workspace 生效）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async setStatus(
    @Ctx() ctx: RequestContext,
    @Param("skillKey") skillKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    const status = body["status"];
    if (status !== "ACTIVE" && status !== "DISABLED") {
      throw new BadRequestException("status must be ACTIVE or DISABLED");
    }
    const reason = body["reason"];
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
      throw new BadRequestException("reason must be a string of at most 500 characters");
    }
    return envelope(
      await this.skills.setStatus(
        ctx.workspaceId,
        ctx.userId,
        skillKey,
        status as SkillStatus,
        reason as string | undefined,
      ),
    );
  }

  @Put(":skillKey/workspaces/:workspaceId")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "设置 workspace 级启停覆盖（缺行 = 跟随平台默认）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async setWorkspaceEnablement(
    @Ctx() ctx: RequestContext,
    @Param("skillKey") skillKey: string,
    @Param("workspaceId", ParseUUIDPipe) workspaceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") {
      throw new BadRequestException("enabled must be a boolean");
    }
    const reason = body["reason"];
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
      throw new BadRequestException("reason must be a string of at most 500 characters");
    }
    return envelope(
      await this.skills.setWorkspaceEnablement(
        workspaceId,
        ctx.userId,
        skillKey,
        enabled,
        reason as string | undefined,
      ),
    );
  }

  @Delete(":skillKey/workspaces/:workspaceId")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "删除 workspace 覆盖（回到跟随平台默认）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async clearWorkspaceEnablement(
    @Param("skillKey") skillKey: string,
    @Param("workspaceId", ParseUUIDPipe) workspaceId: string,
  ) {
    return envelope(await this.skills.clearWorkspaceEnablement(workspaceId, skillKey));
  }
}
