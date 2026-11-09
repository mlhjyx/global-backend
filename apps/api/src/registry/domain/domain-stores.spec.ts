import { describe, expect, it } from 'vitest';
import {
  DomainResolutionStoreError,
  validateResolutionUpsert,
  type DomainResolutionUpsert,
} from './domain-resolution-store';
import {
  InMemoryDomainResolutionStore,
  InMemoryDomainReviewTaskStore,
} from './domain-stores.test-fixture';
import { DomainReviewTaskStoreError } from './domain-review-store';

const WS = '11111111-1111-4111-8111-111111111111';
const WS2 = '99999999-9999-4999-8999-999999999999';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const COMPANY2 = '22222222-2222-4222-8222-333333333333';

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

const NOW = '2026-11-09T12:00:00.000Z';

const verified: DomainResolutionUpsert = {
  candidateDomain: 'pompes-martin.fr',
  route: 'source_field',
  routeRank: 0,
  status: 'VERIFIED',
  matchType: 'EXACT',
  confidence: 95,
  evidenceUrl: 'https://pompes-martin.fr/impressum',
  evidenceHash: 'a'.repeat(64),
  evidenceJson: { register: 'fr_siren', value: '529990001' },
  extractorVersion: 'domain-verifier/v1',
  verifiedAt: '2026-11-09T11:00:00.000Z',
};

describe('validateResolutionUpsert', () => {
  it('accepts a well-formed VERIFIED candidate', () => {
    expect(() => validateResolutionUpsert(verified)).not.toThrow();
  });

  it('fails closed on bad domain, status, rank, confidence and missing verifiedAt', () => {
    expect(() => validateResolutionUpsert({ ...verified, candidateDomain: 'not a domain' })).toThrow(
      DomainResolutionStoreError,
    );
    expect(() =>
      validateResolutionUpsert({ ...verified, status: 'DONE' as never }),
    ).toThrow(/RESOLUTION_STATUS_INVALID|状态非法/u);
    expect(() => validateResolutionUpsert({ ...verified, routeRank: -1 })).toThrow(
      /routeRank/u,
    );
    expect(() => validateResolutionUpsert({ ...verified, routeRank: 1.5 })).toThrow(/routeRank/u);
    expect(() => validateResolutionUpsert({ ...verified, confidence: 101 })).toThrow(
      /置信分/u,
    );
    expect(() =>
      validateResolutionUpsert({ ...verified, verifiedAt: undefined }),
    ).toThrow(/verifiedAt/u);
  });
});

describe('DomainResolutionStore contract (in-memory)', () => {
  it('upserts idempotently by business key and never touches the selected flag', async () => {
    const store = new InMemoryDomainResolutionStore(nextId);
    const first = await store.upsert(WS, COMPANY, verified, NOW);
    expect(first.inserted).toBe(true);

    // 同一 (workspace, company, domain, route) 再写 = 幂等更新，不新增行。
    const second = await store.upsert(
      WS,
      COMPANY,
      { ...verified, confidence: 88, evidenceJson: { note: 'refreshed' } },
      '2026-11-09T13:00:00.000Z',
    );
    expect(second).toEqual({ id: first.id, inserted: false });
    let rows = await store.listForCompany(WS, COMPANY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confidence: 88, evidenceJson: { note: 'refreshed' } });

    // 选中之后再 upsert，不许把选中位洗掉。
    await store.selectVerified(WS, COMPANY, first.id, NOW);
    await store.upsert(WS, COMPANY, verified, '2026-11-09T14:00:00.000Z');
    rows = await store.listForCompany(WS, COMPANY);
    expect(rows[0]!.selected).toBe(true);
  });

  it('keeps the distinct route separate for the same domain', async () => {
    const store = new InMemoryDomainResolutionStore(nextId);
    await store.upsert(WS, COMPANY, verified, NOW);
    const viaSearch = await store.upsert(
      WS,
      COMPANY,
      { ...verified, route: 'search', routeRank: 2 },
      NOW,
    );
    expect(viaSearch.inserted).toBe(true);
    expect(await store.listForCompany(WS, COMPANY)).toHaveLength(2);
  });

  it('selects only a VERIFIED row and at most one per company', async () => {
    const store = new InMemoryDomainResolutionStore(nextId);
    const pending = await store.upsert(
      WS,
      COMPANY,
      { ...verified, candidateDomain: 'pending.example.fr', route: 'search', routeRank: 2, status: 'AMBIGUOUS', verifiedAt: null },
      NOW,
    );
    await expect(store.selectVerified(WS, COMPANY, pending.id, NOW)).rejects.toThrow(
      /VERIFIED/u,
    );
    await expect(
      store.selectVerified(WS, COMPANY, '00000000-0000-4000-8000-0000000000ff', NOW),
    ).rejects.toThrow(/不存在/u);

    const a = await store.upsert(WS, COMPANY, verified, NOW);
    const b = await store.upsert(
      WS,
      COMPANY,
      { ...verified, candidateDomain: 'pompes-martin.com', route: 'wikidata_p856', routeRank: 2 },
      NOW,
    );
    await store.selectVerified(WS, COMPANY, a.id, NOW);
    expect(store.selectedFor(WS, COMPANY).map((row) => row.id)).toEqual([a.id]);
    await store.selectVerified(WS, COMPANY, b.id, NOW);
    expect(store.selectedFor(WS, COMPANY).map((row) => row.id)).toEqual([b.id]);
    // 其他公司/工作区不受影响。
    expect(store.selectedFor(WS, COMPANY2)).toEqual([]);
    expect(store.selectedFor(WS2, COMPANY)).toEqual([]);
  });

  it('clears the selected row so it can be re-judged to a terminal status', async () => {
    const store = new InMemoryDomainResolutionStore(nextId);
    const a = await store.upsert(WS, COMPANY, verified, NOW);
    await store.selectVerified(WS, COMPANY, a.id, NOW);
    expect(await store.clearSelected(WS, COMPANY, NOW)).toBe(1);
    expect(store.selectedFor(WS, COMPANY)).toEqual([]);
    expect(await store.clearSelected(WS, COMPANY, NOW)).toBe(0);
    // 清掉选中后该行才能安全改判（迁移 CHECK 不允许 selected=true 的非 VERIFIED 行）。
    const rejected = await store.upsert(
      WS,
      COMPANY,
      { ...verified, status: 'REJECTED', verifiedAt: null },
      NOW,
    );
    expect(rejected.inserted).toBe(false);
    expect(store.selectedFor(WS, COMPANY)).toEqual([]);
  });

  it('lists a company in route-rank then domain order, scoped to the workspace', async () => {
    const store = new InMemoryDomainResolutionStore(nextId);
    await store.upsert(WS, COMPANY, { ...verified, candidateDomain: 'b.example.fr', route: 'search', routeRank: 2 }, NOW);
    await store.upsert(WS, COMPANY, { ...verified, candidateDomain: 'a.example.fr', route: 'ct_log', routeRank: 2 }, NOW);
    await store.upsert(WS, COMPANY, verified, NOW);
    await store.upsert(WS2, COMPANY, verified, NOW);
    const rows = await store.listForCompany(WS, COMPANY);
    expect(rows.map((row) => `${row.routeRank}:${row.candidateDomain}`)).toEqual([
      '0:pompes-martin.fr',
      '2:a.example.fr',
      '2:b.example.fr',
    ]);
  });
});

describe('DomainReviewTaskStore contract (in-memory)', () => {
  const open = (store: InMemoryDomainReviewTaskStore, overrides: Partial<{
    resolutionId: string;
    reason: 'low_confidence' | 'name_collision' | 'multi_candidates' | 'audit_sample';
    priority: number;
    dueAt: string;
  }> = {}) =>
    store.openOrGet(
      WS,
      {
        resolutionId: 'res-1',
        reason: 'low_confidence',
        priority: 50,
        dueAt: '2026-11-12T12:00:00.000Z',
        ...overrides,
      },
      NOW,
    );

  it('is idempotent while the task is OPEN and opens again after a decision', async () => {
    const store = new InMemoryDomainReviewTaskStore(nextId);
    const first = await open(store);
    expect(first.created).toBe(true);
    const second = await open(store);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);

    await store.decide(WS, first.task.id, { outcome: 'APPROVED', reviewer: 'ops', nowIso: NOW });
    const third = await open(store);
    expect(third.created).toBe(true);
    expect(third.task.id).not.toBe(first.task.id);
  });

  it('treats the decision as terminal and records the reviewer', async () => {
    const store = new InMemoryDomainReviewTaskStore(nextId);
    const { task } = await open(store);
    const decided = await store.decide(WS, task.id, {
      outcome: 'NOT_FOUND',
      reviewer: 'ops-alice',
      note: '证据不足',
      nowIso: NOW,
    });
    expect(decided).toMatchObject({
      status: 'NOT_FOUND',
      decidedAt: NOW,
      decisionNote: 'ops-alice: 证据不足',
    });
    await expect(
      store.decide(WS, task.id, { outcome: 'APPROVED', reviewer: 'ops', nowIso: NOW }),
    ).rejects.toThrow(DomainReviewTaskStoreError);
    await expect(
      store.decide(WS, 'ffffffff-ffff-4fff-8fff-ffffffffffff', {
        outcome: 'APPROVED',
        reviewer: 'ops',
        nowIso: NOW,
      }),
    ).rejects.toThrow(/不存在/u);
    await expect(
      store.decide(WS, task.id, { outcome: 'APPROVED', reviewer: '  ', nowIso: NOW }),
    ).rejects.toThrow(/reviewer/u);
  });

  it('scopes decisions to the task workspace', async () => {
    const store = new InMemoryDomainReviewTaskStore(nextId);
    const { task } = await open(store);
    await expect(
      store.decide(WS2, task.id, { outcome: 'APPROVED', reviewer: 'ops', nowIso: NOW }),
    ).rejects.toThrow(/不存在/u);
  });

  it('expires only overdue OPEN tasks and orders the open queue by priority then due', async () => {
    const store = new InMemoryDomainReviewTaskStore(nextId);
    const late = await open(store, { resolutionId: 'res-late', dueAt: '2026-11-08T12:00:00.000Z' });
    const future = await open(store, {
      resolutionId: 'res-future',
      reason: 'name_collision',
      priority: 70,
      dueAt: '2026-11-20T12:00:00.000Z',
    });
    const high = await open(store, {
      resolutionId: 'res-high',
      reason: 'multi_candidates',
      priority: 80,
      dueAt: '2026-11-19T12:00:00.000Z',
    });

    const openBefore = await store.listOpen(WS);
    expect(openBefore.map((task) => task.id)).toEqual([high.task.id, future.task.id, late.task.id]);
    expect(await store.listOpen(WS2)).toEqual([]);

    expect(await store.expireOverdue(WS, NOW)).toBe(1);
    const expired = store.tasks.find((task) => task.id === late.task.id)!;
    expect(expired).toMatchObject({ status: 'EXPIRED', decidedAt: NOW, decisionNote: 'SLA_TIMEOUT' });
    expect((await store.listOpen(WS)).map((task) => task.id)).toEqual([high.task.id, future.task.id]);
    // 二次执行幂等：没有新的超期 OPEN。
    expect(await store.expireOverdue(WS, NOW)).toBe(0);
  });
});
