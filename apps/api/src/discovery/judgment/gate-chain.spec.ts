import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import {
  SANCTIONS_STALE_ALERT_DEDUPE_HOURS,
  deepJudgeGateBlock,
  deepJudgeRunsL0,
  emitSanctionsStaleAlertIfNeeded,
  evaluateL0Gates,
  quickScanGateBlock,
  resetSanctionsStaleAlertDedupeForTests,
  sanctionsStaleAlertDedupeKey,
} from './gate-chain';
import { SANCTIONS_FRESH_MAX_HOURS, SANCTIONS_YELLOW_MAX_HOURS } from './gates';

/**
 * P3 J07/J08 门链接线单测（零容器）：假事务模拟两张门表与 outbox 事件表。
 * 真实数据口径：eu_fsf 最近一次刷新 FAILED 且时间戳超过 YELLOW 上限 → red。
 */

const NOW = new Date('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;
const WORKSPACE = '00000000-0000-4000-8000-00000000000a';
const ICP = '00000000-0000-4000-8000-0000000000b2';
const COMPANY = '00000000-0000-4000-8000-000000000001';

interface FakeWorld {
  company?: Record<string, unknown> | null;
  icp?: Record<string, unknown> | null;
  rules?: Array<Record<string, unknown>>;
  screening?: Record<string, unknown> | null;
  sources?: Array<{ key: string; lastRefreshedAt: Date | null; lastFetchStatus: string | null }>;
  domainStatus?: 'ALIVE' | 'DEAD' | 'UNKNOWN' | null;
}

interface FakeStore {
  results: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
}

function makeTx(world: FakeWorld, store: FakeStore): Prisma.TransactionClient {
  const resultKeys = new Set<string>();
  const taskKeys = new Set<string>();
  const insertMany = (
    target: Array<Record<string, unknown>>,
    keys: Set<string>,
    makeKey: (row: Record<string, unknown>) => string,
  ) =>
    vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const row of args.data) {
        const key = makeKey(row);
        if (keys.has(key)) continue;
        keys.add(key);
        target.push(row);
        count += 1;
      }
      return { count };
    });
  return {
    canonicalCompany: {
      findFirst: vi.fn(async () => world.company ?? null),
    },
    icpDefinition: {
      findFirst: vi.fn(async () => world.icp ?? { companyAttributes: {}, targetMarkets: [] }),
    },
    qualificationRule: { findMany: vi.fn(async () => world.rules ?? []) },
    sanctionsScreeningResult: { findUnique: vi.fn(async () => world.screening ?? null) },
    sanctionsSource: { findMany: vi.fn(async () => world.sources ?? []) },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    hardGateResult: {
      createMany: insertMany(
        store.results,
        resultKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}|${String(row.inputDigest)}`,
      ),
    },
    gateEnrichmentTask: {
      createMany: insertMany(
        store.tasks,
        taskKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}`,
      ),
    },
    outboxEvent: {
      findMany: vi.fn(async () => store.outbox.map((payload) => ({ payload }))),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        store.outbox.push(args.data.payload as Record<string, unknown>);
        return args.data;
      }),
    },
  } as unknown as Prisma.TransactionClient;
}

function freshStore(): FakeStore {
  return { results: [], tasks: [], outbox: [] };
}

function happyWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    company: {
      id: COMPANY,
      name: 'Muster Pumpen Handel GmbH',
      domain: 'muster-pumpen.de',
      country: 'DE',
      industry: '工业泵分销',
      employeeCount: 85,
      revenueUsd: null,
      status: 'NEW',
      attributes: {},
    },
    icp: { companyAttributes: {}, targetMarkets: [] },
    rules: [],
    screening: { status: 'clear', reviewState: 'open', listVersions: { ofac_sdn: '2026-11-01' } },
    // 真实数据口径：eu_fsf 最近一次刷新 FAILED 且 24h 前刚成功过 → yellow。
    sources: [
      { key: 'eu_fsf', lastRefreshedAt: new Date(NOW.getTime() - 24 * HOUR), lastFetchStatus: 'FAILED' },
    ],
    ...overrides,
  };
}

const CTX = {
  workspaceId: WORKSPACE,
  icpId: ICP,
  companyId: COMPANY,
  now: NOW,
} as const;

describe('evaluateL0Gates：制裁新鲜度四态（J07）', () => {
  it('eu_fsf FAILED 且超过 yellow 上限（当前真实数据）→ red', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(
      makeTx(
        happyWorld({
          sources: [
            {
              key: 'eu_fsf',
              lastRefreshedAt: new Date(NOW.getTime() - (SANCTIONS_YELLOW_MAX_HOURS + 24) * HOUR),
              lastFetchStatus: 'FAILED',
            },
          ],
        }),
        store,
      ),
      CTX,
    );

    expect(summary.sanctions.freshness).toBe('red');
    expect(summary.sanctions.staleMarker).toBe('red');
    // stale 是 PASS 的降级标记：链结论不是 FAIL，判定可继续。
    expect(summary.verdict).not.toBe('FAIL');
    expect(store.results.find((row) => row.gateId === 'G_SANCTIONS')).toMatchObject({
      verdict: 'PASS',
      reasonCode: 'GATE_SANCTIONS_STALE_RED',
    });
  });

  it('任一源 FAILED 且未超 yellow 上限 → yellow（不拦、不判 NOT_FIT）', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(makeTx(happyWorld(), store), CTX);

    expect(summary.sanctions.freshness).toBe('yellow');
    expect(summary.sanctions.staleMarker).toBe('yellow');
    expect(summary.verdict).not.toBe('FAIL');
    expect(deepJudgeGateBlock('enforce', summary)).toBeNull();
    expect(quickScanGateBlock('enforce', summary)).toBeNull();
  });

  it('全新源（刷新在 fresh 上限内且无失败）→ fresh，不发告警', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(
      makeTx(
        happyWorld({
          sources: [
            {
              key: 'ofac_sdn',
              lastRefreshedAt: new Date(NOW.getTime() - (SANCTIONS_FRESH_MAX_HOURS - 1) * HOUR),
              lastFetchStatus: 'DONE',
            },
          ],
        }),
        store,
      ),
      CTX,
    );

    expect(summary.sanctions.freshness).toBe('fresh');
    expect(summary.sanctions.staleMarker).toBeNull();
    expect(store.outbox).toHaveLength(0);
  });

  it('无 ENABLED 源 → not_screened（不是 fresh，也不发陈旧告警）', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(makeTx(happyWorld({ sources: [] }), store), CTX);

    expect(summary.sanctions.freshness).toBe('not_screened');
    expect(summary.sanctions.staleMarker).toBeNull();
    expect(store.outbox).toHaveLength(0);
  });
});

describe('判定链动作：quickScanGateBlock / deepJudgeGateBlock（J07/J08）', () => {
  it('G5 无域名 → 快扫任何模式都拦截进补数队列（UNKNOWN）', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(
      makeTx(
        happyWorld({
          company: { ...happyWorld().company, domain: null },
        }),
        store,
      ),
      CTX,
    );

    expect(summary.domainUnknown).toBe(true);
    const block = quickScanGateBlock('off', summary);
    expect(block).toMatchObject({
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_MISSING',
      verdict: 'UNKNOWN',
    });
    // 门引擎同时写补数任务（queued）。
    expect(store.tasks).toEqual([
      expect.objectContaining({
        canonicalCompanyId: COMPANY,
        gateId: 'G_DOMAIN',
        reasonCode: 'GATE_DOMAIN_MISSING',
        status: 'queued',
      }),
    ]);
  });

  it('G5 DEAD → 通过 domainStatus 注入同样进补数队列', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(makeTx(happyWorld(), store), {
      ...CTX,
      domainStatus: 'DEAD',
    });

    expect(quickScanGateBlock('off', summary)).toMatchObject({
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_DEAD',
    });
  });

  it('allow_domainless=true → G5 NOT_APPLICABLE，快扫照常判', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(
      makeTx(
        happyWorld({
          icp: { companyAttributes: { allow_domainless: true }, targetMarkets: [] },
          company: { ...happyWorld().company, domain: null },
        }),
        store,
      ),
      CTX,
    );

    expect(summary.domainUnknown).toBe(false);
    expect(quickScanGateBlock('enforce', summary)).toBeNull();
    expect(store.tasks).toHaveLength(0);
  });

  it('G1 命中：enforce 拦截、shadow/off 只记录；staleMarker 为 null（命中压过陈旧标记）', async () => {
    const store = freshStore();
    const summary = await evaluateL0Gates(
      makeTx(
        happyWorld({
          screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
        }),
        store,
      ),
      CTX,
    );

    expect(summary.verdict).toBe('FAIL');
    expect(summary.sanctions.hit).toBe(true);
    expect(summary.sanctions.staleMarker).toBeNull();
    expect(quickScanGateBlock('enforce', summary)).toMatchObject({
      gateId: 'G_SANCTIONS',
      reasonCode: 'GATE_SANCTIONS_HIT',
      verdict: 'FAIL',
    });
    expect(quickScanGateBlock('shadow', summary)).toBeNull();
    expect(deepJudgeGateBlock('enforce', summary)).not.toBeNull();
    expect(deepJudgeGateBlock('shadow', summary)).toBeNull();
  });

  it('深判是否评估 L0：off=false，shadow/enforce=true', () => {
    expect(deepJudgeRunsL0('off')).toBe(false);
    expect(deepJudgeRunsL0('shadow')).toBe(true);
    expect(deepJudgeRunsL0('enforce')).toBe(true);
  });
});

describe('SANCTIONS_LIST_STALE 告警去重（J07）', () => {
  it('同一源同一状态在窗口内只发一次（进程内去重）', async () => {
    resetSanctionsStaleAlertDedupeForTests();
    const store = freshStore();
    const tx = makeTx(happyWorld(), store);

    const first = await evaluateL0Gates(tx, CTX);
    const second = await evaluateL0Gates(tx, CTX);

    expect(first.staleAlertEmitted).toBe(true);
    expect(second.staleAlertEmitted).toBe(false);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      code: 'SANCTIONS_LIST_STALE',
      freshness: 'yellow',
      failedSourceKeys: ['eu_fsf'],
      thresholds: { freshMaxHours: SANCTIONS_FRESH_MAX_HOURS, yellowMaxHours: SANCTIONS_YELLOW_MAX_HOURS },
    });
  });

  it('进程内去重为空时回看库里的近期事件（重启后不轰炸）', async () => {
    resetSanctionsStaleAlertDedupeForTests();
    const store = freshStore();
    const tx = makeTx(happyWorld(), store);
    const key = sanctionsStaleAlertDedupeKey({
      workspaceId: WORKSPACE,
      freshness: 'yellow',
      failedSources: ['eu_fsf'],
      missingRefreshSources: [],
    });
    store.outbox.push({ dedupeKey: key, code: 'SANCTIONS_LIST_STALE' });

    const summary = await evaluateL0Gates(tx, CTX);

    expect(summary.staleAlertEmitted).toBe(false);
    expect(store.outbox).toHaveLength(1);
  });

  it('状态升级（yellow → red）算新事实：再发一条', async () => {
    resetSanctionsStaleAlertDedupeForTests();
    const yellowStore = freshStore();
    await evaluateL0Gates(makeTx(happyWorld(), yellowStore), CTX);

    // 同一（假）库里已有 yellow 事件；red 的 dedupeKey 不同 → 发新事件。
    const redStore = freshStore();
    const redTx = makeTx(
      happyWorld({
        sources: [
          {
            key: 'eu_fsf',
            lastRefreshedAt: new Date(NOW.getTime() - (SANCTIONS_YELLOW_MAX_HOURS + 1) * HOUR),
            lastFetchStatus: 'FAILED',
          },
        ],
      }),
      redStore,
    );
    // 把 yellow 事件放进 red 的库里，验证「旧状态不挡新状态」。
    redStore.outbox.push(...yellowStore.outbox);
    const summary = await evaluateL0Gates(redTx, CTX);

    expect(summary.staleAlertEmitted).toBe(true);
    expect(redStore.outbox.at(-1)).toMatchObject({ freshness: 'red' });
  });

  it('emitStaleAlert=false 时只记录门结果不发事件', async () => {
    resetSanctionsStaleAlertDedupeForTests();
    const store = freshStore();
    const summary = await evaluateL0Gates(makeTx(happyWorld(), store), {
      ...CTX,
      emitStaleAlert: false,
    });

    expect(summary.sanctions.freshness).toBe('yellow');
    expect(summary.staleAlertEmitted).toBe(false);
    expect(store.outbox).toHaveLength(0);
  });

  it('去重窗口是 6 小时常量（不是 env）', () => {
    expect(SANCTIONS_STALE_ALERT_DEDUPE_HOURS).toBe(6);
  });

  it('emitSanctionsStaleAlertIfNeeded 对非 stale 决策是 no-op', async () => {
    resetSanctionsStaleAlertDedupeForTests();
    const store = freshStore();
    const emitted = await emitSanctionsStaleAlertIfNeeded(makeTx(happyWorld(), store), {
      workspaceId: WORKSPACE,
      icpId: ICP,
      decision: {
        gateId: 'G_SANCTIONS',
        gateVersion: 'sanctions-gate/v1',
        verdict: 'PASS',
        reasonCode: null,
        applicable: true,
        facts: { freshness: 'fresh' },
        inputDigest: 'a'.repeat(64),
      },
      now: NOW,
    });
    expect(emitted).toBe(false);
    expect(store.outbox).toHaveLength(0);
  });
});
