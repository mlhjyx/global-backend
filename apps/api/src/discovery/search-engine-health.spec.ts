import { describe, expect, it } from 'vitest';
import { SearchEngineHealthTracker } from './search-engine-health';

describe('SearchEngineHealthTracker (Batch 1.5-C optional L0 engine cooldown)', () => {
  it('opens cooldown after threshold consecutive failures and half-opens after cooldown expires', () => {
    let clock = 1_000;
    const tracker = new SearchEngineHealthTracker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => clock,
    });

    expect(tracker.isAvailable('exa')).toBe(true);
    expect(tracker.recordFailure('exa').opened).toBe(false);
    expect(tracker.isAvailable('exa')).toBe(true);
    expect(tracker.recordFailure('exa').opened).toBe(false);
    expect(tracker.isAvailable('exa')).toBe(true);

    const third = tracker.recordFailure('exa');
    expect(third.opened).toBe(true);
    expect(tracker.isAvailable('exa')).toBe(false);
    // Other engines remain unaffected.
    expect(tracker.isAvailable('serper')).toBe(true);

    clock += 59_999;
    expect(tracker.isAvailable('exa')).toBe(false);

    clock += 1;
    expect(tracker.isAvailable('exa')).toBe(true);

    tracker.recordSuccess('exa');
    expect(tracker.recordFailure('exa').opened).toBe(false);
    expect(tracker.isAvailable('exa')).toBe(true);
  });
});
