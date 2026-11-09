import { describe, expect, it } from 'vitest';
import {
  FrameLoadError,
  diffEntities,
  planFrameLoad,
  type ExistingRegistryEntity,
} from './frame-loader';
import type { NormalizedRegistryEntity } from './frame-normalize';

function entity(overrides: Partial<NormalizedRegistryEntity> = {}): NormalizedRegistryEntity {
  const base: Omit<NormalizedRegistryEntity, 'contentHash'> = {
    scheme: 'gb_crn',
    regNumber: '12345678',
    country: 'GB',
    name: 'Muster Pumpen GmbH',
    nameNorm: 'muster pumpen',
    legalForm: 'ltd',
    status: 'ACTIVE',
    addressJson: { lines: ['12 Muster Street'] },
    city: 'Manchester',
    postalCode: 'M1 1AA',
    region: null,
    nace: null,
    naceVersion: null,
    employeeBand: null,
    vatId: null,
    lei: null,
    website: null,
    identifiers: null,
    attributes: null,
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    contentHash: overrides.contentHash ?? `hash-${merged.regNumber}-${merged.name}-${merged.status}`,
  };
}

function existing(
  overrides: Partial<ExistingRegistryEntity> = {},
): ExistingRegistryEntity {
  return {
    ...entity(),
    id: `id-${overrides.regNumber ?? '12345678'}`,
    missCount: 0,
    withdrawnAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-11-09T02:00:00Z');

describe('planFrameLoad', () => {
  it('adds new entities with ADDED change rows', () => {
    const plan = planFrameLoad({
      records: [entity(), entity({ regNumber: '87654321' })],
      existing: [],
      now: NOW,
    });
    expect(plan.adds).toHaveLength(2);
    expect(plan.changes.map((change) => change.changeType)).toEqual(['ADDED', 'ADDED']);
    expect(plan.stats).toMatchObject({ added: 2, updated: 0, unchanged: 0, missing: 0 });
  });

  it('touches unchanged entities without a change row', () => {
    const current = existing();
    const plan = planFrameLoad({ records: [entity()], existing: [current], now: NOW });
    expect(plan.touches).toEqual([current.id]);
    expect(plan.changes).toEqual([]);
    expect(plan.stats.unchanged).toBe(1);
  });

  it('updates changed entities and records field diffs (only changed fields)', () => {
    const current = existing();
    const plan = planFrameLoad({
      records: [entity({ name: 'Muster Pumpen AG', nameNorm: 'muster pumpen ag', status: 'DISSOLVED' })],
      existing: [current],
      now: NOW,
    });
    expect(plan.updates).toHaveLength(1);
    const change = plan.changes[0]!;
    expect(change.changeType).toBe('UPDATED');
    expect(change.fieldDiffs?.map((diff) => diff.field).sort()).toEqual(['name', 'nameNorm', 'status']);
    expect(change.fieldDiffs).toContainEqual({ field: 'status', before: 'ACTIVE', after: 'DISSOLVED' });
  });

  it('counts a single missing snapshot but does not withdraw yet', () => {
    const plan = planFrameLoad({ records: [], existing: [existing()], now: NOW });
    expect(plan.misses).toEqual([{ id: 'id-12345678', missCount: 1 }]);
    expect(plan.withdrawals).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.stats.missing).toBe(1);
  });

  it('withdraws after the second consecutive missing snapshot', () => {
    const plan = planFrameLoad({
      records: [],
      existing: [existing({ missCount: 1 })],
      now: NOW,
    });
    expect(plan.withdrawals).toEqual([{ id: 'id-12345678', missCount: 2 }]);
    expect(plan.changes).toEqual([
      {
        scheme: 'gb_crn',
        regNumber: '12345678',
        changeType: 'WITHDRAWN',
        fieldDiffs: null,
        contentHash: expect.stringMatching(/^hash-/u) as unknown as string,
      },
    ]);
  });

  it('keeps already-withdrawn entities missing without a new WITHDRAWN event', () => {
    const plan = planFrameLoad({
      records: [],
      existing: [existing({ missCount: 2, withdrawnAt: NOW })],
      now: NOW,
    });
    expect(plan.misses).toEqual([{ id: 'id-12345678', missCount: 3 }]);
    expect(plan.changes).toEqual([]);
  });

  it('marks a withdrawn entity that reappears as REAPPEARED', () => {
    const plan = planFrameLoad({
      records: [entity()],
      existing: [existing({ missCount: 2, withdrawnAt: NOW })],
      now: NOW,
    });
    expect(plan.reappeared).toEqual([{ id: 'id-12345678', entity: entity() }]);
    expect(plan.changes.map((change) => change.changeType)).toEqual(['REAPPEARED']);
  });

  it('fails the whole batch on duplicate business keys inside one snapshot', () => {
    try {
      planFrameLoad({ records: [entity(), entity()], existing: [], now: NOW });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FrameLoadError);
      expect((error as FrameLoadError).code).toBe('FRAME_DUPLICATE_REG_NUMBER');
    }
  });
});

describe('diffEntities', () => {
  it('caps diffs at 20 fields and ignores order-irrelevant nulls', () => {
    const before = entity();
    const after = entity({ city: 'Leeds', region: 'Yorkshire' });
    expect(diffEntities(before, after)).toEqual([
      { field: 'city', before: 'Manchester', after: 'Leeds' },
      { field: 'region', before: null, after: 'Yorkshire' },
    ]);
  });
});
