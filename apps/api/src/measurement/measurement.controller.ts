import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequireScopes } from "../auth/require-scopes.decorator";
import { RequestContext } from "../auth/request-context";
import { ScopesGuard } from "../auth/scopes.guard";
import { envelope, pageEnvelope } from "../common/envelope";
import { MeasurementService } from "./measurement.service";
import {
  BillingReconciliationInputError,
  BillingReconciliationService,
} from "./billing-reconciliation";
import { SourceYieldInputError, SourceYieldService } from "./source-yield";

const errorSchema = (codes: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: true,
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: [...codes] },
        message: { type: "string" },
      },
    },
  },
});

const pageQuery = [
  { name: "metricId", required: false, description: "指标 ID，如 T2-001；缺省返回全部指标", schema: { type: "string", pattern: "^[A-Za-z0-9-]{1,32}$" } },
  { name: "from", required: false, description: "起始日（含），YYYY-MM-DD（UTC）", schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
  { name: "to", required: false, description: "结束日（含），YYYY-MM-DD（UTC）", schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
  { name: "cursor", required: false, description: "上一页 page.next_cursor 原样回传", schema: { type: "string" } },
  { name: "limit", required: false, description: "每页条数，默认 100，最大 500", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
] as const;

/**
 * ch01 PR-04：度量只读 API（catalog / observations / rollups）。
 *
 * 读作用户自己的 workspace（metric_observation 按 workspace_id、rollup 两表按
 * stratum->>'workspace_id' 的 RLS）；平台级行对租户不可见。列表统一 page envelope
 * （data + page.next_cursor/has_more），单一实现见 MeasurementService。
 */
@ApiTags("Metrics")
@ApiBearerAuth()
@Controller("metrics")
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes("acquisition:read")
export class MeasurementController {
  constructor(
    private readonly measurements: MeasurementService,
    private readonly sourceYield: SourceYieldService,
    private readonly billing: BillingReconciliationService,
  ) {}

  @Get("catalog")
  @ApiOperation({
    summary:
      "指标字典目录（metric_definition 平台表只读）：ID/版本/口径/状态/负责人；字典由 docs/metrics/dictionary 同步（measurement-sync-definitions 命令）",
  })
  @ApiResponse({
    status: 200,
    description: "{ data: [...], page } — 字典为空时返回空数组（has_more=false）",
    schema: {
      type: "object",
      required: ["data", "page"],
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            required: ["metricId", "version", "name", "tier", "unit", "status", "owner", "effectiveFrom", "definition"],
            properties: {
              metricId: { type: "string" },
              version: { type: "integer" },
              name: { type: "string" },
              tier: { type: "string" },
              unit: { type: "string" },
              status: { type: "string" },
              owner: { type: "string" },
              effectiveFrom: { type: "string", format: "date-time" },
              definition: { type: "string" },
            },
          },
        },
        page: {
          type: "object",
          required: ["next_cursor", "has_more"],
          properties: {
            next_cursor: { type: "string", nullable: true },
            has_more: { type: "boolean" },
          },
        },
      },
    },
  })
  async catalog() {
    const items = await this.measurements.catalog();
    return pageEnvelope(items, { nextCursor: null, hasMore: false });
  }

  @Get("observations")
  @ApiOperation({
    summary:
      "度量观测（append-only，本 workspace 可见行）：按 window_end 倒序 keyset 分页；数值列以 double 返回，stratum 原样返回 JSON",
  })
  @ApiQuery(pageQuery[0])
  @ApiQuery(pageQuery[1])
  @ApiQuery(pageQuery[2])
  @ApiQuery(pageQuery[3])
  @ApiQuery(pageQuery[4])
  @ApiResponse({ status: 200, description: "{ data: [...observations], page }" })
  @ApiResponse({
    status: 400,
    description: "参数或游标不合法",
    schema: errorSchema(["VALIDATION_ERROR"]),
  })
  async observations(
    @Ctx() ctx: RequestContext,
    @Query("metricId") metricId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const result = await this.measurements.observations(ctx, {
      metricId,
      from,
      to,
      cursor,
      limit,
    });
    return pageEnvelope(result.items, result.page);
  }

  @Get("rollups")
  @ApiOperation({
    summary:
      "日/周聚合（metric_rollup_daily|weekly，本 workspace 可见行）：granularity=daily|weekly；按桶倒序 + 指标/维度 keyset 分页",
  })
  @ApiQuery({
    name: "granularity",
    required: false,
    description: "daily（默认）或 weekly",
    schema: { type: "string", enum: ["daily", "weekly"], default: "daily" },
  })
  @ApiQuery(pageQuery[0])
  @ApiQuery(pageQuery[1])
  @ApiQuery(pageQuery[2])
  @ApiQuery(pageQuery[3])
  @ApiQuery(pageQuery[4])
  @ApiResponse({ status: 200, description: "{ data: [...rollups], page }" })
  @ApiResponse({
    status: 400,
    description: "参数或游标不合法",
    schema: errorSchema(["VALIDATION_ERROR"]),
  })
  async rollups(
    @Ctx() ctx: RequestContext,
    @Query("granularity") granularity?: string,
    @Query("metricId") metricId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const result = await this.measurements.rollups(ctx, {
      granularity,
      metricId,
      from,
      to,
      cursor,
      limit,
    });
    return pageEnvelope(result.items, result.page);
  }

  @Get("vric")
  @ApiOperation({
    summary:
      "VRIC 成对序列（T0-001 STRICT + T0-002 PLUS，本 workspace 可见行）：按桶升序返回最近 limit 个桶；某侧缺数据时为 null，不得以 0 冒充缺失",
  })
  @ApiQuery({
    name: "granularity",
    required: false,
    description: "daily（默认）或 weekly",
    schema: { type: "string", enum: ["daily", "weekly"], default: "daily" },
  })
  @ApiQuery(pageQuery[1])
  @ApiQuery(pageQuery[2])
  @ApiQuery({
    name: "limit",
    required: false,
    description: "返回的桶数，默认 30，最大 180；显式 from/to 时以最后 limit 个桶为准",
    schema: { type: "integer", minimum: 1, maximum: 180, default: 30 },
  })
  @ApiResponse({ status: 200, description: "{ data: [...vric buckets], page } — page.has_more 表示窗口被截断" })
  @ApiResponse({
    status: 400,
    description: "参数不合法",
    schema: errorSchema(["VALIDATION_ERROR"]),
  })
  async vric(
    @Ctx() ctx: RequestContext,
    @Query("granularity") granularity?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const result = await this.measurements.vric(ctx, { granularity, from, to, limit });
    return pageEnvelope(result.items, result.page);
  }

  @Get("source-yield")
  @ApiOperation({
    summary:
      "源边际产出账本（source_yield_ledger，本 workspace）：按日/周×发现源聚合记录数、新增合格数、实扣成本 microusd 与每新增合格公司的美元成本；季度砍源报表消费它",
  })
  @ApiQuery({
    name: "granularity",
    required: false,
    description: "day（自然日）或 week（ISO 周，周一为桶值）；默认 week",
    schema: { type: "string", enum: ["day", "week"], default: "week" },
  })
  @ApiQuery(pageQuery[1])
  @ApiQuery(pageQuery[2])
  @ApiQuery({
    name: "providerKey",
    required: false,
    description: "只看向某一发现源（provider_key）",
    schema: { type: "string" },
  })
  @ApiQuery(pageQuery[4])
  @ApiResponse({ status: 200, description: "{ data: [...buckets], page }" })
  @ApiResponse({
    status: 400,
    description: "参数不合法",
    schema: errorSchema(["VALIDATION_ERROR"]),
  })
  async sourceYieldByPeriod(
    @Ctx() ctx: RequestContext,
    @Query("granularity") granularity?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("providerKey") providerKey?: string,
    @Query("limit") limit?: string,
  ) {
    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        throw new BadRequestException("limit 必须是正整数");
      }
    }
    try {
      const items = await this.sourceYield.byPeriod({
        workspaceId: ctx.workspaceId,
        from,
        to,
        granularity,
        providerKey,
        limit: parsedLimit,
      });
      return pageEnvelope(items, {
        nextCursor: null,
        hasMore: parsedLimit !== undefined && items.length === parsedLimit,
      });
    } catch (error) {
      if (error instanceof SourceYieldInputError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get("billing-reconciliation")
  @ApiOperation({
    summary:
      "三方对账视图：usage_ledger 用量 ↔ tool_budget_operation 结算（窗口实扣，ch08 §3.1.1 C1a 口径）↔ tool_budget_account 执行包络（余额来源表；累计快照）。客户钱包余额真值在 gain-saas，不在本引擎",
  })
  @ApiQuery(pageQuery[1])
  @ApiQuery(pageQuery[2])
  @ApiResponse({ status: 200, description: "{ data: {...} }" })
  @ApiResponse({
    status: 400,
    description: "参数不合法",
    schema: errorSchema(["VALIDATION_ERROR"]),
  })
  async billingReconciliation(
    @Ctx() ctx: RequestContext,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    try {
      return envelope(
        await this.billing.view({ workspaceId: ctx.workspaceId, from, to }),
      );
    } catch (error) {
      if (error instanceof BillingReconciliationInputError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
