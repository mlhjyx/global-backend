import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { INTEGRATION_EVENTS, PULL_SINK, toEnvelope, DomainEventEnvelope, OutboxEventRow } from '../relay/event-registry';

/**
 * 集成事件拉取 + ACK（收口③ pull sink）。SaaS 侧消费真值在 outbox_delivery（sink='saas'）。
 * - **游标 = 交付账本行 id（outbox_delivery.id）**，不是 outbox_event.id：交付行由单写者 relay
 *   串行创建（tick 有 running 互斥、单进程部署），账本 id 序 = 路由可见序。若按事件 id 做游标，
 *   「低 id 事件晚发布」（单事件路由瞬时失败下轮重试 / 并发生产者事务乱序提交）会被已越过的
 *   游标永久跳过 —— at-least-once 违约。账本序构造性消除该漏洞。
 * - 游标仍与 ACK 无关，可从任意位置重放（at-least-once；消费端按 event_id 去重）。
 * - 未发布/parked 事件天然无交付行 → 不可见；无需再按 publishedAt 过滤。
 * - RLS（withWorkspace）保证只见/只 ACK 本 workspace 的事件。
 */
@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    ctx: RequestContext,
    opts: { cursor?: string; limit: number; type?: string },
  ): Promise<{ data: DomainEventEnvelope[]; nextCursor: string | null; hasMore: boolean }> {
    // 游标 = outbox_delivery 的 BigInt 行 id 字符串；非数字 → 400（fail fast）。
    let cursorId: bigint | undefined;
    if (opts.cursor !== undefined) {
      try {
        cursorId = BigInt(opts.cursor);
      } catch {
        throw new BadRequestException({
          error: { code: 'INVALID_CURSOR', message: 'cursor must be a numeric event stream position' },
        });
      }
    }
    // type 过滤单值，但**必须仍在集成事件集合内**——不给 ?type=QualifyRequested 漏出内部命令的口子。
    const typeFilter = opts.type
      ? INTEGRATION_EVENTS.has(opts.type)
        ? [opts.type]
        : []
      : [...INTEGRATION_EVENTS];
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = (await tx.outboxDelivery.findMany({
        where: {
          sink: PULL_SINK,
          ...(cursorId !== undefined ? { id: { gt: cursorId } } : {}),
          // 关系过滤兜底：即便未来误给非集成事件建了交付行，也不对外漏出。
          event: { eventType: { in: typeFilter } },
        },
        include: { event: true },
        orderBy: { id: 'asc' },
        take: opts.limit + 1,
      })) as Array<{ id: bigint; event: OutboxEventRow }>;
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data: data.map((d) => toEnvelope(d.event)), // envelope 不含 BigInt 行 id
        nextCursor: hasMore && data.length ? String(data[data.length - 1].id) : null,
        hasMore,
      };
    });
  }

  /**
   * ACK：只翻 PENDING → ACKED（幂等，重复 ACK 计 0）；RLS 保证只 ACK 本 workspace。
   * sink 缺省锁死 pull sink（'saas'）——webhook sink 的 ACKED 只能由 relay 收到 2xx 写，
   * 对外 API（events.controller）不暴露 sink 参数。
   */
  ack(ctx: RequestContext, eventIds: string[], sink: string = PULL_SINK): Promise<{ acked: number }> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const now = new Date();
      const r = await tx.outboxDelivery.updateMany({
        where: { eventId: { in: eventIds }, sink, status: 'PENDING' },
        data: { status: 'ACKED', ackedAt: now, deliveredAt: now },
      });
      return { acked: r.count };
    });
  }
}
