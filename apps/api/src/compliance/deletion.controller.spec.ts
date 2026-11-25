import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { DeletionController } from './deletion.controller';
import type { DeletionService } from './deletion.service';

const API_PARAMETERS_KEY = 'swagger/apiParameters';

/**
 * Codex P2「Validate deletion request ids before querying Prisma」：GET /deletion-requests/:id 的 :id 必须经
 * ParseUUIDPipe 校验（与同仓其他 UUID 路由一致），非 UUID 在到达 Prisma/Postgres 前即 400，不会被全局
 * catch-all 报成 500。此处直接断言路由参数元数据上挂了 ParseUUIDPipe（CI 纯单测，无需起 HTTP/DB）。
 */
describe('DeletionController · :id UUID validation (Codex P2 on PR #63)', () => {
  it('GET :id binds ParseUUIDPipe on the path param', () => {
    const meta =
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, DeletionController, 'get') as Record<
        string,
        { pipes?: unknown[] }
      >) ?? {};
    const pipes = Object.values(meta).flatMap((m) => m.pipes ?? []);
    expect(pipes).toContain(ParseUUIDPipe);
  });
});

describe('DeletionController · GET /deletion-requests', () => {
  it('declares limit/cursor/status as required:false in Swagger metadata', () => {
    const params = Reflect.getMetadata(API_PARAMETERS_KEY, DeletionController.prototype.list) as Array<{
      name?: string;
      required?: boolean;
      schema?: { type?: string; default?: number; minimum?: number; maximum?: number };
    }>;
    expect(params).toBeDefined();
    const byName = new Map(params.map((p) => [p.name, p]));
    for (const name of ['limit', 'cursor', 'status']) {
      const p = byName.get(name);
      expect(p, `@ApiQuery(${name}) missing`).toBeDefined();
      expect(p!.required, `@ApiQuery(${name}) must be required:false`).toBe(false);
    }
    expect(byName.get('limit')!.schema).toMatchObject({ type: 'integer', default: 20, minimum: 1, maximum: 100 });
  });

  it('returns { data, page: { next_cursor, has_more } } and normalizes query params', async () => {
    const items = [{ id: '10000000-0000-4000-8000-000000000011' }];
    const listRequests = vi.fn(async () => ({
      data: items,
      nextCursor: '10000000-0000-4000-8000-000000000011',
      hasMore: true,
    }));
    const controller = new DeletionController({ listRequests } as unknown as DeletionService);
    const ctx = { workspaceId: 'ws-1', userId: 'u-1', roles: [], scopes: [] };

    const res = await controller.list(ctx as never, '1.5', '', '');
    expect(listRequests).toHaveBeenCalledWith('ws-1', {
      limit: 1,
      cursor: undefined,
      status: undefined,
    });
    expect(res).toEqual({
      data: items,
      page: { next_cursor: '10000000-0000-4000-8000-000000000011', has_more: true },
    });
  });
});
