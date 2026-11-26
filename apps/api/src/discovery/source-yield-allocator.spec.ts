import { describe, expect, it } from 'vitest';
import {
  allocateSourceQueryQuotas,
  computeSourceYieldMetrics,
  formatSourceYieldAllocationNote,
  type SourceYieldInput,
} from './source-yield-allocator';

describe('source-yield-allocator (final Lead yield alignment & dynamic quota)', () => {
  it('computes finalQualifiedLeads / recalledCandidates and costPerQualifiedLeadUsd cleanly', () => {
    const metrics = computeSourceYieldMetrics([
      { providerKey: 'public_web', recalledCandidates: 40, finalQualifiedLeads: 10, costMicrousd: 5_000_000 },
      { providerKey: 'wikidata', recalledCandidates: 50, finalQualifiedLeads: 0, costMicrousd: 0 },
      { providerKey: 'trade_fair', recalledCandidates: 0, finalQualifiedLeads: 0, costMicrousd: 0 },
    ]);

    expect(metrics).toEqual([
      expect.objectContaining({
        providerKey: 'public_web',
        qualifiedRate: 0.25,
        costPerQualifiedLeadUsd: 0.5,
      }),
      expect.objectContaining({
        providerKey: 'wikidata',
        qualifiedRate: 0,
        costPerQualifiedLeadUsd: null,
      }),
      expect.objectContaining({
        providerKey: 'trade_fair',
        qualifiedRate: 0,
        costPerQualifiedLeadUsd: null,
      }),
    ]);
  });

  it('boosts high-yield sources and aggressively down-weights zero-yield noise sources while keeping exploration floor', () => {
    const sources: SourceYieldInput[] = [
      { providerKey: 'public_web', recalledCandidates: 40, finalQualifiedLeads: 16 }, // 40% qualified rate
      { providerKey: 'channel_catalog', recalledCandidates: 25, finalQualifiedLeads: 5 }, // 20% qualified rate
      { providerKey: 'wikidata', recalledCandidates: 80, finalQualifiedLeads: 0 }, // 0% noise source
    ];

    const plan = allocateSourceQueryQuotas({
      sources,
      totalQuota: 20,
      minExplorationShare: 0.1,
    });

    const byKey = new Map(plan.allocations.map((a) => [a.providerKey, a]));
    const totalAllocated = plan.allocations.reduce((sum, a) => sum + a.allocatedQuota, 0);
    expect(totalAllocated).toBe(20);

    // High-yield public_web gets the largest share, channel_catalog second, 0-yield wikidata gets minimal floor only
    expect(byKey.get('public_web')!.allocatedQuota).toBeGreaterThan(byKey.get('channel_catalog')!.allocatedQuota);
    expect(byKey.get('channel_catalog')!.allocatedQuota).toBeGreaterThan(byKey.get('wikidata')!.allocatedQuota);
    expect(byKey.get('wikidata')!.allocatedQuota).toBeGreaterThanOrEqual(1);
    expect(byKey.get('wikidata')!.allocatedQuota).toBeLessThanOrEqual(2);
    expect(byKey.get('wikidata')!.tier).toBe('low_yield_noise');
    expect(byKey.get('public_web')!.tier).toBe('high_yield');
  });

  it('protects cold-start untested channels from starvation with at least exploration floor', () => {
    const sources: SourceYieldInput[] = [
      { providerKey: 'public_web', recalledCandidates: 50, finalQualifiedLeads: 20 },
      { providerKey: 'ted', recalledCandidates: 0, finalQualifiedLeads: 0 },
      { providerKey: 'directory', recalledCandidates: 2, finalQualifiedLeads: 0 },
    ];

    const plan = allocateSourceQueryQuotas({
      sources,
      totalQuota: 15,
      minExplorationShare: 0.15,
    });

    const byKey = new Map(plan.allocations.map((a) => [a.providerKey, a]));
    expect(plan.allocations.reduce((s, a) => s + a.allocatedQuota, 0)).toBe(15);
    expect(byKey.get('ted')!.allocatedQuota).toBeGreaterThanOrEqual(1);
    expect(byKey.get('ted')!.tier).toBe('cold_start');
    expect(byKey.get('directory')!.allocatedQuota).toBeGreaterThanOrEqual(1);
    expect(byKey.get('directory')!.tier).toBe('cold_start');
  });

  it('handles empty sources or zero quota gracefully and formats a readable planner note', () => {
    expect(allocateSourceQueryQuotas({ sources: [], totalQuota: 10 }).allocations).toEqual([]);
    const plan = allocateSourceQueryQuotas({
      sources: [
        { providerKey: 'public_web', recalledCandidates: 20, finalQualifiedLeads: 6 },
        { providerKey: 'wikidata', recalledCandidates: 30, finalQualifiedLeads: 0 },
      ],
      totalQuota: 10,
    });
    const note = formatSourceYieldAllocationNote(plan);
    expect(note).toContain('public_web');
    expect(note).toContain('wikidata');
    expect(note).toContain('30.0%');
    expect(note).toContain('0.0%');
  });
});
