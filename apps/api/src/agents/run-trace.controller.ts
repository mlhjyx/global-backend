import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequestContext } from "../auth/request-context";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { ScopesGuard } from "../auth/scopes.guard";
import { ApiPageEnvelope } from "../common/api-envelope.decorator";
import { pageEnvelope } from "../common/envelope";
import { RUN_TRACE_DEFAULT_LIMIT, RunTraceService } from "./run-trace.service";

/**
 * M2 步 9b-4：run 决策轨迹的租户只读时间线（前端「过程」页数据源）。
 * 只需要登录租户身份（acquisition:read）；跨租户 404；分页为不透明 cursor。
 */
@ApiTags("Discovery")
@ApiBearerAuth()
@Controller("runs")
@UseGuards(AuthGuard, ScopesGuard)
export class RunTraceController {
  constructor(private readonly traces: RunTraceService) {}

  @Get(":runId/trace")
  @RequireScopes("acquisition:read")
  @ApiOperation({ summary: "run 决策轨迹（过程时间线：选源/跳过原因/批量判定与被否候选）" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", default: RUN_TRACE_DEFAULT_LIMIT, maximum: 200 } })
  @ApiQuery({ name: "cursor", required: false })
  @ApiPageEnvelope({
    type: "object",
    required: ["id", "stepType", "agentKey", "decisionType", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      stepType: { type: "string" },
      agentKey: { type: "string" },
      actorType: { type: "string" },
      attempt: { type: "integer" },
      decisionType: { type: "string" },
      chosenOption: { type: "object", nullable: true, additionalProperties: true },
      score: { type: "number", nullable: true },
      reasonCode: { type: "string", nullable: true },
      evidence: { type: "array", items: { type: "object", additionalProperties: true } },
      rejectedCandidates: { type: "array", items: { type: "object", additionalProperties: true } },
      costEstimatedMicros: { type: "string", nullable: true },
      costActualMicros: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
  })
  async list(
    @Ctx() ctx: RequestContext,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const result = await this.traces.listRunTrace(ctx, runId, {
      limit: Number(limit) || RUN_TRACE_DEFAULT_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return pageEnvelope(result.data, result);
  }
}
