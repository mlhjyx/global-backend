import { describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  sameIntent,
  mergeIntent,
  IntentAttr,
  IntentEvent,
  IntentProjectionService,
} from './intent-projection.service';
import { ToolPolicyDenied } from '../tools/tool-broker';
import { BudgetOperationReplayError } from '../tools/budget-store';

// 这三个纯函数是 TED P3 / openFDA P3 / web_watch 共享的**幂等基石**——每 sweep 复现同一信号时靠它们判「实质未变」
// 而不重写 canonical / 不堆 field_evidence。TED P3 实测抓到过 jsonb 键序 bug（DB 取回对象键序被 Postgres 规范化，
// 与内存插入序不同 → 朴素 JSON.stringify 误判「变了」）——canonicalize 就是修复。此处把该纪律锁进单测。

describe('canonicalize —— 键序无关的稳定规范形（jsonb 往返比较）', () => {
  it('对象递归按键名排序，键序不同 → 规范形相同', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
  });
  it('数组保序（顺序是语义，不排序）', () => {
    expect(JSON.stringify(canonicalize([3, 1, 2]))).toBe(JSON.stringify([3, 1, 2]));
  });
  it('标量原样', () => {
    expect(canonicalize('x')).toBe('x');
    expect(canonicalize(5)).toBe(5);
    expect(canonicalize(null)).toBe(null);
  });
});

const ev = (over: Partial<IntentEvent> = {}): IntentEvent => ({ type: 'FDA_CLEARANCE', at: '2025-09-08', strength: 0.85, ...over });

describe('sameIntent —— 实质相等判定（忽略 _ts，键序无关）', () => {
  it('同内容 → 相等（幂等门核心：仅时间戳变不算变）', () => {
    const a = mergeIntent(undefined, [ev()]);
    const b = mergeIntent(undefined, [ev()]);
    expect(sameIntent(a, b)).toBe(true);
  });
  it('模拟 jsonb 键序被规范化（DB 取回）→ 仍判相等', () => {
    const inMemory = mergeIntent(undefined, [ev()]);
    // 模拟 Postgres jsonb 往返：深拷贝并打乱顶层键序
    const fromDb = JSON.parse(JSON.stringify({ _ts: inMemory._ts, events: inMemory.events, counts: inMemory.counts, intent_score: inMemory.intent_score, last_change_at: inMemory.last_change_at })) as IntentAttr;
    expect(sameIntent(inMemory, fromDb)).toBe(true);
  });
  it('内容不同（新事件）→ 不相等', () => {
    const a = mergeIntent(undefined, [ev({ at: '2025-09-08' })]);
    const b = mergeIntent(a, [ev({ at: '2026-04-22', evidence: { k: 'K111' } })]);
    expect(sameIntent(a, b)).toBe(false);
  });
});

describe('mergeIntent —— 合并/去重/滚动/幂等', () => {
  it('按 type|at|url 去重（同一清关每 sweep 复现 → 不重复堆事件）', () => {
    const first = mergeIntent(undefined, [ev()]);
    const again = mergeIntent(first, [ev()]); // 同一事件再来
    expect(again.events.length).toBe(1);
    expect(sameIntent(first, again)).toBe(true); // 幂等：再合并实质未变
  });
  it('新近降序 + counts 累计 + intent_score=最强', () => {
    const merged = mergeIntent(undefined, [ev({ at: '2025-01-01', strength: 0.5 }), ev({ at: '2026-04-22', strength: 0.85 })]);
    expect(merged.events[0].at).toBe('2026-04-22'); // 最新在前
    expect(merged.counts.FDA_CLEARANCE).toBe(2);
    expect(merged.intent_score).toBe(0.85);
  });
  it('相等 at 的不同类型事件 → 稳定序，重复合并幂等（比较器一致性回归）', () => {
    // 同 at 不同 type（FDA 清关 + 网站变更同日）——比较器若不一致会重排 → 破幂等。
    const events: IntentEvent[] = [ev({ type: 'FDA_CLEARANCE', at: '2025-09-08' }), ev({ type: 'PAGE_CHANGED', at: '2025-09-08', strength: 0.3 })];
    const m1 = mergeIntent(undefined, events);
    const m2 = mergeIntent(m1, events); // 再合并同样两条
    expect(m2.events.length).toBe(2);
    expect(sameIntent(m1, m2)).toBe(true); // 稳定序 → 幂等成立
  });
  it('滚动保留上限（不无限增长）', () => {
    const many: IntentEvent[] = Array.from({ length: 30 }, (_, i) => ev({ at: `2025-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}`, evidence: { i } }));
    const merged = mergeIntent(undefined, many);
    expect(merged.events.length).toBeLessThanOrEqual(20);
  });
});

// ─── 收口⑤ HIGH 回归锁：mergeIntent at 格式漂移免疫（epoch 归一去重键 + 一致比较器）───
import { mergeIntent as mergeIntentFn, sameIntent as sameIntentFn } from './intent-projection.service';

describe('mergeIntent — at 格式漂移免疫（存量旧格式与新 UTC ISO 同刻去重，一次重写即收敛）', () => {
  it('date-only / UTC ISO / 带时区 ISO 同刻 → 去重为一条（incoming 新格式存活）', () => {
    const prev = mergeIntentFn(undefined, [{ type: 'FDA_CLEARANCE', at: '2026-05-05', strength: 0.85 }]);
    const next = mergeIntentFn(prev, [{ type: 'FDA_CLEARANCE', at: '2026-05-05T00:00:00.000Z', strength: 0.85 }]);
    expect(next.events).toHaveLength(1);
    expect(next.events[0].at).toBe('2026-05-05T00:00:00.000Z');
    // 一次重写后收敛（再合并同事件 → 实质不变，增量 sweep 幂等恢复）
    const again = mergeIntentFn(next, [{ type: 'FDA_CLEARANCE', at: '2026-05-05T00:00:00.000Z', strength: 0.85 }]);
    expect(sameIntentFn(next, again)).toBe(true);

    const tzPrev = mergeIntentFn(undefined, [{ type: 'TENDER_PUBLISHED', at: '2026-07-08T00:00:00+02:00', strength: 0.9 }]);
    const tzNext = mergeIntentFn(tzPrev, [{ type: 'TENDER_PUBLISHED', at: '2026-07-07T22:00:00.000Z', strength: 0.9 }]);
    expect(tzNext.events).toHaveLength(1); // +02:00 与 UTC 等刻 → 同键
  });

  it('跨格式排序按真实时刻；不可解析 at 视为最旧（评分侧本就 0 分）', () => {
    const merged = mergeIntentFn(undefined, [
      { type: 'A', at: 'not-a-date', strength: 0.5 },
      { type: 'B', at: '2026-07-01', strength: 0.5 },
      { type: 'C', at: '2026-07-02T00:00:00+02:00', strength: 0.5 }, // = 2026-07-01T22:00Z，晚于 B
    ]);
    expect(merged.events.map((e) => e.type)).toEqual(['C', 'B', 'A']);
  });

  it('同刻不同 type / 不同 page_url 绝不误并（去重键其余维度保留）', () => {
    const merged = mergeIntentFn(undefined, [
      { type: 'PAGE_CHANGED', at: '2026-07-01T00:00:00.000Z', strength: 0.3, page_url: 'https://a.example/x' },
      { type: 'PAGE_CHANGED', at: '2026-07-01T00:00:00.000Z', strength: 0.3, page_url: 'https://a.example/y' },
      { type: 'HIRING_UP', at: '2026-07-01T00:00:00.000Z', strength: 0.6 },
    ]);
    expect(merged.events).toHaveLength(3);
  });
});

describe('IntentProjectionService — suppression authority materialization gate', () => {
  it('权威 domain suppression 已提交但派生 status 陈旧时只修复状态，不写 intent/evidence', async () => {
    const update = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'company-1',
          name: 'Acme GmbH',
          domain: 'blocked.example',
          attributes: {},
          status: 'NEW',
        })),
        updateMany,
        update,
      },
      suppressionRecord: {
        findMany: vi.fn(async () => [{ type: 'domain', value: 'blocked.example' }]),
      },
      fieldEvidence: { findMany: vi.fn(async () => []), create: evidenceCreate },
    };
    const prisma = {
      sourceEntityChange: {
        findMany: vi.fn(async () => [
          {
            changeType: 'PAGE_CHANGED',
            createdAt: new Date('2026-08-10T00:00:00.000Z'),
            detail: { strength: 0.3 },
            source: {
              config: { company: { name: 'Acme GmbH', domain: 'blocked.example' } },
            },
          },
        ]),
      },
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new IntentProjectionService({ prisma: prisma as never });

    await expect(service.projectIntent('workspace-1')).resolves.toEqual({
      companiesTouched: 0,
      eventsProjected: 0,
    });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});

describe('IntentProjectionService — watch registration terminal suppression denial', () => {
  it('quarantines historical sandbox evidence before sitemap discovery or monitored-source writes', async () => {
    const create = vi.fn(async () => ({ id: 'monitor-synthetic' }));
    const invoke = vi.fn();
    const tx = {
      canonicalCompany: {
        findUnique: vi.fn(async () => ({ name: 'Synthetic Co', domain: 'synthetic.example', region: null })),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [{ providerKey: 'sandbox', license: 'sandbox' }]),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
      monitoredSource: { findUnique: vi.fn(async () => null), create },
    };
    const service = new IntentProjectionService({
      prisma: prisma as never,
      broker: { invoke } as never,
    });

    await expect(
      service.registerWatch('workspace-1', 'company-synthetic', {
        pages: [{ url: 'https://synthetic.example/', kind: 'homepage' }],
      }),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_DISCOVERY_PROVENANCE' });
    expect(invoke).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not downgrade a sitemap suppression denial into homepage monitor creation', async () => {
    const create = vi.fn(async () => ({ id: 'monitor-1' }));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: unknown) => unknown) =>
        callback({
          canonicalCompany: {
            findUnique: vi.fn(async () => ({ id: 'company-1', name: 'Acme GmbH', domain: 'acme.example', region: null })),
          },
          fieldEvidence: { findMany: vi.fn(async () => []) },
        }),
      ),
      monitoredSource: {
        findUnique: vi.fn(async () => null),
        create,
      },
    };
    const broker = {
      invoke: vi.fn(async () => {
        throw new ToolPolicyDenied('http.get', 'suppression_action_gate');
      }),
    };
    const budgetStore = { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const budgetedService = new IntentProjectionService({
      prisma: prisma as never,
      broker: broker as never,
      budgetStore: budgetStore as never,
    });

    await expect(
      budgetedService.registerWatch('workspace-1', 'company-1', {
        authorizeExternalAction: vi.fn(async () => false),
        budgetKey: 'watch:company-1',
        budgetWorkspaceId: 'workspace-1',
      }),
    ).rejects.toThrow(/suppression_action_gate/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('IntentProjectionService — synthetic projection quarantine', () => {
  it('does not derive intent or evidence from a historical sandbox-backed canonical company', async () => {
    const update = vi.fn();
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'company-synthetic',
          name: 'Synthetic Co',
          domain: 'synthetic.example',
          dedupeKey: 'd:synthetic.example',
          attributes: {},
          status: 'NEW',
        })),
        update,
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: {
        findMany: vi.fn(async () => [{ providerKey: 'sandbox', license: 'sandbox' }]),
        create: evidenceCreate,
      },
    };
    const prisma = {
      sourceEntityChange: {
        findMany: vi.fn(async () => [
          {
            changeType: 'PAGE_CHANGED',
            createdAt: new Date('2026-08-10T00:00:00.000Z'),
            detail: { strength: 0.3 },
            source: { config: { company: { name: 'Synthetic Co', domain: 'synthetic.example' } } },
          },
        ]),
      },
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new IntentProjectionService({ prisma: prisma as never });

    await expect(service.projectIntent('workspace-1')).resolves.toEqual({
      companiesTouched: 0,
      eventsProjected: 0,
    });
    expect(update).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});

describe('IntentProjectionService — sitemap budget scope', () => {
  it('opens the caller scope and binds broker runId to the same budgetKey', async () => {
    const order: string[] = [];
    const invoke = vi.fn(async (_tool, _input, context) => {
      order.push('wire');
      expect(context).toMatchObject({
        workspaceId: 'workspace-1',
        runId: 'discovery:run-1:watches:company-1',
        correlationId: 'discovery:run-1:watches:company-1',
      });
      return { data: { status: 404, body: '', headers: {}, url: 'https://acme.example/sitemap.xml' }, costCents: 0 };
    });
    const budgetStore = {
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => unknown) => fn({
        canonicalCompany: { findUnique: vi.fn(async () => ({ id: 'company-1', name: 'Acme', domain: 'acme.example', region: null })) },
        fieldEvidence: { findMany: vi.fn(async () => []) },
      })),
      monitoredSource: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'monitor-1' })),
      },
    };
    const service = new IntentProjectionService({ prisma: prisma as never, broker: { invoke } as never, budgetStore: budgetStore as never });

    await service.registerWatch('workspace-1', 'company-1', {
      budgetKey: 'discovery:run-1:watches:company-1',
      budgetWorkspaceId: 'workspace-1',
    });

    expect(budgetStore.open).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', accountKey: 'discovery:run-1:watches:company-1', capCents: expect.any(Number), replayScope: true,
    });
    expect(budgetStore.close).toHaveBeenCalledWith({ workspaceId: 'workspace-1', accountKey: 'discovery:run-1:watches:company-1' });
    expect(order[0]).toBe('open');
    expect(order.at(-1)).toBe('close');
  });

  it('propagates replay loss and does not create a homepage-only monitor', async () => {
    const replayError = new BudgetOperationReplayError('http-op');
    const create = vi.fn();
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => unknown) => fn({
        canonicalCompany: { findUnique: vi.fn(async () => ({ id: 'company-1', name: 'Acme', domain: 'acme.example', region: null })) },
        fieldEvidence: { findMany: vi.fn(async () => []) },
      })),
      monitoredSource: { findUnique: vi.fn(async () => null), create },
    };
    const budgetStore = { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const service = new IntentProjectionService({
      prisma: prisma as never,
      broker: { invoke: vi.fn(async () => { throw replayError; }) } as never,
      budgetStore: budgetStore as never,
    });

    await expect(service.registerWatch('workspace-1', 'company-1', {
      budgetKey: 'watch:company-1', budgetWorkspaceId: 'workspace-1',
    })).rejects.toBe(replayError);
    expect(create).not.toHaveBeenCalled();
    expect(budgetStore.close).toHaveBeenCalled();
  });
});
