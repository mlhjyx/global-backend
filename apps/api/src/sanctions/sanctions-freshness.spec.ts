import { describe, expect, it } from 'vitest';
import {
  evaluateSanctionsFreshness,
  sanctionsFreshnessThresholds,
  SANCTIONS_LIST_BLOCK_AGE_DAYS_DEFAULT,
  SANCTIONS_LIST_MAX_AGE_DAYS_DEFAULT,
  type SanctionsSourceFreshnessRow,
} from './sanctions-freshness';

/**
 * ch08 §3.1.12 制裁陈旧门：三档判定（fresh / stale / blocked）与阈值配置。
 * 验收：伪造 3/8/15 天旧名单断言三档；任一源 FAILED → 至少降级；从未刷新 → 熔断。
 */

const NOW = new Date('2026-11-09T12:00:00.000Z');
const THRESHOLDS = { maxAgeDays: 7, blockAgeDays: 14 };

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function source(
  overrides: Partial<SanctionsSourceFreshnessRow> = {},
): SanctionsSourceFreshnessRow {
  return {
    key: 'ofac_sdn',
    lastRefreshedAt: daysAgo(3),
    lastFetchStatus: 'DONE',
    ...overrides,
  };
}

describe('evaluateSanctionsFreshness', () => {
  it('is inactive when no source is enabled (screening gate itself is off)', () => {
    const result = evaluateSanctionsFreshness([], NOW, THRESHOLDS);
    expect(result).toMatchObject({ active: false, stale: false, blocked: false, reason: 'inactive' });
  });

  it('is fresh at 3 days', () => {
    const result = evaluateSanctionsFreshness([source(), source({ key: 'ofac_consolidated' })], NOW, THRESHOLDS);
    expect(result).toMatchObject({ active: true, ageDays: 3, stale: false, blocked: false, reason: 'fresh' });
  });

  it('is stale at 8 days — screening may run but must not auto-clear', () => {
    const result = evaluateSanctionsFreshness([source({ lastRefreshedAt: daysAgo(8) })], NOW, THRESHOLDS);
    expect(result).toMatchObject({ active: true, ageDays: 8, stale: true, blocked: false, reason: 'stale' });
  });

  it('is blocked at 15 days — qualify holds the batch', () => {
    const result = evaluateSanctionsFreshness([source({ lastRefreshedAt: daysAgo(15) })], NOW, THRESHOLDS);
    expect(result).toMatchObject({ active: true, ageDays: 15, stale: true, blocked: true, reason: 'blocked' });
  });

  it('uses the newest successful refresh (max last_refreshed_at) for the age', () => {
    const result = evaluateSanctionsFreshness(
      [source({ key: 'ofac_sdn', lastRefreshedAt: daysAgo(30) }), source({ key: 'eu_fsf', lastRefreshedAt: daysAgo(2) })],
      NOW,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ ageDays: 2, stale: false, blocked: false });
  });

  it('degrades when any enabled source reports FAILED, even if the age is fresh', () => {
    const result = evaluateSanctionsFreshness(
      [source(), source({ key: 'eu_fsf', lastFetchStatus: 'FAILED' })],
      NOW,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ ageDays: 3, stale: true, blocked: false, reason: 'stale' });
  });

  it('blocks when an enabled source has never been refreshed (no freshness evidence)', () => {
    const result = evaluateSanctionsFreshness(
      [source({ lastRefreshedAt: null, lastFetchStatus: null })],
      NOW,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ ageDays: null, stale: true, blocked: true, reason: 'blocked' });
  });

  it('serializes sources for the alert payload', () => {
    const result = evaluateSanctionsFreshness([source()], NOW, THRESHOLDS);
    expect(result.sources).toEqual([
      { key: 'ofac_sdn', lastRefreshedAt: '2026-11-06T12:00:00.000Z', lastFetchStatus: 'DONE' },
    ]);
  });
});

describe('sanctionsFreshnessThresholds', () => {
  it('defaults to 7 / 14 days', () => {
    expect(sanctionsFreshnessThresholds({})).toEqual({
      maxAgeDays: SANCTIONS_LIST_MAX_AGE_DAYS_DEFAULT,
      blockAgeDays: SANCTIONS_LIST_BLOCK_AGE_DAYS_DEFAULT,
    });
  });

  it('reads SANCTIONS_LIST_MAX_AGE_DAYS / SANCTIONS_LIST_BLOCK_AGE_DAYS', () => {
    expect(
      sanctionsFreshnessThresholds({
        SANCTIONS_LIST_MAX_AGE_DAYS: '5',
        SANCTIONS_LIST_BLOCK_AGE_DAYS: '10',
      }),
    ).toEqual({ maxAgeDays: 5, blockAgeDays: 10 });
  });

  it('ignores invalid values and keeps block >= max', () => {
    expect(
      sanctionsFreshnessThresholds({
        SANCTIONS_LIST_MAX_AGE_DAYS: 'abc',
        SANCTIONS_LIST_BLOCK_AGE_DAYS: '-2',
      }),
    ).toEqual({ maxAgeDays: 7, blockAgeDays: 14 });
    expect(
      sanctionsFreshnessThresholds({
        SANCTIONS_LIST_MAX_AGE_DAYS: '10',
        SANCTIONS_LIST_BLOCK_AGE_DAYS: '5',
      }),
    ).toEqual({ maxAgeDays: 10, blockAgeDays: 10 });
  });
});
