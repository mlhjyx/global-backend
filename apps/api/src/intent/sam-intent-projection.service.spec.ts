import { describe, expect, it, vi } from 'vitest';
import { companyIdentity } from '../discovery/identity';
import { SamIntentProjectionService, US_FED_SOURCES_SOUGHT } from './sam-intent-projection.service';

describe('SamIntentProjectionService synthetic provenance quarantine', () => {
  it('does not derive SAM intent or evidence from an existing synthetic canonical company', async () => {
    const subjectKey = companyIdentity({ name: 'Synthetic Federal Buyer', country: 'US' }).dedupeKey;
    const company = {
      id: 'co-synthetic',
      name: 'Synthetic Federal Buyer',
      country: 'US',
      domain: null,
      dedupeKey: subjectKey,
      status: 'NEW',
      attributes: {},
      version: 1,
    };
    const upsert = vi.fn(async () => ({ id: company.id }));
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        upsert,
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: company.id, providerKey: 'stub', license: 'synthetic' },
        ]),
        create: evidenceCreate,
      },
    };
    const prisma = {
      sourceSignal: {
        findMany: vi.fn(async () => [{
          id: 'signal-1',
          providerKey: 'samgov',
          signalType: US_FED_SOURCES_SOUGHT,
          status: 'ACTIVE',
          occurredAt: new Date(),
          subjectKey,
          subjectName: company.name,
          subjectCountry: 'US',
          taxonomyKeys: ['naics:333999'],
          externalId: 'notice-1',
          payload: { naics: ['333999'], notice: 'notice-1' },
        }]),
      },
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
    };

    await expect(
      new SamIntentProjectionService({ prisma: prisma as never }).projectSourcesSought('ws-1', {
        naicsCodes: ['3339'],
      }),
    ).resolves.toMatchObject({ companiesTouched: 0, eventsProjected: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});
