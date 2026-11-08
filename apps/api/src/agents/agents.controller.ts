import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { AgentsService, type AgentStatus } from "./agents.service";

/**
 * M2 步 9b agent 注册表 ops 面：列表 + 平台 kill switch。
 * 仅运营身份（ops:read / ops:write）；租户 token 一律 403（ScopesGuard）。
 * 停用对在飞 run 的对应回合是显性失败（AGENT_DISABLED，fail-closed）。
 */
@ApiTags("Agents")
@ApiBearerAuth()
@Controller("ops-agents")
@UseGuards(AuthGuard, ScopesGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "agent 注册表（角色、技能子集、模型与 loop 策略、启停状态）" })
  @ApiEnvelope({ type: "array", items: { type: "object", additionalProperties: true } })
  async list(@Ctx() ctx: RequestContext) {
    return envelope(await this.agents.listAgents(ctx.workspaceId));
  }

  @Patch(":agentKey/status")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "平台级启停（kill switch，所有 workspace 生效）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async setStatus(
    @Ctx() ctx: RequestContext,
    @Param("agentKey") agentKey: string,
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
      await this.agents.setStatus(
        ctx.workspaceId,
        ctx.userId,
        agentKey,
        status as AgentStatus,
        reason as string | undefined,
      ),
    );
  }
}
