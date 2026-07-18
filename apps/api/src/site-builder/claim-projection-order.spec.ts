import { describe, expect, it, vi } from 'vitest';
import {
  claimEvidenceOriginKey,
  claimOriginIdentity,
} from './claim-evidence-bridge.service';
import { compareClaimProjectionOrder } from './claim-projection-order';

describe('compareClaimProjectionOrder', () => {
  it('uses deterministic code-unit order without host locale collation', () => {
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('locale collation must not participate in lock order');
      });

    const rows = [
      { sortKey: '能力', factIndex: 2 },
      { sortKey: 'z', factIndex: 1 },
      { sortKey: 'a', factIndex: 3 },
      { sortKey: 'a', factIndex: 0 },
    ].sort(compareClaimProjectionOrder);

    expect(rows).toEqual([
      { sortKey: 'a', factIndex: 0 },
      { sortKey: 'a', factIndex: 3 },
      { sortKey: 'z', factIndex: 1 },
      { sortKey: '能力', factIndex: 2 },
    ]);
    expect(localeCompare).not.toHaveBeenCalled();
  });

  it('derives the same canonical Claim origin/order key while rejecting non-canonical fact keys', () => {
    const scope = {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      companyProfileId: '22222222-2222-4222-8222-222222222222',
      claimType: ' param ',
      factKey: 'maximum_pressure',
      statement: ' 400\n bar ',
    };

    const spaced = claimOriginIdentity(scope);
    const canonical = claimOriginIdentity({
      ...scope,
      claimType: 'param',
      statement: '400 bar',
    });

    expect(spaced).toEqual(canonical);
    expect(spaced).toMatchObject({
      normalizedFactKey: 'maximum_pressure',
      normalizedType: 'param',
      normalizedStatement: '400 bar',
    });
    expect(spaced.claimOriginKey).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      claimOriginIdentity({ ...scope, factKey: ' maximum\tpressure ' }),
    ).toThrow('strict lower_snake_case');

    const rows = [
      { sortKey: claimOriginIdentity({ ...scope, factKey: 'z' }).claimOriginKey, factIndex: 1 },
      { sortKey: claimOriginIdentity({ ...scope, factKey: 'a' }).claimOriginKey, factIndex: 0 },
    ];
    expect(rows.sort(compareClaimProjectionOrder).map((row) => row.sortKey)).toEqual(
      rows.map((row) => row.sortKey).sort(),
    );
  });

  it('uses canonical Evidence origin as a stable secondary order for one Claim', () => {
    const claimOriginKey = 'a'.repeat(64);
    const evidenceKey = (sourceSnapshotId: string) =>
      claimEvidenceOriginKey({
        claimOriginKey,
        workspaceId: '11111111-1111-4111-8111-111111111111',
        siteId: '22222222-2222-4222-8222-222222222222',
        sourceSnapshotId,
        sourceRole: 'fact_candidate',
        sourceContentHash: 'b'.repeat(64),
        quote: 'Maximum pressure is 400 bar.',
      });
    const first = evidenceKey('33333333-3333-4333-8333-333333333333');
    const second = evidenceKey('99999999-9999-4999-8999-999999999999');
    const projectionRows = (keys: string[]) =>
      keys
        .map((key, factIndex) => ({
          sortKey: `${claimOriginKey}:${key}`,
          factIndex,
        }))
        .sort(compareClaimProjectionOrder)
        .map((row) => row.sortKey);

    expect(projectionRows([first, second])).toEqual(
      projectionRows([second, first]),
    );
  });

  it('canonicalizes Evidence fetchedAt identically before and after Prisma hydration', () => {
    const input = {
      claimOriginKey: 'a'.repeat(64),
      workspaceId: '11111111-1111-4111-8111-111111111111',
      siteId: '22222222-2222-4222-8222-222222222222',
      sourceSnapshotId: '33333333-3333-4333-8333-333333333333',
      sourceRole: 'fact_candidate' as const,
      sourceContentHash: 'b'.repeat(64),
      quote: 'Maximum pressure is 400 bar.',
    };

    expect(
      claimEvidenceOriginKey({
        ...input,
        fetchedAt: '2026-07-14T00:00:00Z',
      }),
    ).toBe(
      claimEvidenceOriginKey({
        ...input,
        fetchedAt: new Date('2026-07-14T00:00:00.000Z'),
      }),
    );
    expect(() =>
      claimEvidenceOriginKey({ ...input, fetchedAt: 'not-a-date' }),
    ).toThrow('invalid Evidence fetchedAt');
  });
});
