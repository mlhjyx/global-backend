import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AckEventsDto, EVENT_ENVELOPE_SCHEMA, EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * 收口③ controller 面回归：
 * - K：GET /events 三个 query 参数显式 @ApiQuery required:false——swagger 对 @Query 推断
 *   required:true，SaaS codegen 客户端会强制要参数（契约缺陷）。
 * - F：ACK 不透传 sink——AckEventsDto 无 sink 字段，controller 只把 event_ids 交给 service
 *   （service 缺省锁死 pull sink 'saas'）。
 */

/** @nestjs/swagger 存 @ApiQuery 元数据的 key（DECORATORS.API_PARAMETERS）。 */
const API_PARAMETERS_KEY = 'swagger/apiParameters';

describe('EventsController — swagger 契约（K）', () => {
  it('GET /events 的 cursor/limit/type 都显式 required:false；limit 带 integer schema', () => {
    const params = Reflect.getMetadata(API_PARAMETERS_KEY, EventsController.prototype.list) as Array<{
      name?: string;
      required?: boolean;
      schema?: { type?: string; default?: number; maximum?: number };
    }>;
    expect(params).toBeDefined();
    const byName = new Map(params.map((p) => [p.name, p]));

    for (const name of ['cursor', 'limit', 'type']) {
      const p = byName.get(name);
      expect(p, `@ApiQuery(${name}) 缺失`).toBeDefined();
      expect(p!.required, `@ApiQuery(${name}) 必须 required:false`).toBe(false);
    }
    expect(byName.get('limit')!.schema).toMatchObject({ type: 'integer', default: 50, maximum: 200 });
  });
});

describe('EventsController.ack — sink 锁死 pull sink（F）', () => {
  it('AckEventsDto 不再有 sink 字段（对外 API 无从指定 webhook sink）', () => {
    // DTO 类属性靠 class-validator 装饰器登记；sink 已删 → 实例上不可能出现该验证目标。
    // 直接断言构造出的 DTO 形状 + 类型层（编译期）已无 sink。
    const dto = new AckEventsDto();
    expect('sink' in dto).toBe(false);
  });

  it('controller 只透传 event_ids，不带 sink 参数（service 缺省 saas）', async () => {
    const ack = vi.fn(async () => ({ acked: 1 }));
    const controller = new EventsController({ ack } as unknown as EventsService);
    const ctx = { workspaceId: 'ws-1', userId: 'u-1' };
    const dto = Object.assign(new AckEventsDto(), {
      event_ids: ['aaaaaaaa-0000-0000-0000-000000000001'],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.ack(ctx as any, dto);

    // 精确到参数个数：第三个 sink 参数不存在（缺省交给 service 锁 'saas'）
    expect(ack).toHaveBeenCalledWith(ctx, dto.event_ids);
    expect(ack.mock.calls[0]).toHaveLength(2);
  });
});

describe('EventsController — 统一响应信封（收口④）', () => {
  const ctx = { workspaceId: 'ws-1', userId: 'u-1' };

  it('GET /events 返回分页信封 { data, page: { next_cursor, has_more } }', async () => {
    const envelopes = [{ event_id: 'aaaaaaaa-0000-0000-0000-000000000001' }];
    const list = vi.fn(async () => ({ data: envelopes, nextCursor: '42', hasMore: true }));
    const controller = new EventsController({ list } as unknown as EventsService);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.list(ctx as any);

    expect(res).toEqual({
      data: envelopes,
      page: { next_cursor: '42', has_more: true },
    });
  });

  it('POST /events/ack 返回 { data: { acked } }', async () => {
    const ack = vi.fn(async () => ({ acked: 3 }));
    const controller = new EventsController({ ack } as unknown as EventsService);
    const dto = Object.assign(new AckEventsDto(), {
      event_ids: ['aaaaaaaa-0000-0000-0000-000000000001'],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await controller.ack(ctx as any, dto);

    expect(res).toEqual({ data: { acked: 3 } });
  });
});

describe('EVENT_ENVELOPE_SCHEMA — 与 contracts/events/envelope.schema.json 镜像一致（防双源漂移）', () => {
  const contract = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../packages/contracts/events/envelope.schema.json'),
      'utf8',
    ),
  ) as { required: string[]; properties: Record<string, { enum?: string[] }> };

  it('required 列表与事件契约一致', () => {
    expect([...(EVENT_ENVELOPE_SCHEMA.required ?? [])].sort()).toEqual(
      [...contract.required].sort(),
    );
  });

  it('privacy_classification 枚举与事件契约一致', () => {
    expect(EVENT_ENVELOPE_SCHEMA.properties.privacy_classification.enum).toEqual(
      contract.properties.privacy_classification.enum,
    );
  });

  it('属性键集覆盖事件契约全部属性（openapi 不少字段）', () => {
    const contractKeys = Object.keys(contract.properties).sort();
    const schemaKeys = Object.keys(EVENT_ENVELOPE_SCHEMA.properties).sort();
    expect(schemaKeys).toEqual(contractKeys);
  });
});
