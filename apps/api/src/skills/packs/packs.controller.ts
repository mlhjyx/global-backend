import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../../auth/auth.guard";
import { Ctx } from "../../auth/ctx.decorator";
import { RequestContext } from "../../auth/request-context";
import { RequireScopes } from "../../auth/require-scopes.decorator";
import { ScopesGuard } from "../../auth/scopes.guard";
import { ApiEnvelope } from "../../common/api-envelope.decorator";
import { envelope } from "../../common/envelope";
import { PackStudioService } from "./pack-studio.service";

/**
 * S1 Pack Studio（引擎 ops API v1）：目录/草稿/校验/试跑/评测/发布/激活/灰度/启停。
 * 仅运营身份（ops:read / ops:write）。发布门要求与草稿摘要匹配的有效评测回执
 * （见 pack-studio.core.ts）；启停覆盖按目标 workspace 受 RLS 约束。
 */
@ApiTags("Packs")
@ApiBearerAuth()
@Controller("packs")
@UseGuards(AuthGuard, ScopesGuard)
export class PacksController {
  constructor(private readonly studio: PackStudioService) {}

  @Get()
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "Pack 目录（含当前激活版本）" })
  @ApiEnvelope({ type: "array", items: { type: "object", additionalProperties: true } })
  async list(@Ctx() ctx: RequestContext) {
    return envelope(await this.studio.listPacks(ctx.workspaceId));
  }

  @Get(":packKey")
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "Pack 详情（版本/草稿/激活/回执）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async detail(@Ctx() ctx: RequestContext, @Param("packKey") packKey: string) {
    return envelope(await this.studio.getPack(ctx.workspaceId, packKey));
  }

  @Post(":packKey/drafts")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "新建草稿（可从已发布版本派生）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async createDraft(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    return envelope(
      await this.studio.createDraft(ctx.workspaceId, ctx.userId, packKey, optionalString(body, "fromVersion")),
    );
  }

  @Patch(":packKey/drafts/:draftId")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "编辑草稿（manifest/content）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async updateDraft(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const content = body["content"];
    if (content !== undefined && typeof content !== "string") {
      throw new BadRequestException("content must be a string");
    }
    return envelope(
      await this.studio.updateDraft(ctx.workspaceId, ctx.userId, packKey, draftId, {
        ...(body["manifest"] !== undefined ? { manifest: body["manifest"] } : {}),
        ...(content !== undefined ? { content: content as string } : {}),
      }),
    );
  }

  @Post(":packKey/drafts/:draftId/validate")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "校验草稿（schema + 语义 + 冲突模拟）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async validateDraft(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
  ) {
    return envelope(await this.studio.validateDraft(ctx.workspaceId, packKey, draftId));
  }

  @Post(":packKey/drafts/:draftId/dry-run")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "试跑：在样本上下文解析并渲染策略简报（与当前版本差异）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async dryRun(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const selectors = readSelectors(body);
    return envelope(
      await this.studio.dryRunDraft(ctx.workspaceId, packKey, draftId, {
        ...(typeof body["skillKey"] === "string" ? { skillKey: body["skillKey"] } : {}),
        ...selectors,
      }),
    );
  }

  @Post(":packKey/drafts/:draftId/eval")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "运行确定性评测并写回执（发布门前置）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async eval(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return envelope(
      await this.studio.evalDraft(ctx.workspaceId, ctx.userId, packKey, draftId, body["evals"]),
    );
  }

  @Post(":packKey/drafts/:draftId/publish")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "发布草稿为不可变版本（需匹配的有效评测回执）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async publish(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Param("draftId", ParseUUIDPipe) draftId: string,
  ) {
    return envelope(await this.studio.publishDraft(ctx.workspaceId, ctx.userId, packKey, draftId));
  }

  @Post(":packKey/activate")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "激活已发布版本（platform 默认或 workspace 白名单灰度；回滚=激活旧版本）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async activate(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    const version = body["version"];
    const scope = body["scope"];
    if (typeof version !== "string" || version.trim() === "") {
      throw new BadRequestException("version is required");
    }
    if (scope !== "platform" && scope !== "workspace") {
      throw new BadRequestException("scope must be platform or workspace");
    }
    const workspaceId = body["workspaceId"];
    if (scope === "workspace" && typeof workspaceId !== "string") {
      throw new BadRequestException("workspace scope requires workspaceId");
    }
    const canary = body["canary"];
    if (canary !== undefined && typeof canary !== "boolean") {
      throw new BadRequestException("canary must be a boolean");
    }
    return envelope(
      await this.studio.activateVersion(ctx.workspaceId, ctx.userId, packKey, {
        version,
        scope,
        ...(typeof workspaceId === "string" ? { workspaceId } : {}),
        ...(canary === true ? { canary: true } : {}),
      }),
    );
  }

  @Get(":packKey/workspaces/:workspaceId")
  @RequireScopes("ops:read")
  @ApiOperation({ summary: "目标 workspace 的 Pack 生效状态（平台状态 + 覆盖行）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async workspaceEnablement(
    @Param("packKey") packKey: string,
    @Param("workspaceId", ParseUUIDPipe) workspaceId: string,
  ) {
    return envelope(await this.studio.getWorkspaceEnablement(workspaceId, packKey));
  }

  @Put(":packKey/workspaces/:workspaceId")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "设置 workspace 级 Pack 启停覆盖" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async setWorkspaceEnablement(
    @Ctx() ctx: RequestContext,
    @Param("packKey") packKey: string,
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
      await this.studio.setWorkspaceEnablement(workspaceId, ctx.userId, packKey, enabled, reason as string | undefined),
    );
  }

  @Delete(":packKey/workspaces/:workspaceId")
  @RequireScopes("ops:write")
  @ApiOperation({ summary: "删除 workspace 启停覆盖（回到跟随平台默认）" })
  @ApiEnvelope({ type: "object", additionalProperties: true })
  async clearWorkspaceEnablement(
    @Param("packKey") packKey: string,
    @Param("workspaceId", ParseUUIDPipe) workspaceId: string,
  ) {
    return envelope(await this.studio.clearWorkspaceEnablement(workspaceId, packKey));
  }
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException(`${key} must be a non-empty string`);
  }
  return value;
}

function readSelectors(body: Record<string, unknown>): {
  industries?: readonly string[];
  markets?: readonly string[];
  motions?: readonly string[];
} {
  const read = (key: string): readonly string[] | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new BadRequestException(`${key} must be an array of non-empty strings`);
    }
    return value as string[];
  };
  return {
    ...(read("industries") ? { industries: read("industries") } : {}),
    ...(read("markets") ? { markets: read("markets") } : {}),
    ...(read("motions") ? { motions: read("motions") } : {}),
  };
}
