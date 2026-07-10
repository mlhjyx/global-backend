import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { EventsService } from './events.service';

/**
 * 收口③ GET /events + ACK：SaaS 拉取集成事件（pull sink）。
 * - **游标基于 outbox_delivery 账本行 id**（A 修复）：交付行由单写者 relay 串行建，
 *   账本 id 序 = 路由可见序——低事件 id 晚发布（重试/乱序提交）不会被游标跳过。
 * - 游标可从任意位置重放，与 ACK 无关（at-least-once，消费端按 event_id 去重）。
 * - ACK 只翻 PENDING → ACKED，幂等（重复 ACK acked:0）；sink 缺省锁死 'saas'（F）。
 * 纯单测：mock PrismaService.withWorkspace，不碰真库。
 */

const WS = '11111111-1111-1111-1111-111111111111';

interface EvRow {
  id: bigint;
  eventId: string;
  workspaceId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  causationId: string | null;
  privacyClassification: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  publishedAt: Date | null;
  parkedAt: Date | null;
}

interface DeliveryRow {
  id: bigint;
  eventId: string;
  sink: string;
  status: string;
  ackedAt: Date | null;
  deliveredAt: Date | null;
  event: EvRow;
}

function makeEvent(id: bigint, eventType: string, over: Partial<EvRow> = {}): EvRow {
  return {
    id,
    eventId: `aaaaaaaa-0000-0000-0000-00000000000${id}`,
    workspaceId: WS,
    eventType,
    schemaVersion: 1,
    aggregateType: 'Lead',
    aggregateId: `agg-${id}`,
    producer: 'global-backend',
    correlationId: null,
    causationId: null,
    privacyClassification: 'CONFIDENTIAL',
    payload: { n: Number(id) },
    occurredAt: new Date('2026-07-10T08:00:00.000Z'),
    publishedAt: new Date('2026-07-10T08:00:01.000Z'),
    parkedAt: null,
    ...over,
  };
}

/** 交付账本行（list 的供数真值）：id = 账本序（路由可见序），与 event.id 独立。 */
function makeDelivery(id: bigint, event: EvRow, over: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id,
    eventId: event.eventId,
    sink: 'saas',
    status: 'PENDING',
    ackedAt: null,
    deliveredAt: null,
    event,
    ...over,
  };
}

interface Store {
  deliveries: DeliveryRow[];
}

/** 内存假 tx：实现 events service 用到的查询面（outboxDelivery.findMany 账本游标 + updateMany 条件更新）。 */
function makeTx(store: Store) {
  return {
    outboxDelivery: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where, take }: any) => {
        let rows = store.deliveries.filter((d) => d.sink === where.sink);
        if (where?.event?.eventType?.in) {
          rows = rows.filter((d) => where.event.eventType.in.includes(d.event.eventType));
        }
        if (where?.id?.gt !== undefined) rows = rows.filter((d) => d.id > where.id.gt);
        rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
        return rows.slice(0, take);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        store.deliveries = store.deliveries.map((d) => {
          if (where.eventId.in.includes(d.eventId) && d.sink === where.sink && d.status === where.status) {
            count += 1;
            return { ...d, ...data };
          }
          return d;
        });
        return { count };
      },
    },
  };
}

function makeService(store: Store): EventsService {
  const prisma = { withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(makeTx(store)) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new EventsService(prisma as any);
}

const ctx = { workspaceId: WS, userId: 'user-1' };

describe('EventsService.list — 集成事件拉取（账本游标翻页）', () => {
  // 事件 1/2/3 已路由（各有交付行，账本 id 11/12/13）；
  // 事件 4 = internal command、事件 5 = 未发布 → 天然无交付行，不可见。
  const store = (): Store => {
    const ev1 = makeEvent(1n, 'LeadQualified');
    const ev2 = makeEvent(2n, 'LeadsScored');
    const ev3 = makeEvent(3n, 'DiscoveryRunCompleted');
    return {
      deliveries: [makeDelivery(11n, ev1), makeDelivery(12n, ev2), makeDelivery(13n, ev3)],
    };
  };

  it('翻页：limit=2 → hasMore + nextCursor=最后一行**账本 id**；下一页取完 → hasMore=false', async () => {
    const svc = makeService(store());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page1 = (await svc.list(ctx as any, { limit: 2 })) as {
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe('12'); // 账本行 id，不是 outbox_event.id
    // envelope：snake_case、无 BigInt id
    expect(page1.data[0].event_type).toBe('LeadQualified');
    expect(page1.data[0].occurred_at).toBe('2026-07-10T08:00:00.000Z');
    expect('id' in page1.data[0]).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page2 = (await svc.list(ctx as any, { limit: 2, cursor: page1.nextCursor! })) as {
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].event_type).toBe('DiscoveryRunCompleted');
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('A 回归：低事件 id 晚路由（重试/乱序提交）→ 账本 id 靠后，游标不漏交付', async () => {
    // 事件 id 1 < 3，但 ev1 路由失败重试、晚于 ev3 建交付行 → 账本序 ev3(21) < ev1(22)。
    // 旧实现按 outbox_event.id 做游标：消费端拉到 ev3（事件 id 3）后游标=3，ev1 永久漏。
    const ev1 = makeEvent(1n, 'LeadQualified');
    const ev3 = makeEvent(3n, 'LeadsScored');
    const svc = makeService({ deliveries: [makeDelivery(21n, ev3), makeDelivery(22n, ev1)] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page1 = (await svc.list(ctx as any, { limit: 1 })) as {
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(page1.data[0].event_type).toBe('LeadsScored'); // 先路由的先出
    expect(page1.nextCursor).toBe('21');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page2 = (await svc.list(ctx as any, { limit: 1, cursor: page1.nextCursor! })) as {
      data: Array<Record<string, unknown>>;
    };
    // 关键断言：晚路由的低事件 id 事件仍能被下一页拉到（at-least-once 不违约）
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].event_type).toBe('LeadQualified');
  });

  it('internal command / 未发布事件无交付行 → 不可见；即便误建交付行也被类型过滤兜底', async () => {
    const s = store();
    // 防御性：假设 bug 给 internal command 建了交付行——event.eventType 关系过滤必须兜住
    s.deliveries.push(makeDelivery(14n, makeEvent(4n, 'QualifyRequested')));
    const svc = makeService(s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await svc.list(ctx as any, { limit: 50 })) as { data: Array<Record<string, unknown>> };
    const types = r.data.map((d) => d.event_type);
    expect(types).not.toContain('QualifyRequested');
    expect(types).toHaveLength(3);
  });

  it('type 过滤：只回该类型', async () => {
    const svc = makeService(store());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await svc.list(ctx as any, { limit: 50, type: 'LeadsScored' })) as {
      data: Array<Record<string, unknown>>;
    };
    expect(r.data).toHaveLength(1);
    expect(r.data[0].event_type).toBe('LeadsScored');
  });

  it('type=内部命令 → 空结果（不给 ?type= 漏出内部命令的口子）', async () => {
    const svc = makeService(store());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await svc.list(ctx as any, { limit: 50, type: 'QualifyRequested' })) as {
      data: Array<Record<string, unknown>>;
    };
    expect(r.data).toEqual([]);
  });

  it('非法 cursor（非数字）→ 400 BadRequestException', async () => {
    const svc = makeService(store());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc.list(ctx as any, { limit: 50, cursor: 'not-a-number' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('EventsService.ack — pull sink 消费真值（幂等 + sink 锁死）', () => {
  const ev = (n: bigint) => makeEvent(n, 'LeadQualified');

  it('ACK PENDING → acked:n + ackedAt/deliveredAt；重复 ACK → acked:0（幂等）', async () => {
    const store: Store = {
      deliveries: [makeDelivery(1n, ev(1n)), makeDelivery(2n, ev(2n))],
    };
    const svc = makeService(store);
    const ids = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (await svc.ack(ctx as any, ids)) as { acked: number };
    expect(first.acked).toBe(2);
    expect(store.deliveries.every((d) => d.status === 'ACKED')).toBe(true);
    expect(store.deliveries.every((d) => d.ackedAt instanceof Date && d.deliveredAt instanceof Date)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = (await svc.ack(ctx as any, ids)) as { acked: number };
    expect(second.acked).toBe(0);
  });

  it('ACK 只碰 PENDING：DEAD/其他 sink 的行不动', async () => {
    const store: Store = {
      deliveries: [
        makeDelivery(1n, ev(1n), { status: 'DEAD' }),
        makeDelivery(2n, ev(1n), { sink: 'webhook' }),
      ],
    };
    const svc = makeService(store);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await svc.ack(ctx as any, ['aaaaaaaa-0000-0000-0000-000000000001'])) as { acked: number };
    expect(r.acked).toBe(0);
    expect(store.deliveries[0].status).toBe('DEAD');
    expect(store.deliveries[1].status).toBe('PENDING'); // webhook sink 不受 saas ACK 影响
  });

  it('F 回归：sink 缺省恒为 saas——webhook 的 ACKED 只能由 relay 2xx 写，API 侧无从触碰', async () => {
    const seenWheres: Array<{ sink: string }> = [];
    const tx = {
      outboxDelivery: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async ({ where }: any) => {
          seenWheres.push(where);
          return { count: 0 };
        },
      },
    };
    const prisma = { withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EventsService(prisma as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.ack(ctx as any, ['aaaaaaaa-0000-0000-0000-000000000001']);
    expect(seenWheres).toHaveLength(1);
    expect(seenWheres[0].sink).toBe('saas');
  });
});
