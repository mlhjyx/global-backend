import { describe, expect, it } from 'vitest';
import {
  ProviderHealthTracker,
  SearchRouter,
  type RoutedSearchProvider,
} from './search-router';

class FakeProvider implements RoutedSearchProvider {
  calls = 0;

  constructor(
    readonly key: string,
    private readonly behavior: 'ok' | 'fail' | 'hang',
    private readonly hits: Array<{ url: string; rank: number }> = [],
    readonly costPerQueryUsd = 0,
  ) {}

  async search() {
    this.calls += 1;
    if (this.behavior === 'fail') throw new Error(`${this.key} down`);
    if (this.behavior === 'hang') return new Promise<never>(() => {});
    return this.hits;
  }
}

const NOW = () => '2026-11-09T10:00:00Z';

describe('SearchRouter.searchAll (domain-resolution forced parallel)', () => {
  it('isolates failures, merges hits by url and records the ledger for ok providers only', async () => {
    const brave = new FakeProvider(
      'brave_fixture',
      'ok',
      [
        { url: 'https://muster-pumpen.de', rank: 1 },
        { url: 'https://example.org/x', rank: 2 },
      ],
      0.003,
    );
    const serper = new FakeProvider('serper_fixture', 'ok', [{ url: 'https://muster-pumpen.de', rank: 1 }], 0.001);
    const mojeek = new FakeProvider('mojeek_fixture', 'fail');
    const router = new SearchRouter({ providers: [brave, serper, mojeek], now: NOW });

    const result = await router.searchAll({ q: 'Muster Pumpen GmbH' });
    expect(result.outcomes.map((outcome) => [outcome.providerKey, outcome.status])).toEqual([
      ['brave_fixture', 'ok'],
      ['serper_fixture', 'ok'],
      ['mojeek_fixture', 'failed'],
    ]);
    expect(result.degradedFrom).toEqual(['mojeek_fixture']);
    // 同 URL 去重，保留首次出现的 provider。
    expect(result.merged).toEqual([
      { url: 'https://muster-pumpen.de', rank: 1, providerKey: 'brave_fixture' },
      { url: 'https://example.org/x', rank: 2, providerKey: 'brave_fixture' },
    ]);
    // 亚分成本向上取整记 1 分（宁可高估不可漏记）。
    expect(result.ledger).toEqual([
      { providerKey: 'brave_fixture', quantity: 1, costCents: 1, purpose: 'DISCOVERY_DOMAIN_RESOLVE' },
      { providerKey: 'serper_fixture', quantity: 1, costCents: 1, purpose: 'DISCOVERY_DOMAIN_RESOLVE' },
    ]);
  });

  it('enforces the latency budget as a per-provider failure', async () => {
    const hang = new FakeProvider('hang_fixture', 'hang');
    const ok = new FakeProvider('ok_fixture', 'ok', [{ url: 'https://muster-pumpen.de', rank: 1 }]);
    const router = new SearchRouter({
      providers: [hang, ok],
      now: NOW,
      latencyBudgetMs: 20,
    });
    const result = await router.searchAll({ q: 'pump' });
    expect(result.outcomes.find((outcome) => outcome.providerKey === 'hang_fixture')).toMatchObject({
      status: 'failed',
      error: 'LATENCY_BUDGET_EXCEEDED',
    });
    expect(result.degradedFrom).toEqual(['hang_fixture']);
    expect(result.merged.map((hit) => hit.url)).toEqual(['https://muster-pumpen.de']);
  });
});

describe('SearchRouter.searchPreferred (cost-ordered fallback)', () => {
  it('returns the first successful provider and reports the degradation chain', async () => {
    const searxng = new FakeProvider('searxng_fixture', 'fail');
    const mojeek = new FakeProvider('mojeek_fixture', 'ok', [{ url: 'https://muster-pumpen.de', rank: 1 }], 0.001);
    const serper = new FakeProvider('serper_fixture', 'ok', [{ url: 'https://x.example', rank: 1 }], 0.002);
    const router = new SearchRouter({ providers: [searxng, mojeek, serper], now: NOW });

    const result = await router.searchPreferred({ q: 'pump' });
    expect(result.providerKey).toBe('mojeek_fixture');
    expect(result.degradedFrom).toEqual(['searxng_fixture']);
    expect(result.hits).toHaveLength(1);
    expect(result.ledger).toEqual([
      { providerKey: 'mojeek_fixture', quantity: 1, costCents: 1, purpose: 'DISCOVERY_DOMAIN_RESOLVE' },
    ]);
    expect(serper.calls).toBe(0);
  });

  it('reports allUnavailable when every provider fails or is disabled', async () => {
    const health = new ProviderHealthTracker();
    for (let index = 0; index < 30; index++) {
      health.record('disabled_fixture', false, '2026-11-08T00:00:00Z');
    }
    const disabled = new FakeProvider('disabled_fixture', 'ok', [{ url: 'https://x', rank: 1 }]);
    const failing = new FakeProvider('failing_fixture', 'fail');
    const router = new SearchRouter({ providers: [disabled, failing], health, now: NOW });

    const result = await router.searchPreferred({ q: 'pump' });
    expect(result).toMatchObject({ providerKey: null, allUnavailable: true });
    expect(result.degradedFrom).toEqual(['disabled_fixture', 'failing_fixture']);
    expect(disabled.calls).toBe(0);
  });
});

describe('ProviderHealthTracker thresholds (§3.14.3)', () => {
  it('warns at 20 consecutive failures and disables at 30 failures within 7 days', () => {
    const tracker = new ProviderHealthTracker();
    for (let index = 0; index < 25; index++) {
      tracker.record('p', false, '2026-11-08T00:00:00Z');
    }
    const warned = tracker.snapshot('p', NOW());
    expect(warned).toMatchObject({ consecutiveFailures: 25, failuresLast7Days: 25, state: 'warn' });

    for (let index = 0; index < 5; index++) {
      tracker.record('p', false, '2026-11-08T00:00:00Z');
    }
    expect(tracker.snapshot('p', NOW()).state).toBe('disabled');
  });

  it('warns when the last success is older than 4 days and failures followed', () => {
    const tracker = new ProviderHealthTracker();
    tracker.record('p', true, '2026-11-01T00:00:00Z');
    tracker.record('p', false, '2026-11-09T00:00:00Z');
    expect(tracker.snapshot('p', NOW())).toMatchObject({ state: 'warn', lastSuccessAt: '2026-11-01T00:00:00.000Z' });
  });

  it('stays healthy right after a success and rejects invalid construction', () => {
    const tracker = new ProviderHealthTracker();
    tracker.record('p', false, '2026-11-09T00:00:00Z');
    tracker.record('p', true, '2026-11-09T01:00:00Z');
    expect(tracker.snapshot('p', NOW()).state).toBe('healthy');
    expect(() => new SearchRouter({ providers: [] })).toThrow();
    expect(
      () =>
        new SearchRouter({
          providers: [new FakeProvider('dup', 'ok'), new FakeProvider('dup', 'ok')],
        }),
    ).toThrow();
  });
});
