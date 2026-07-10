import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AckEventsDto, EventsController } from './events.controller';
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
