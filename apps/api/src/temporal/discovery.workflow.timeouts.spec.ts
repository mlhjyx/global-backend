import { describe, expect, it } from 'vitest';
import { discoveryActivityTimeouts as activityTimeouts } from './testing/discovery-activity-timeouts';

describe('discovery workflow activity timeouts', () => {
  it('gives query execution and the per-company fit pass the 15-minute model timeout', () => {
    const timeouts = activityTimeouts();
    expect(timeouts.get('executeQuery')).toEqual(['15 minutes']);
    expect(timeouts.get('qualifyFitForRun')).toEqual(['15 minutes']);
  });

  it('keeps the short bookkeeping activities on the 2-minute default', () => {
    const timeouts = activityTimeouts();
    for (const activity of ['resetRunBudget', 'loadPlanQueries', 'canonicalizeRun', 'enrichRun', 'finalizeRun']) {
      expect(timeouts.get(activity), activity).toEqual(['2 minutes']);
    }
  });
});
