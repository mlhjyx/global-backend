import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA,
  ExecutionBudgetWindowUsageService,
} from './execution-budget-window-usage.service';
import { parseWindowUsageQuery } from './execution-budget-window-usage.controller';

/**
 * ch08 §3.1.1 C1a：窗口实扣读回。锁三件事——
 *  - 口径：charged_microusd 实扣为唯一权威（不是 usage_ledger / cost_ledger 镜像）；
 *  - 形状：bigint → 字符串（µUSD 精度不丢），byPurpose 过滤零值；
 *  - 边界：workspaceId 必须是 UUID，since 必须是过去时间的 ISO8601。
 */

const WS = '11111111-1111-4111-8111-111111111111';
const SINCE = new Date('2026-10-10T00:00:00.000Z');

function makeService(
  totals: Array<{ charged: bigint | null; reserved: bigint | null }>,
  purposes: Array<{ purpose: string; charged: bigint | null }>,
) {
  const calls: Array<{ sql: Prisma.Sql }> = [];
  const prisma = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      calls.push({ sql });
      return calls.length === 1 ? totals : purposes;
    }),
  };
  const service = new ExecutionBudgetWindowUsageService(prisma as never);
  return { service, calls };
}

describe('ExecutionBudgetWindowUsageService', () => {
  it('returns charged/reserved/byPurpose as µUSD strings and keeps the query workspace-scoped', async () => {
    const { service, calls } = makeService(
      [{ charged: 2_410_250n, reserved: 500_000n }],
      [
        { purpose: 'discovery.run', charged: 2_100_000n },
        { purpose: 'understanding.run', charged: 310_250n },
        { purpose: 'campaign.plan', charged: 0n },
      ],
    );

    const usage = await service.windowUsage({ workspaceId: WS, since: SINCE });

    expect(usage).toEqual({
      schemaVersion: EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA,
      workspaceId: WS,
      since: '2026-10-10T00:00:00.000Z',
      chargedMicrousd: '2410250',
      reservedMicrousd: '500000',
      byPurpose: {
        'discovery.run': '2100000',
        'understanding.run': '310250',
      },
    });
    // 两条查询都必须带 workspaceId 与 since 参数，且 charged 口径只认 tool_budget_operation。
    expect(calls).toHaveLength(2);
    const text = (sql: { strings: readonly string[] }): string => sql.strings.join('?');
    for (const { sql } of calls) {
      expect(text(sql)).toContain('tool_budget_operation');
      expect(text(sql)).toContain('charged_microusd');
      expect(sql.values).toContain(WS);
      expect(sql.values).toContain(SINCE);
    }
    expect(text(calls[0]!.sql)).toContain("o.status IN ('SETTLED', 'RESULT_UNKNOWN')");
    expect(text(calls[1]!.sql)).toContain('execution_budget_authority');
  });

  it('defaults to zero when no operation rows match the window', async () => {
    const { service } = makeService([], []);

    const usage = await service.windowUsage({ workspaceId: WS, since: SINCE });

    expect(usage.chargedMicrousd).toBe('0');
    expect(usage.reservedMicrousd).toBe('0');
    expect(usage.byPurpose).toEqual({});
  });

  it('treats NULL sums (no rows / all-NULL columns) as zero', async () => {
    const { service } = makeService([{ charged: null, reserved: null }], [
      { purpose: 'unknown', charged: null },
    ]);

    const usage = await service.windowUsage({ workspaceId: WS, since: SINCE });

    expect(usage.chargedMicrousd).toBe('0');
    expect(usage.reservedMicrousd).toBe('0');
    expect(usage.byPurpose).toEqual({});
  });
});

describe('parseWindowUsageQuery', () => {
  /** HttpException 的 payload 在 `.response` 上；同步断言用它而不是 toThrowError（后者只比对 message）。 */
  function expectInvalid(fn: () => unknown): void {
    let caught: unknown;
    try {
      fn();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      response: { error: { code: 'EXECUTION_BUDGET_WINDOW_USAGE_INVALID' } },
    });
  }

  it('accepts a UUID workspace and an ISO8601 past timestamp', () => {
    const parsed = parseWindowUsageQuery({
      workspaceId: WS,
      since: '2026-10-10T00:00:00.000Z',
    });
    expect(parsed.workspaceId).toBe(WS);
    expect(parsed.since.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('rejects a non-UUID workspace id', () => {
    expectInvalid(() => parseWindowUsageQuery({ workspaceId: 'x', since: '2026-10-10' }));
  });

  it('rejects an unparseable or future since', () => {
    expectInvalid(() => parseWindowUsageQuery({ workspaceId: WS, since: 'not-a-date' }));
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expectInvalid(() => parseWindowUsageQuery({ workspaceId: WS, since: future }));
  });

  it('rejects non-object query shapes', () => {
    expectInvalid(() => parseWindowUsageQuery(null));
    expectInvalid(() => parseWindowUsageQuery(['x']));
  });
});
