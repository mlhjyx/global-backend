import { describe, expect, it } from 'vitest';

import {
  isSiteReleaseGcEligible,
  siteReleaseGcEnabled,
} from './site-release-gc';

const now = new Date('2026-07-20T00:00:00.000Z');

describe('R1 Release retention and GC policy', () => {
  it('is disabled unless the operator explicitly opts in', () => {
    expect(siteReleaseGcEnabled({})).toBe(false);
    expect(siteReleaseGcEnabled({ SITE_RELEASE_GC_ENABLED: 'false' })).toBe(
      false,
    );
    expect(siteReleaseGcEnabled({ SITE_RELEASE_GC_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('never collects the active Release', () => {
    expect(
      isSiteReleaseGcEligible({
        status: 'ready',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        readyAt: new Date('2026-01-01T00:00:00.000Z'),
        active: true,
        newerReadyCount: 20,
        now,
      }),
    ).toBe(false);
  });

  it('retains READY Releases for 30 days and always retains the newest two rollback points', () => {
    const base = {
      status: 'ready',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      readyAt: new Date('2026-01-01T00:00:00.000Z'),
      active: false,
      now,
    };
    expect(isSiteReleaseGcEligible({ ...base, newerReadyCount: 1 })).toBe(false);
    expect(isSiteReleaseGcEligible({ ...base, newerReadyCount: 2 })).toBe(true);
    expect(
      isSiteReleaseGcEligible({
        ...base,
        readyAt: new Date('2026-07-01T00:00:00.000Z'),
        newerReadyCount: 5,
      }),
    ).toBe(false);
  });

  it('collects abandoned candidates and failed attempts only after 24 hours', () => {
    const base = {
      createdAt: new Date('2026-07-18T00:00:00.000Z'),
      readyAt: null,
      active: false,
      newerReadyCount: 0,
      now,
    };
    expect(isSiteReleaseGcEligible({ ...base, status: 'candidate' })).toBe(true);
    expect(isSiteReleaseGcEligible({ ...base, status: 'failed' })).toBe(true);
    expect(
      isSiteReleaseGcEligible({
        ...base,
        status: 'candidate',
        createdAt: new Date('2026-07-19T12:00:00.001Z'),
      }),
    ).toBe(false);
  });
});
