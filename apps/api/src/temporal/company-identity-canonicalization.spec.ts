import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createDiscoveryActivities } from './discovery.activities';

function makeActivities(raws: unknown[], existingByKey: Record<string, unknown> = {}) {
  const upsert = vi.fn(async ({ where, create }: { where: { workspaceId_dedupeKey: { dedupeKey: string } }; create: unknown }) => ({
    id: `canonical:${where.workspaceId_dedupeKey.dedupeKey}`,
    ...(create as object),
  }));
  const tx = {
    rawSourceRecord: { findMany: vi.fn(async () => raws) },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    canonicalCompany: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_dedupeKey: { dedupeKey: string } } }) =>
        existingByKey[where.workspaceId_dedupeKey.dedupeKey] ?? null,
      ),
      upsert,
    },
    identityLink: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    fieldEvidence: { create: vi.fn(async () => ({})) },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> => fn(tx),
  };
  const activities = createDiscoveryActivities({ prisma, providers: {}, gateway: {} } as never);
  return { activities, upsert };
}

describe('canonicalizeRun identity safety guard', () => {
  it('isolates name_country evidence under a provisional review key instead of merging the legacy canonical', async () => {
    const { activities, upsert } = makeActivities(
      [
        {
          id: 'raw-name-country-1',
          providerKey: 'public_web',
          payload: { name: 'Muster Pumpenhandel GmbH', country: 'DE', attributes: { sector: 'industrial_pumps' } },
        },
      ],
      {
        'n:muster pumpenhandel:de': {
          id: 'legacy-canonical-id-must-survive',
          dedupeKey: 'n:muster pumpenhandel:de',
          name: 'Muster Pumpenhandel GmbH',
          country: 'DE',
          domain: null,
          attributes: {},
        },
      },
    );

    const result = await activities.canonicalizeRun({ workspaceId: 'workspace-1', runId: 'run-1' });

    expect(result).toEqual({ companies: 1, suppressed: 0, reviewRequired: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0] as { where: { workspaceId_dedupeKey: { dedupeKey: string } }; create: { attributes: unknown } };
    expect(call.where.workspaceId_dedupeKey.dedupeKey).toBe('review:raw-name-country-1');
    expect(call.where.workspaceId_dedupeKey.dedupeKey).not.toBe('n:muster pumpenhandel:de');
    expect(call.create.attributes).toMatchObject({
      identity_resolution: {
        decision: 'REVIEW_LINK',
        candidate_dedupe_key: 'n:muster pumpenhandel:de',
        recommendation_eligible: false,
      },
    });
  });

  it('uses the authoritative country-qualified identifier key for safe new canonical creation', async () => {
    const { activities, upsert } = makeActivities([
      {
        id: 'raw-ted-1',
        providerKey: 'ted',
        payload: {
          name: 'Nordstern Pumpenhandel GmbH',
          country: 'DE',
          identifier: { scheme: 'ted-natid:de', value: 'DE 991 002' },
          attributes: { ted: { notice_type: 'can-standard' } },
        },
      },
    ]);

    const result = await activities.canonicalizeRun({ workspaceId: 'workspace-1', runId: 'run-1' });

    expect(result).toEqual({ companies: 1, suppressed: 0, reviewRequired: 0 });
    const call = upsert.mock.calls[0][0] as { where: { workspaceId_dedupeKey: { dedupeKey: string } } };
    expect(call.where.workspaceId_dedupeKey.dedupeKey).toBe('id:ted-natid:de:de991002');
  });
});
