import { describe, expect, it } from 'vitest';
import {
  suggestAdaptiveQueryPlan,
  type AdaptiveQueryPlanSuggestion,
} from './adaptive-query-plan';

const PLAN = {
  status: 'EXECUTED' as const,
  queries: [
    {
      source_class: 'public_intelligence',
      filters: { country: 'DE', industry: 'industrial pumps' },
      keywords: ['industrial pump', 'distributor'],
      rationale: 'Find German industrial pump distributors',
      priority: 1,
    },
    {
      source_class: 'company_registry',
      filters: { country: 'DE' },
      keywords: ['industrial pump'],
      rationale: 'Verify registered companies',
      priority: 2,
    },
  ],
};

function expectDraft(result: AdaptiveQueryPlanSuggestion) {
  expect(result.outcome).toBe('DRAFT');
  if (result.outcome !== 'DRAFT') throw new Error(`expected DRAFT, got ${result.outcome}`);
  return result;
}

describe('suggestAdaptiveQueryPlan', () => {
  it('creates a deterministic DRAFT that broadens a low-yield query without executing it', () => {
    const input = {
      currentRound: 1,
      maxRounds: 3,
      originalPlan: PLAN,
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 1,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'wikidata',
          },
          company_registry: {
            rawCount: 8,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'gleif',
          },
        },
        identityQuality: {
          wikidata: { acceptedRows: 1, boundRows: 1, uniqueCompanies: 1, conflictRows: 0 },
          gleif: { acceptedRows: 8, boundRows: 8, uniqueCompanies: 8, conflictRows: 0 },
        },
      },
    };

    const first = expectDraft(suggestAdaptiveQueryPlan(input));
    const replay = suggestAdaptiveQueryPlan(structuredClone(input));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'DRAFT',
      nextRound: 2,
      status: 'DRAFT',
      requiresHumanConfirmation: true,
      executable: false,
    });
    expect(first.queries.find((query) => query.source_class === 'public_intelligence')).toMatchObject({
      filters: { country: 'DE' },
      keywords: ['industrial pump', 'distributor'],
    });
    expect(first.reasons).toContainEqual(
      expect.objectContaining({ sourceClass: 'public_intelligence', code: 'LOW_YIELD_BROADENED' }),
    );
    expect(PLAN.queries[0]?.filters).toEqual({ country: 'DE', industry: 'industrial pumps' });
  });

  it('drops a duplicate-saturated source and keeps a productive source', () => {
    const result = expectDraft(suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 3,
      originalPlan: PLAN,
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 20,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 18,
            failedProviderCount: 0,
            provider: 'wikidata',
          },
          company_registry: {
            rawCount: 10,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'gleif',
          },
        },
        identityQuality: {},
      },
    }));

    expect(result.queries.map((query) => query.source_class)).toEqual(['company_registry']);
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ sourceClass: 'public_intelligence', code: 'DUPLICATE_SATURATION' }),
    );
  });

  it('isolates one failed source instead of retrying it or discarding healthy sources', () => {
    const result = expectDraft(suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 3,
      originalPlan: PLAN,
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 1,
            provider: 'wikidata',
          },
          company_registry: {
            rawCount: 6,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'gleif',
          },
        },
        identityQuality: {},
      },
    }));

    expect(result.queries.map((query) => query.source_class)).toEqual(['company_registry']);
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ sourceClass: 'public_intelligence', code: 'SOURCE_FAILURE_PAUSED' }),
    );
  });

  it('deprioritizes low identity quality while keeping the suggestion behind the human gate', () => {
    const result = expectDraft(suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 3,
      originalPlan: PLAN,
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 10,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'wikidata',
          },
          company_registry: {
            rawCount: 10,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'gleif',
          },
        },
        identityQuality: {
          wikidata: { acceptedRows: 10, boundRows: 1, uniqueCompanies: 1, conflictRows: 3 },
          gleif: { acceptedRows: 10, boundRows: 10, uniqueCompanies: 10, conflictRows: 0 },
        },
      },
    }));

    expect(result).toMatchObject({ outcome: 'DRAFT', status: 'DRAFT', executable: false });
    expect(result.queries.find((query) => query.source_class === 'public_intelligence')?.priority).toBeGreaterThan(
      result.queries.find((query) => query.source_class === 'company_registry')?.priority ?? 0,
    );
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ sourceClass: 'public_intelligence', code: 'LOW_IDENTITY_QUALITY' }),
    );
  });

  it('converges at max rounds and emits no draft queries', () => {
    const result = suggestAdaptiveQueryPlan({
      currentRound: 3,
      maxRounds: 3,
      originalPlan: PLAN,
      stats: { perSource: {}, identityQuality: {} },
    });

    expect(result).toEqual({
      outcome: 'CONVERGED',
      reason: 'MAX_ROUNDS_REACHED',
      currentRound: 3,
      maxRounds: 3,
      draft: null,
    });
  });

  it('converges when every source is unsafe to repeat', () => {
    const single = { status: 'EXECUTED' as const, queries: [PLAN.queries[0]!] };
    const result = suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 3,
      originalPlan: single,
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 10,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 9,
            failedProviderCount: 0,
            provider: 'wikidata',
          },
        },
        identityQuality: {},
      },
    });

    expect(result).toMatchObject({ outcome: 'CONVERGED', reason: 'NO_SAFE_ADAPTATION', draft: null });
  });

  it('uses an existing yieldCount and falls back to keyword broadening', () => {
    const result = expectDraft(suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 2,
      originalPlan: {
        status: 'EXECUTED',
        queries: [{
          source_class: 'web',
          filters: { country: 'US' },
          keywords: ['pump', 'distributor'],
          rationale: 'narrow web search',
          priority: 1,
        }],
      },
      stats: {
        perSource: {
          web: {
            rawCount: 20,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: null,
            yieldCount: 0,
          },
        },
        identityQuality: {},
      },
    }));

    expect(result.queries[0]?.keywords).toEqual(['pump']);
    expect(result.queries[0]?.filters).toEqual({ country: 'US' });
  });

  it('never drops an explicit provider hint while broadening a low-yield procurement query', () => {
    const result = expectDraft(suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 2,
      originalPlan: {
        status: 'EXECUTED',
        queries: [{
          source_class: 'public_intelligence',
          filters: {
            source_hint: 'world_bank_procurement',
            country: 'Kenya',
            industry: 'industrial pumps',
          },
          keywords: ['industrial pump'],
          priority: 1,
        }],
      },
      stats: {
        perSource: {
          public_intelligence: {
            rawCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            failedProviderCount: 0,
            provider: 'world_bank_procurement',
          },
        },
        identityQuality: {},
      },
    }));

    expect(result.queries[0]?.filters).toEqual({
      source_hint: 'world_bank_procurement',
      country: 'Kenya',
    });
  });

  it('converges when healthy statistics require no adaptation', () => {
    const result = suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 2,
      originalPlan: { status: 'EXECUTED', queries: [PLAN.queries[1]!] },
      stats: {
        perSource: {
          company_registry: {
            rawCount: 10,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 1,
            failedProviderCount: 0,
            provider: 'gleif',
          },
        },
        identityQuality: {
          gleif: { acceptedRows: 10, boundRows: 10, uniqueCompanies: 9, conflictRows: 0 },
        },
      },
    });

    expect(result).toMatchObject({ outcome: 'CONVERGED', reason: 'NO_ADAPTATION_NEEDED', draft: null });
  });

  it('fails closed for invalid round bounds', () => {
    expect(() => suggestAdaptiveQueryPlan({
      currentRound: 0,
      maxRounds: 2,
      originalPlan: PLAN,
      stats: { perSource: {}, identityQuality: {} },
    })).toThrow(/currentRound/u);
    expect(() => suggestAdaptiveQueryPlan({
      currentRound: 1,
      maxRounds: 0,
      originalPlan: PLAN,
      stats: { perSource: {}, identityQuality: {} },
    })).toThrow(/maxRounds/u);
  });
});
