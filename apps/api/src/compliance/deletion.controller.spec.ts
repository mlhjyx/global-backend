import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { DeletionController } from './deletion.controller';

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
