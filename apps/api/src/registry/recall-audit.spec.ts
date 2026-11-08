import { describe, expect, it } from 'vitest';
import {
  auditRecall,
  normalizeRegKey,
  renderRecallReportMarkdown,
  seededSample,
  stratumKey,
  wilsonInterval,
  type RecallFrameEntity,
  type RecallPoolRecord,
} from './recall-audit';

describe('wilsonInterval', () => {
  it('matches the published example: 241/384 ≈ 62.8% ±4.8pp', () => {
    const interval = wilsonInterval(241, 384)!;
    expect(interval.estimate).toBeCloseTo(0.6276, 3);
    expect((interval.high - interval.low) / 2).toBeCloseTo(0.0481, 3);
    expect(interval.low).toBeLessThan(interval.estimate);
    expect(interval.high).toBeGreaterThan(interval.estimate);
  });

  it('handles edge outcomes 0/n and n/n without leaving [0,1]', () => {
    const zero = wilsonInterval(0, 50)!;
    expect(zero.estimate).toBe(0);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0);
    expect(zero.high).toBeLessThan(0.1);
    const full = wilsonInterval(50, 50)!;
    expect(full.estimate).toBe(1);
    expect(full.high).toBe(1);
    expect(full.low).toBeGreaterThan(0.9);
  });

  it('returns null for n=0 and clamps impossible successes', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(10, 5)!.estimate).toBe(1);
  });
});

describe('seededSample', () => {
  const items = Array.from({ length: 50 }, (_, i) => `e${String(i).padStart(2, '0')}`);

  it('is deterministic for the same seed and stratum salt', () => {
    const first = seededSample(items, 10, '2026-12', 'GB:C28:10-49');
    const second = seededSample(items, 10, '2026-12', 'GB:C28:10-49');
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(10);
    expect(seededSample(items, 10, '2026-12', 'GB:C28:50-249')).not.toEqual(first);
    expect(seededSample(items, 10, '2027-01', 'GB:C28:10-49')).not.toEqual(first);
  });

  it('returns a census copy when the sample covers everything', () => {
    expect(seededSample(items.slice(0, 5), 10, 's')).toEqual(items.slice(0, 5));
  });
});

describe('stratumKey / normalizeRegKey', () => {
  it('uses country:nace2:employeeBand with NA defaults', () => {
    expect(stratumKey({ scheme: 'gb_crn', regNumber: '1', country: 'GB', nace: '28.13', employeeBand: '10-49' })).toBe(
      'GB:28:10-49',
    );
    expect(stratumKey({ scheme: 'gb_crn', regNumber: '1', country: 'GB' })).toBe('GB:NA:NA');
  });

  it('normalizes the matching key like frame-normalize', () => {
    expect(normalizeRegKey(' GB_CRN ', ' 12345678 ')).toBe(normalizeRegKey('gb_crn', '12345678'));
  });
});

describe('auditRecall', () => {
  const frame: RecallFrameEntity[] = [
    { scheme: 'gb_crn', regNumber: 'A1', country: 'GB', nace: '28.13', employeeBand: '10-49' },
    { scheme: 'gb_crn', regNumber: 'A2', country: 'GB', nace: '28.13', employeeBand: '10-49' },
    { scheme: 'gb_crn', regNumber: 'A3', country: 'GB', nace: '28.13', employeeBand: '10-49' },
    { scheme: 'gb_crn', regNumber: 'B1', country: 'GB', nace: '28.13', employeeBand: '50-249' },
    { scheme: 'gb_crn', regNumber: 'B2', country: 'GB', nace: '28.13', employeeBand: '50-249' },
    { scheme: 'gb_crn', regNumber: 'B3', country: 'GB', nace: '28.13', employeeBand: '50-249' },
  ];
  const pool: RecallPoolRecord[] = [
    { registryScheme: 'gb_crn', registryNumber: 'A1', domain: 'a1.example' },
    { registryScheme: 'GB_CRN', registryNumber: 'a2', domain: null },
    { registryScheme: 'gb_crn', registryNumber: 'B1', domain: 'b1.example', contacts: 2 },
    { name: 'unrelated company', domain: 'x.example' },
  ];

  it('computes census recall per stratum and in total', () => {
    const result = auditRecall({ frame, pool });
    expect(result.sample).toEqual({ size: null, seed: null, sampled: false });
    expect(result.strata.map((stratum) => stratum.stratumKey)).toEqual(['GB:28:10-49', 'GB:28:50-249']);
    const [small, large] = result.strata;
    expect(small).toMatchObject({ N: 3, n: 3, found: 2, domainResolved: 1, contactFound: 0, census: true });
    expect(small!.recall!.estimate).toBeCloseTo(2 / 3, 6);
    expect(large).toMatchObject({ N: 3, n: 3, found: 1, domainResolved: 1, contactFound: 1 });
    expect(result.totals).toMatchObject({ N: 6, n: 6, found: 3, domainResolved: 2, contactFound: 1 });
    expect(result.totals.recall!.estimate).toBeCloseTo(0.5, 6);
    expect(result.missed).toBe(3);
  });

  it('samples per stratum deterministically with a recorded seed', () => {
    const first = auditRecall({ frame, pool, sampleSize: 2, seed: '2026-12' });
    const second = auditRecall({ frame, pool, sampleSize: 2, seed: '2026-12' });
    expect(second.strata).toEqual(first.strata);
    expect(first.strata.map((stratum) => stratum.n)).toEqual([2, 2]);
    expect(first.strata.map((stratum) => stratum.census)).toEqual([false, false]);
    expect(first.sample).toEqual({ size: 2, seed: '2026-12', sampled: true });
  });

  it('rejects an invalid sample size', () => {
    expect(() => auditRecall({ frame, pool, sampleSize: 0 })).toThrow(/sampleSize/u);
  });

  it('renders the fixed-format markdown report with the declared methodology', () => {
    const result = auditRecall({ frame, pool, sampleSize: 2, seed: '2026-12' });
    const markdown = renderRecallReportMarkdown(result, {
      period: '2026-12',
      frameKey: 'gb_companies_house',
      frameSnapshotId: 'snap-1',
      poolSource: 'run-123',
      generatedAt: '2026-12-03T02:00:00Z',
    });
    expect(markdown).toContain('# 召回审计报告 · 2026-12');
    expect(markdown).toContain('seed=`2026-12`');
    expect(markdown).toContain('| GB:28:10-49 | 3 | 2 |');
    expect(markdown).toContain('Wilson');
    expect(markdown).toContain('反自证');
  });
});
