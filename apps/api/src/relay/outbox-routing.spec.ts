import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * 收口③（Outbox 真实交付）回归测试：relay 对 integration 事件（LeadQualified 等 8 种）
 * 必须**路由进 outbox_delivery 交付账本**再标 published，而不是「无 handler 也标 published」。
 *
 * 对旧代码此文件 RED：旧 relay 没有 routeEvent/pumpWebhookDeliveries（TypeError: not a function），
 * 且旧 tick 对 LeadQualified 直接标 published、不写任何 delivery 行（静默丢失，P0）。
 *
 * 全部纯单测：mock db / temporal / fetch，不碰真库真网络（CI 无 DB）。
 */

// ── 内存假 db：实现 relay 实际用到的查询面。 ──────────────────────────────
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
  workspaceId: string;
  eventId: string;
  sink: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  ackedAt: Date | null;
  event: EvRow;
}

const WS = '11111111-1111-1111-1111-111111111111';

function makeEvent(over: Partial<EvRow> = {}): EvRow {
  return {
    id: 1n,
    eventId: 'aaaaaaaa-0000-0000-0000-000000000001',
    workspaceId: WS,
    eventType: 'LeadQualified',
    schemaVersion: 1,
    aggregateType: 'Lead',
    aggregateId: 'lead-1',
    producer: 'global-backend',
    correlationId: null,
    causationId: null,
    privacyClassification: 'CONFIDENTIAL',
    payload: { snapshot_version: 1 },
    occurredAt: new Date('2026-07-10T08:00:00.000Z'),
    publishedAt: null,
    parkedAt: null,
    ...over,
  };
}

/** 假 db + 事务内 tx（interactive $transaction：路由的 createMany/update 必须走 tx，而非 db 顶层）。 */
function makeDb(events: EvRow[], deliveries: DeliveryRow[] = []) {
  const applyEventUpdate = ({ where, data }: { where: { id: bigint }; data: Partial<EvRow> }) => {
    const ev = events.find((e) => e.id === where.id);
    if (ev) Object.assign(ev, data);
    return Promise.resolve(ev);
  };
  const tx = {
    outboxDelivery: { createMany: vi.fn(async () => ({ count: 1 })) },
    outboxEvent: { update: vi.fn(applyEventUpdate) },
  };
  const db = {
    outboxEvent: {
      findMany: vi.fn(async () => events.filter((e) => e.publishedAt === null && e.parkedAt === null)),
      update: vi.fn(applyEventUpdate),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data), // E：ClaimExpired 事件
    },
    outboxDelivery: {
      // db 顶层 createMany 不应被路由使用（必须在事务内）
      createMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => deliveries),
      // CAS（D）：where 命中 status（成功路径）/ status+attempts（失败路径乐观锁）才更新；
      // 不再提供 .update——生产代码若回退到无条件 update 会在此 TypeError 翻红。
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: bigint; status?: string; attempts?: number };
          data: Partial<DeliveryRow>;
        }) => {
          const d = deliveries.find(
            (x) =>
              x.id === where.id &&
              (where.status === undefined || x.status === where.status) &&
              (where.attempts === undefined || x.attempts === where.attempts),
          );
          if (!d) return { count: 0 };
          Object.assign(d, data);
          return { count: 1 };
        },
      ),
    },
    claim: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    // interactive（fn）与批量（数组）两种形态都支持（E 用数组原子成对）。
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (t: typeof tx) => Promise<unknown>)(tx),
    ),
  };
  return { db, tx };
}

function makeTemporal(startImpl?: () => Promise<unknown>) {
  return {
    client: { workflow: { start: vi.fn(startImpl ?? (async () => ({}))) } },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function makeService(db: unknown, temporal: unknown, fetchFn?: unknown): AnyService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (OutboxRelayService as any)(temporal, db, fetchFn ?? vi.fn());
}

beforeEach(() => {
  delete process.env.SAAS_WEBHOOK_URL;
  delete process.env.SAAS_WEBHOOK_SECRET;
});
afterEach(() => {
  delete process.env.SAAS_WEBHOOK_URL;
  delete process.env.SAAS_WEBHOOK_SECRET;
  vi.restoreAllMocks();
});

describe('routeEvent — 三分支路由（收口③核心）', () => {
  it('integration 事件（LeadQualified）→ 同一事务内建 saas delivery + 标 published（旧代码：published 但零 delivery 行 → RED）', async () => {
    const ev = makeEvent();
    const { db, tx } = makeDb([ev]);
    const svc = makeService(db, makeTemporal());

    await svc.routeEvent(ev);

    // 交付行必须在事务内创建（tx），且 sink=saas、skipDuplicates 幂等
    expect(tx.outboxDelivery.createMany).toHaveBeenCalledTimes(1);
    const arg = tx.outboxDelivery.createMany.mock.calls[0][0] as {
      data: Array<{ workspaceId: string; eventId: string; sink: string }>;
      skipDuplicates: boolean;
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toEqual([{ workspaceId: WS, eventId: ev.eventId, sink: 'saas' }]);
    // published 同事务置位
    expect(tx.outboxEvent.update).toHaveBeenCalledTimes(1);
    expect(ev.publishedAt).toBeInstanceOf(Date);
    // 不允许绕过事务在 db 顶层写
    expect(db.outboxDelivery.createMany).not.toHaveBeenCalled();
  });

  it('URL + secret 都配置（https）→ saas + webhook 两个 sink', async () => {
    process.env.SAAS_WEBHOOK_URL = 'https://saas.example.com/hooks/events';
    process.env.SAAS_WEBHOOK_SECRET = 'test-secret';
    const ev = makeEvent();
    const { db, tx } = makeDb([ev]);
    const svc = makeService(db, makeTemporal());

    await svc.routeEvent(ev);

    const arg = tx.outboxDelivery.createMany.mock.calls[0][0] as {
      data: Array<{ sink: string }>;
    };
    expect(arg.data.map((d) => d.sink).sort()).toEqual(['saas', 'webhook']);
  });

  it('G 回归：URL 配了但缺 secret → webhook sink 拒绝启用（只建 saas 交付行）', async () => {
    process.env.SAAS_WEBHOOK_URL = 'https://saas.example.com/hooks/events';
    const ev = makeEvent();
    const { db, tx } = makeDb([ev]);
    const svc = makeService(db, makeTemporal());

    await svc.routeEvent(ev);

    const arg = tx.outboxDelivery.createMany.mock.calls[0][0] as { data: Array<{ sink: string }> };
    expect(arg.data.map((d) => d.sink)).toEqual(['saas']);
  });

  it('G 回归：http URL（非 localhost）→ 拒绝启用；http://localhost → dev 例外启用', async () => {
    process.env.SAAS_WEBHOOK_SECRET = 'test-secret';

    process.env.SAAS_WEBHOOK_URL = 'http://saas.example.com/hooks/events'; // 明文外网：拒
    const ev1 = makeEvent();
    const a = makeDb([ev1]);
    await makeService(a.db, makeTemporal()).routeEvent(ev1);
    const sinks1 = (a.tx.outboxDelivery.createMany.mock.calls[0][0] as { data: Array<{ sink: string }> }).data;
    expect(sinks1.map((d) => d.sink)).toEqual(['saas']);

    process.env.SAAS_WEBHOOK_URL = 'http://localhost:4001/hooks'; // dev 例外：放
    const ev2 = makeEvent({ id: 2n, eventId: 'aaaaaaaa-0000-0000-0000-000000000002' });
    const b = makeDb([ev2]);
    await makeService(b.db, makeTemporal()).routeEvent(ev2);
    const sinks2 = (b.tx.outboxDelivery.createMany.mock.calls[0][0] as { data: Array<{ sink: string }> }).data;
    expect(sinks2.map((d) => d.sink).sort()).toEqual(['saas', 'webhook']);
  });

  it('B 回归：internal command 的 workflow.start 抛 AlreadyStarted → 合并语义，事件仍标 published', async () => {
    for (const [eventType, aggregateType] of [
      ['CompanyProfileCreated', 'Company'],
      ['DiscoveryRunRequested', 'DiscoveryRun'],
      ['QualifyRequested', 'ICP'],
    ] as const) {
      const ev = makeEvent({ eventType, aggregateType, aggregateId: `agg-${eventType}`, publishedAt: null });
      const err = new Error('already started');
      err.name = 'WorkflowExecutionAlreadyStartedError';
      const temporal = makeTemporal(async () => {
        throw err;
      });
      const { db } = makeDb([ev]);
      const svc = makeService(db, temporal);
      const logSpy = vi.spyOn(svc['logger'], 'log');

      await svc.routeEvent(ev);

      // 旧代码：CompanyProfileCreated/DiscoveryRunRequested 无 catch → dispatch 失败不标 published
      //（每 2s 重试直到实例结束，日志风暴 + 假积压）→ 此断言 RED。
      expect(ev.publishedAt, `${eventType} 应视为已处理`).toBeInstanceOf(Date);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('merged'))).toBe(true);
    }
  });

  it('B 边界：AlreadyStarted 之外的错误照旧不标 published（下轮重试）', async () => {
    const ev = makeEvent({ eventType: 'CompanyProfileCreated', aggregateType: 'Company', publishedAt: null });
    const temporal = makeTemporal(async () => {
      throw new Error('temporal down');
    });
    const { db } = makeDb([ev]);
    const svc = makeService(db, temporal);
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc.routeEvent(ev);

    expect(ev.publishedAt).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('未注册类型 → parkedAt 置位、不标 published、不建 delivery、error 日志（大声）', async () => {
    const ev = makeEvent({ eventType: 'SomeBrandNewEvent' });
    const { db, tx } = makeDb([ev]);
    const svc = makeService(db, makeTemporal());
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc.routeEvent(ev);

    expect(ev.parkedAt).toBeInstanceOf(Date);
    expect(ev.publishedAt).toBeNull();
    expect(tx.outboxDelivery.createMany).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('internal command（QualifyRequested）→ dispatch 成功才标 published（行为保持）', async () => {
    const ev = makeEvent({ eventType: 'QualifyRequested', aggregateType: 'ICP', aggregateId: 'icp-1' });
    const { db, tx } = makeDb([ev]);
    const temporal = makeTemporal();
    const svc = makeService(db, temporal);

    await svc.routeEvent(ev);

    expect(temporal.client.workflow.start).toHaveBeenCalledTimes(1);
    expect(ev.publishedAt).toBeInstanceOf(Date);
    // internal command 不进交付账本
    expect(tx.outboxDelivery.createMany).not.toHaveBeenCalled();
  });

  it('internal command dispatch 失败 → 不标 published（下轮重试）', async () => {
    const ev = makeEvent({ eventType: 'DiscoveryRunRequested', aggregateType: 'DiscoveryRun', aggregateId: 'run-1' });
    const { db } = makeDb([ev]);
    const temporal = makeTemporal(async () => {
      throw new Error('temporal down');
    });
    const svc = makeService(db, temporal);
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc.routeEvent(ev);

    expect(ev.publishedAt).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('tick — 轮询条件（parked 不毒化轮询）', () => {
  it('轮询 where 必须是 publishedAt IS NULL AND parkedAt IS NULL', async () => {
    const { db } = makeDb([]);
    const svc = makeService(db, makeTemporal());

    await svc.tick();

    expect(db.outboxEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publishedAt: null, parkedAt: null } }),
    );
  });
});

describe('pumpWebhookDeliveries — 推送 + 指数退避 + DLQ', () => {
  const NOW = new Date('2026-07-10T09:00:00.000Z');
  const URL = 'https://saas.example.com/hooks/events';

  function makeDelivery(over: Partial<DeliveryRow> = {}): DeliveryRow {
    return {
      id: 10n,
      workspaceId: WS,
      eventId: 'aaaaaaaa-0000-0000-0000-000000000001',
      sink: 'webhook',
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: null,
      ackedAt: null,
      event: makeEvent(),
      ...over,
    };
  }

  const SECRET = 'verify-hmac-secret';

  beforeEach(() => {
    process.env.SAAS_WEBHOOK_URL = URL;
    process.env.SAAS_WEBHOOK_SECRET = SECRET;
  });

  it('2xx → status=ACKED、deliveredAt/ackedAt 置位', async () => {
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(d.status).toBe('ACKED');
    expect(d.deliveredAt).toBeInstanceOf(Date);
    expect(d.ackedAt).toBeInstanceOf(Date);
  });

  it('envelope 字段完整：snake_case + occurred_at ISO + 不泄漏 BigInt id', async () => {
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const envelope = JSON.parse(init.body) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      event_id: d.event.eventId,
      event_type: 'LeadQualified',
      schema_version: 1,
      workspace_id: WS,
      aggregate_type: 'Lead',
      aggregate_id: 'lead-1',
      occurred_at: '2026-07-10T08:00:00.000Z',
      producer: 'global-backend',
      correlation_id: null,
      causation_id: null,
      privacy_classification: 'CONFIDENTIAL',
      payload: { snapshot_version: 1 },
    });
    expect('id' in envelope).toBe(false); // BigInt 行 id 不进 envelope
  });

  it('500 → attempts+1、lastError、nextAttemptAt = now + 2^attempts×30s', async () => {
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(d.status).toBe('PENDING');
    expect(d.attempts).toBe(1);
    expect(d.lastError).toContain('500');
    // 2^1 × 30s = 60s
    expect(d.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('退避封顶 1h：attempts=6 失败 → 2^7×30s=3840s 封到 3600s', async () => {
    const d = makeDelivery({ attempts: 6 });
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(d.attempts).toBe(7);
    expect(d.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('第 10 次失败 → status=DEAD（DLQ）+ error 日志', async () => {
    const d = makeDelivery({ attempts: 9 });
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 }));
    const svc = makeService(db, makeTemporal(), fetchMock);
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc.pumpWebhookDeliveries(NOW);

    expect(d.attempts).toBe(10);
    expect(d.status).toBe('DEAD');
    expect(errSpy).toHaveBeenCalled();
  });

  it('fetch 异常（网络错）→ 与失败同路径：attempts+1、lastError 截断 500 字符', async () => {
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED ' + 'x'.repeat(600));
    });
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(d.attempts).toBe(1);
    expect(d.lastError).toContain('ECONNREFUSED');
    expect((d.lastError ?? '').length).toBeLessThanOrEqual(500);
    expect(d.status).toBe('PENDING');
  });

  it('G：请求带 x-timestamp + x-signature，且签名可用同 secret 复算验证（HMAC_SHA256(ts.body)）', async () => {
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(init.headers['x-timestamp']).toBe(NOW.toISOString());
    const expected = createHmac('sha256', SECRET)
      .update(`${init.headers['x-timestamp']}.${init.body}`)
      .digest('hex');
    expect(init.headers['x-signature']).toBe(`sha256=${expected}`);
  });

  it('G 回归：secret 缺失 → pump 直接返回，不发任何请求', async () => {
    delete process.env.SAAS_WEBHOOK_SECRET;
    const d = makeDelivery();
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.status).toBe('PENDING'); // 行原样保留，配置补齐后照常派送
  });

  it('D 回归（成功路径 CAS）：行已被 ACK API 抢先翻成 ACKED → count 0，本轮不覆写', async () => {
    // findMany 与推送之间行被推进（双实例/ACK 竞态）：CAS where status=PENDING 不命中
    const priorAck = new Date('2026-07-10T08:59:00.000Z');
    const d = makeDelivery({ status: 'ACKED', ackedAt: priorAck, deliveredAt: priorAck });
    const { db } = makeDb([], [d]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const svc = makeService(db, makeTemporal(), fetchMock);

    await svc.pumpWebhookDeliveries(NOW);

    // 旧代码 update({where:{id}}) 无条件覆写 ackedAt/deliveredAt → RED
    expect(d.ackedAt).toBe(priorAck);
    expect(d.deliveredAt).toBe(priorAck);
  });

  it('D 回归（失败路径乐观锁）：读时 attempts 已过期 → count 0 跳过，不覆写 DEAD、不丢更新', async () => {
    // 行实际 attempts=9（另一实例已记账），本执行者手里是读时快照 attempts=8：
    // 若无乐观锁，会把 attempts 写回 9 并再退避一次（丢失更新）；attempts=9 快照则会误判 DEAD。
    const d = makeDelivery({ attempts: 9, status: 'ACKED' }); // 且已被 ACK
    const { db } = makeDb([], [d]);
    const svc = makeService(db, makeTemporal(), vi.fn());
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc['recordWebhookFailure']({ id: d.id, eventId: d.eventId, attempts: 9 }, 'HTTP 500', NOW);

    // 旧代码：无条件 update → ACKED 被覆写成 DEAD + error 日志 → RED
    expect(d.status).toBe('ACKED');
    expect(d.attempts).toBe(9);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('expireDueClaims — EXPIRED 置位与 ClaimExpired 事件原子成对（E）', () => {
  const CLAIMS = [
    { id: 'c-1', workspaceId: WS, companyId: 'co-1', type: 'certification' },
    { id: 'c-2', workspaceId: WS, companyId: 'co-2', type: 'certification' },
  ];

  it('每条 claim 的 update + 事件 create 走同一个 $transaction（数组形式）', async () => {
    const { db } = makeDb([]);
    db.claim.findMany = vi.fn(async () => CLAIMS.slice(0, 1));
    const svc = makeService(db, makeTemporal());
    svc['expireCounter'] = 29; // 下一次调用命中 %30===0 的扫描轮

    await svc['expireDueClaims']();

    // 旧代码：两步裸调无事务 → $transaction 未被数组调用 → RED
    const txCalls = (db.$transaction.mock.calls as unknown[][]).filter((c) => Array.isArray(c[0]));
    expect(txCalls).toHaveLength(1);
    expect((txCalls[0][0] as unknown[]).length).toBe(2); // update + create 成对
    expect(db.claim.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'EXPIRED' } });
    expect(db.outboxEvent.create).toHaveBeenCalledTimes(1);
    const created = (db.outboxEvent.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(created).toMatchObject({ eventType: 'ClaimExpired', aggregateId: 'c-1' });
  });

  it('单条失败不阻断本批：第一条事务抛错 → 第二条仍处理 + error 日志', async () => {
    const { db } = makeDb([]);
    db.claim.findMany = vi.fn(async () => CLAIMS);
    db.claim.update = vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'c-1') throw new Error('deadlock');
      return {};
    });
    const svc = makeService(db, makeTemporal());
    svc['expireCounter'] = 29;
    const errSpy = vi.spyOn(svc['logger'], 'error');

    await svc['expireDueClaims']();

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('c-1'))).toBe(true);
    expect(db.claim.update).toHaveBeenCalledWith({ where: { id: 'c-2' }, data: { status: 'EXPIRED' } });
  });
});
