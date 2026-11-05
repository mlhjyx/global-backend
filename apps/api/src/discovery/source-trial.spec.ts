import { describe, expect, it } from 'vitest';

import { trialProvidersFromCounts } from './source-trial';

describe('trial source providers (Q33② new-source trial window)', () => {
  it('marks providers used in fewer runs than the trial window', () => {
    const trial = trialProvidersFromCounts(
      [
        { provider_key: 'wikidata', runs: 0 },
        { provider_key: 'openstreetmap', runs: 9 },
        { provider_key: 'ted', runs: 10 },
        { provider_key: 'directory', runs: '12' },
      ],
      10,
    );

    expect([...trial].sort()).toEqual(['openstreetmap', 'wikidata']);
  });

  it('treats non-finite counts as out of trial instead of throwing', () => {
    const trial = trialProvidersFromCounts(
      [
        { provider_key: 'wikidata', runs: Number.NaN },
        { provider_key: 'ted', runs: null },
      ],
      10,
    );

    expect([...trial]).toEqual([]);
  });
});
