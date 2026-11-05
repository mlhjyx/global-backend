import { describe, expect, it, vi } from 'vitest';

import { trialProvidersFromCounts, trialSourceProviders } from './source-trial';

describe('trial source providers (Q33② new-source trial window)', () => {
  it('marks providers used in fewer runs than the trial window', () => {
    const trial = trialProvidersFromCounts(
      [
        { provider_key: 'openstreetmap', runs: 9 },
        { provider_key: 'ted', runs: 10 },
        { provider_key: 'directory', runs: '12' },
      ],
      10,
    );

    expect([...trial].sort()).toEqual(['openstreetmap']);
  });

  it('treats enabled providers with no recorded runs as trial (brand-new sources)', () => {
    const trial = trialProvidersFromCounts(
      [{ provider_key: 'directory', runs: 12 }],
      10,
      ['directory', 'wikidata', 'public_web'],
    );

    // The SQL cannot emit a row for a provider without raw_source_record rows; absence
    // means 0 runs, which is below the trial window and must enter it.
    expect([...trial].sort()).toEqual(['public_web', 'wikidata']);
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

  it('reads counts through the workspace-scoped query and degrades to no trial sources on failure', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const queryRaw = vi.fn().mockResolvedValue([{ provider_key: 'directory', runs: 3 }]);
    await expect(
      trialSourceProviders({ $queryRaw: queryRaw } as never, workspaceId, ['directory', 'wikidata']),
    ).resolves.toEqual(new Set(['directory', 'wikidata']));
    expect(queryRaw).toHaveBeenCalledTimes(1);

    const failing = { $queryRaw: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(
      trialSourceProviders(failing as never, workspaceId, ['directory']),
    ).resolves.toEqual(new Set());
  });
});
