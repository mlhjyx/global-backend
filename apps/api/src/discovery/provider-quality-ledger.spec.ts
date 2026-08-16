import { describe, expect, it, vi } from 'vitest';
import { buildProviderQualityContributions, persistProviderQualityContributions } from './provider-quality-ledger';

const run = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  icpId: '00000000-0000-4000-8000-000000000003',
  status: 'PARTIAL',
  completedAt: new Date('2026-08-13T00:00:00.000Z'),
} as const;

const stats = {
  perProvider: {
    wikidata: { attemptedCount: 2, successCount: 2, zeroResultCount: 1, failureCount: 0, rawCount: 4, quarantinedCount: 1, rejectedCount: 0, duplicateCount: 2 },
    gleif: { attemptedCount: 1, successCount: 0, zeroResultCount: 0, failureCount: 1, rawCount: 0, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0 },
  },
  identityQuality: {
    wikidata: { acceptedRows: 4, domainRows: 3, authorityIdentifierRows: 4, boundRows: 3, conflictRows: 1 },
  },
};

describe('provider quality run contributions', () => {
  it('uses only perProvider facts and includes zero-result and fully failed providers', () => {
    expect(buildProviderQualityContributions({ ...run, stats })).toEqual([
      expect.objectContaining({
        providerKey: 'gleif', attemptedCount: 1, successCount: 0, zeroResultCount: 0,
        failureCount: 1, failedRunCount: 1, processedCount: 0, rawCount: 0,
        duplicateCount: 0, acceptedCount: null,
      }),
      expect.objectContaining({
        providerKey: 'wikidata', attemptedCount: 2, successCount: 2, zeroResultCount: 1,
        failureCount: 0, failedRunCount: 0, processedCount: 7, rawCount: 4,
        duplicateCount: 2, acceptedCount: 4,
      }),
    ]);
  });

  it('does not fall back to ambiguous perSource or identity-only provider rows', () => {
    expect(buildProviderQualityContributions({
      ...run,
      stats: {
        perSource: { public: { provider: 'wikidata', rawCount: 9, failedProviderCount: 2 } },
        identityQuality: { wikidata: { acceptedRows: 9 } },
      },
    })).toEqual([]);
  });

  it('fails closed for malformed counters and impossible attempt accounting', () => {
    for (const perProvider of [
      { p: { attemptedCount: 0, successCount: 0, zeroResultCount: 0, failureCount: 0, rawCount: 0, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0 } },
      { p: { attemptedCount: 1, successCount: 1, zeroResultCount: 2, failureCount: 0, rawCount: 0, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0 } },
      { p: { attemptedCount: 1, successCount: 1, zeroResultCount: 0, failureCount: 1, rawCount: 0, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0 } },
    ]) {
      expect(() => buildProviderQualityContributions({ ...run, stats: { perProvider } })).toThrow(/PROVIDER_QUALITY_FACTS_INVALID/u);
    }
  });

  it('rejects provider keys containing separators or ASCII control characters', () => {
    const facts = {
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 0,
      failureCount: 0,
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
    };
    for (const providerKey of ['joined+provider', `nul\u0000provider`, `unit\u001fseparator`]) {
      expect(() => buildProviderQualityContributions({
        ...run,
        stats: { perProvider: { [providerKey]: facts } },
      })).toThrow('PROVIDER_QUALITY_FACTS_INVALID: providerKey');
    }
  });

  it('backfills missing rows, accepts exact retry, and rejects content drift', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const findMany = vi.fn(async () => stored);
    const createMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      const missing = data.filter((row) => !stored.some((existing) => existing.providerKey === row.providerKey));
      stored.push(...missing);
      return { count: missing.length };
    });
    const tx = { providerQualityRunContribution: { findMany, createMany } };
    const input = { ...run, stats };

    await expect(persistProviderQualityContributions(tx as never, input)).resolves.toBe(2);
    await expect(persistProviderQualityContributions(tx as never, input)).resolves.toBe(0);
    await expect(persistProviderQualityContributions(tx as never, {
      ...input,
      stats: { ...stats, perProvider: { ...stats.perProvider, wikidata: { ...stats.perProvider.wikidata, rawCount: 5 } } },
    })).rejects.toThrow('PROVIDER_QUALITY_CONTRIBUTION_DRIFT');
  });
});
