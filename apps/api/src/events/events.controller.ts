import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { EventsService } from './events.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ACK_BATCH = 200;

/**
 * ACK 请求体。**不暴露 sink**：对外 ACK 恒指 pull sink（'saas'）——
 * webhook sink 的 ACKED 只能由 relay 收到 2xx 写，给 API 开 sink 口子等于允许消费端
 * 伪造推送已达（YAGNI + 完整性）。
 */
class AckEventsDto {
  @ApiProperty({ description: '要 ACK 的 event_id 列表（envelope.event_id，uuid）', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACK_BATCH)
  @IsUUID('4', { each: true })
  event_ids!: string[];
}

/**
 * 集成事件出口（收口③）：SaaS 拉取（GET /events 游标翻页）+ 消费确认（POST /events/ack）。
 * at-least-once：游标可从任意位置重放，消费端按 event_id 去重。
 */
@ApiTags('Events')
@ApiBearerAuth()
@Controller('events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOperation({ summary: '拉取集成事件（envelope 流，?cursor=&limit=&type=，游标与 ACK 无关可重放）' })
  // swagger 对 @Query 推断 required:true，SaaS codegen 客户端会强制要参数——三个都显式 optional。
  @ApiQuery({ name: 'cursor', required: false, description: '游标（上次响应的 nextCursor；缺省从头拉）' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: DEFAULT_LIMIT, maximum: MAX_LIMIT } })
  @ApiQuery({ name: 'type', required: false, description: '按集成事件类型过滤（如 LeadQualified）' })
  async list(
    @Ctx() ctx: RequestContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    // floor：?limit=1.5 之类非整数不能原样进 Prisma take（非 int 会 500）
    const n = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    // 空串游标当未给（避免 BigInt('') === 0n 的隐形语义）
    return this.events.list(ctx, { cursor: cursor || undefined, limit: n, type: type || undefined });
  }

  @Post('ack')
  @HttpCode(200)
  @ApiOperation({ summary: 'ACK 已消费事件（pull sink 消费真值；幂等，重复 ACK 计 0）' })
  async ack(@Ctx() ctx: RequestContext, @Body() dto: AckEventsDto) {
    // sink 不透传：恒走 service 缺省的 pull sink（'saas'）。
    return this.events.ack(ctx, dto.event_ids);
  }
}

export { AckEventsDto };
