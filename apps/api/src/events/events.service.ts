import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RequestContext } from "../auth/request-context";
import {
  INTEGRATION_EVENTS,
  PULL_SINK,
  toEnvelope,
  DomainEventEnvelope,
  OutboxEventRow,
} from "../relay/event-registry";

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
  ): Promise<{
    data: DomainEventEnvelope[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    // 游标 = outbox_delivery 的 BigInt 行 id 字符串；非数字 → 400（fail fast）。
    let cursorId: bigint | undefined;
    if (opts.cursor !== undefined) {
      try {
        cursorId = BigInt(opts.cursor);
      } catch {
        throw new BadRequestException({
          error: {
            code: "INVALID_CURSOR",
            message: "cursor must be a numeric event stream position",
          },
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
        orderBy: { id: "asc" },
        take: opts.limit + 1,
      })) as Array<{ id: bigint; event: OutboxEventRow }>;
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data: data.map((d) => toEnvelope(d.event)), // envelope 不含 BigInt 行 id
        // Every non-empty page advances the durable checkpoint, including a
        // terminal page. A later poll can therefore resume after its last
        // ledger row instead of replaying the terminal page from an older
        // cursor. Only a genuinely empty page has no new checkpoint.
        nextCursor: data.length ? String(data[data.length - 1].id) : null,
        hasMore,
      };
    });
  }

  /**
   * ACK only moves PENDING to ACKED. Every requested event receives an
   * auditable outcome, so acked:0 never conflates idempotent replay, a missing
   * pull delivery, and an unknown event. RLS still provides the hard tenant
   * boundary; explicit workspace predicates are retained as defense in depth.
   * sink 缺省锁死 pull sink（'saas'）——webhook sink 的 ACKED 只能由 relay 收到 2xx 写，
   * 对外 API（events.controller）不暴露 sink 参数。
   */
  ack(
    ctx: RequestContext,
    eventIds: string[],
    sink: string = PULL_SINK,
  ): Promise<{
    acked: number;
    results: Array<{
      event_id: string;
      outcome: "ACKED_NOW" | "ALREADY_ACKED" | "NOT_DELIVERED" | "NOT_FOUND";
    }>;
  }> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const results: Array<{
        event_id: string;
        outcome: "ACKED_NOW" | "ALREADY_ACKED" | "NOT_DELIVERED" | "NOT_FOUND";
      }> = [];
      let acked = 0;
      for (const eventId of [...new Set(eventIds)]) {
        const now = new Date();
        const updated = await tx.outboxDelivery.updateMany({
          where: {
            workspaceId: ctx.workspaceId,
            eventId: { in: [eventId] },
            sink,
            status: "PENDING",
          },
          // deliveredAt is relay transport evidence. Consumer acknowledgement
          // has its own timestamp and must never manufacture a delivery time.
          data: { status: "ACKED", ackedAt: now },
        });
        if (updated.count === 1) {
          acked += 1;
          results.push({ event_id: eventId, outcome: "ACKED_NOW" });
          continue;
        }

        const event = await tx.outboxEvent.findFirst({
          where: { eventId, workspaceId: ctx.workspaceId },
          select: { eventId: true },
        });
        if (!event) {
          results.push({ event_id: eventId, outcome: "NOT_FOUND" });
          continue;
        }
        const delivery = await tx.outboxDelivery.findFirst({
          where: { eventId, workspaceId: ctx.workspaceId, sink },
          select: { status: true },
        });
        results.push({
          event_id: eventId,
          outcome:
            delivery?.status === "ACKED" ? "ALREADY_ACKED" : "NOT_DELIVERED",
        });
      }
      return { acked, results };
    });
  }
}
