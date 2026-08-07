import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from "class-validator";
import { AcquisitionAuthorizationIntegrationPendingGuard } from "../auth/acquisition-authorization-integration-pending.guard";
import { AuthGuard } from "../auth/auth.guard";
import { Ctx } from "../auth/ctx.decorator";
import { RequestContext } from "../auth/request-context";
import { envelope, pageEnvelope } from "../common/envelope";
import { ApiEnvelope, ApiPageEnvelope } from "../common/api-envelope.decorator";
import { EventsService } from "./events.service";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ACK_BATCH = 200;

/**
 * 事件 envelope（契约：packages/contracts/events/envelope.schema.json，键 snake_case）。
 * required/enum 必须与该 JSON Schema 镜像一致——events.controller.spec.ts 有一致性单测防漂移。
 */
export const EVENT_ENVELOPE_SCHEMA = {
  type: "object",
  description:
    "事件 envelope（见 packages/contracts/events/envelope.schema.json）",
  required: [
    "event_id",
    "event_type",
    "schema_version",
    "workspace_id",
    "aggregate_type",
    "aggregate_id",
    "occurred_at",
    "producer",
    "privacy_classification",
    "payload",
  ],
  properties: {
    event_id: { type: "string", format: "uuid" },
    event_type: { type: "string" },
    schema_version: { type: "integer" },
    workspace_id: { type: "string", format: "uuid" },
    aggregate_type: { type: "string" },
    aggregate_id: { type: "string" },
    occurred_at: { type: "string", format: "date-time" },
    producer: { type: "string" },
    correlation_id: { type: "string", nullable: true },
    causation_id: { type: "string", nullable: true },
    privacy_classification: {
      type: "string",
      enum: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    },
    payload: { type: "object", additionalProperties: true },
  },
};

/**
 * Event delivery cursors are durable ledger checkpoints, not merely a
 * has-more token. A non-empty terminal page must therefore expose its final
 * ledger id so the next poll can resume after it.
 */
export const EVENT_PAGE_SCHEMA = {
  type: "object",
  required: ["next_cursor", "has_more"],
  properties: {
    next_cursor: {
      type: "string",
      nullable: true,
      pattern: "^\\d+$",
      description:
        "最后一条返回事件的账本 checkpoint；非空页恒为数字字符串（包括 has_more=false 的终页），仅空页为 null",
    },
    has_more: {
      type: "boolean",
      description: "是否存在可立即读取的后续页；不决定 next_cursor 是否为 null",
    },
  },
};

/**
 * ACK 请求体。**不暴露 sink**：对外 ACK 恒指 pull sink（'saas'）——
 * webhook sink 的 ACKED 只能由 relay 收到 2xx 写，给 API 开 sink 口子等于允许消费端
 * 伪造推送已达（YAGNI + 完整性）。
 */
class AckEventsDto {
  @ApiProperty({
    description: "要 ACK 的 event_id 列表（envelope.event_id，uuid）",
    type: "array",
    items: { type: "string", format: "uuid" },
    minItems: 1,
    maxItems: MAX_ACK_BATCH,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACK_BATCH)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  event_ids!: string[];
}

/**
 * 集成事件出口（收口③）：SaaS 拉取（GET /events 游标翻页）+ 消费确认（POST /events/ack）。
 * at-least-once：游标可从任意位置重放，消费端按 event_id 去重。
 */
@ApiTags("Events")
@ApiBearerAuth()
@Controller("events")
@UseGuards(AuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @UseGuards(AcquisitionAuthorizationIntegrationPendingGuard)
  @ApiOperation({
    summary:
      "拉取集成事件（envelope 流，?cursor=&limit=&type=，游标与 ACK 无关可重放）",
    description:
      "非空响应的 next_cursor 恒为最后一条返回账本记录的位置，包括 has_more=false 的终页；空页返回 null。",
  })
  @ApiResponse({
    status: 503,
    description:
      "Unavailable until acquisition:read and personal-data:read authorization is integrated",
  })
  // swagger 对 @Query 推断 required:true，SaaS codegen 客户端会强制要参数——三个都显式 optional。
  @ApiQuery({
    name: "cursor",
    required: false,
    description: "游标（上次响应的 nextCursor；缺省从头拉）",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", default: DEFAULT_LIMIT, maximum: MAX_LIMIT },
  })
  @ApiQuery({
    name: "type",
    required: false,
    description: "按集成事件类型过滤（如 LeadQualified）",
  })
  @ApiPageEnvelope(EVENT_ENVELOPE_SCHEMA, { pageSchema: EVENT_PAGE_SCHEMA })
  async list(
    @Ctx() ctx: RequestContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("type") type?: string,
  ) {
    // floor：?limit=1.5 之类非整数不能原样进 Prisma take（非 int 会 500）
    const n = Math.min(
      Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1),
      MAX_LIMIT,
    );
    // 空串游标当未给（避免 BigInt('') === 0n 的隐形语义）
    const r = await this.events.list(ctx, {
      cursor: cursor || undefined,
      limit: n,
      type: type || undefined,
    });
    return pageEnvelope(r.data, r);
  }

  @Post("ack")
  @HttpCode(200)
  @UseGuards(AcquisitionAuthorizationIntegrationPendingGuard)
  @ApiOperation({
    summary:
      "ACK 已消费事件（逐事件返回 ACKED_NOW/ALREADY_ACKED/NOT_DELIVERED/NOT_FOUND）",
  })
  @ApiResponse({
    status: 503,
    description:
      "Unavailable until acquisition:event:ack authorization is integrated",
  })
  @ApiEnvelope({
    type: "object",
    required: ["acked", "results"],
    properties: {
      acked: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["event_id", "outcome"],
          properties: {
            event_id: { type: "string", format: "uuid" },
            outcome: {
              type: "string",
              enum: [
                "ACKED_NOW",
                "ALREADY_ACKED",
                "NOT_DELIVERED",
                "NOT_FOUND",
              ],
            },
          },
        },
      },
    },
  })
  async ack(@Ctx() ctx: RequestContext, @Body() dto: AckEventsDto) {
    // sink 不透传：恒走 service 缺省的 pull sink（'saas'）。
    return envelope(await this.events.ack(ctx, dto.event_ids));
  }
}

export { AckEventsDto };
