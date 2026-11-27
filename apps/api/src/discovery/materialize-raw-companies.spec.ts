import { describe, expect, it, vi } from 'vitest';
import { materializeRawCompanies } from './materialize-raw-companies';
import { companyIdentity } from './identity';

const WORKSPACE_ID = 'd8417bb4-5257-46c0-b600-aeb1e89e429d';
const RUN_ID = 'a1111111-1111-4111-8111-111111111111';

function createMockTx(initialCompanies: Array<Record<string, unknown>> = []) {
  const companiesByKey = new Map<string, Record<string, unknown>>();
  for (const company of initialCompanies) {
    companiesByKey.set(String(company.dedupeKey), { ...company });
  }
  const identityLinks: Array<Record<string, unknown>> = [];
  const fieldEvidence: Array<Record<string, unknown>> = [];
  let seq = 1;

  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: '1' }]),
    rawSourceRecord: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
    },
    rawSourceGovernanceDisposition: {
      findMany: vi.fn(async () => []),
    },
    suppressionRecord: {
      findMany: vi.fn(async () => []),
    },
    canonicalCompany: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_dedupeKey: { dedupeKey: string } } }) => {
        const found = companiesByKey.get(where.workspaceId_dedupeKey.dedupeKey);
        return found ? { ...found } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { workspaceId_dedupeKey: { dedupeKey: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = where.workspaceId_dedupeKey.dedupeKey;
        const existing = companiesByKey.get(key);
        if (!existing) {
          const created = {
            id: `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
            version: 1,
            updatedAt: new Date(),
            ...create,
          };
          companiesByKey.set(key, created);
          return created;
        }
        const next = { ...existing };
        if (update.country && typeof update.country === 'object' && 'set' in update.country) {
          next.country = (update.country as { set: string }).set;
        }
        if (update.region && typeof update.region === 'object' && 'set' in update.region) {
          next.region = (update.region as { set: string }).set;
        }
        if ('attributes' in update) {
          next.attributes = update.attributes;
        }
        next.version = Number(existing.version ?? 1) + 1;
        companiesByKey.set(key, next);
        return next;
      }),
    },
    identityLink: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        identityLinks.push(data);
        return data;
      }),
    },
    fieldEvidence: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        fieldEvidence.push(data);
        return data;
      }),
    },
  };

  return { tx, companiesByKey, identityLinks, fieldEvidence };
}

describe('materializeRawCompanies（名录国别回填与跨名录去重）', () => {
  it('backfills missing country from single-country directory source_directory and merges cross-directory legal suffix variants into one canonical_company', async () => {
    const { tx, companiesByKey, identityLinks, fieldEvidence } = createMockTx();
    tx.rawSourceRecord.findMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        providerKey: 'directory',
        sourceClass: 'industry_data',
        sourceUrl: 'https://mpsea.org.my/membership/',
        ingestStatus: 'ACCEPTED',
        ingestVersion: 'raw-source/v2',
        payload: {
          name: 'Pekat Solar Sdn. Bhd.',
          attributes: {
            source_kind: 'directory',
            source_directory: 'mpsea.org.my',
            source_class: 'industry_data',
          },
        },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        providerKey: 'directory',
        sourceClass: 'industry_data',
        sourceUrl: 'https://services.seda.gov.my/spqp/listing',
        ingestStatus: 'ACCEPTED',
        ingestVersion: 'raw-source/v2',
        payload: {
          name: 'Pekat Solar Berhad',
          attributes: {
            source_kind: 'directory',
            source_directory: 'services.seda.gov.my',
            source_class: 'industry_data',
          },
        },
      },
    ]);

    const res = await materializeRawCompanies(tx as never, { workspaceId: WORKSPACE_ID, runId: RUN_ID });
    expect(res.suppressed).toBe(0);
    expect(companiesByKey.size).toBe(1);
    const [canonical] = [...companiesByKey.values()];
    expect(canonical?.country).toBe('MY');
    expect(identityLinks).toHaveLength(2);
    expect(fieldEvidence.some((e) => e.field === 'country' && e.value === 'MY')).toBe(true);
  });

  it('backfills missing country on an existing canonical_company without overwriting an existing country', async () => {
    const existingWithoutCountry = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Axitec Energy GmbH',
      domain: 'axitecsolar.com',
      country: null,
      region: null,
      dedupeKey: companyIdentity({ name: 'Axitec Energy GmbH', domain: 'axitecsolar.com' }).dedupeKey,
      attributes: { source_kind: 'directory', source_class: 'industry_data' },
      status: 'NEW',
      version: 1,
      updatedAt: new Date(),
    };
    const existingWithCountry = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Swiss Solar AG',
      domain: 'swisssolar.ch',
      country: 'CH',
      region: null,
      dedupeKey: companyIdentity({ name: 'Swiss Solar AG', domain: 'swisssolar.ch' }).dedupeKey,
      attributes: { source_kind: 'directory', source_class: 'industry_data' },
      status: 'NEW',
      version: 1,
      updatedAt: new Date(),
    };
    const { tx, companiesByKey } = createMockTx([existingWithoutCountry, existingWithCountry]);
    tx.rawSourceRecord.findMany.mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        providerKey: 'directory',
        sourceClass: 'industry_data',
        sourceUrl: 'https://solarcluster-bw.de/de/ueber-uns/mitglieder',
        ingestStatus: 'ACCEPTED',
        ingestVersion: 'raw-source/v2',
        payload: {
          name: 'Axitec Energy GmbH',
          domain: 'axitecsolar.com',
          attributes: {
            source_kind: 'directory',
            source_directory: 'solarcluster-bw.de',
            source_class: 'industry_data',
          },
        },
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        providerKey: 'directory',
        sourceClass: 'industry_data',
        sourceUrl: 'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
        ingestStatus: 'ACCEPTED',
        ingestVersion: 'raw-source/v2',
        payload: {
          name: 'Swiss Solar AG',
          domain: 'swisssolar.ch',
          country: 'DE',
          attributes: {
            source_kind: 'directory',
            source_directory: 'solarwirtschaft.de',
            source_class: 'industry_data',
          },
        },
      },
    ]);

    await materializeRawCompanies(tx as never, { workspaceId: WORKSPACE_ID, runId: RUN_ID });
    expect(companiesByKey.get('d:axitecsolar.com')?.country).toBe('DE');
    // Existing country CH must never be overwritten by later DE record
    expect(companiesByKey.get('d:swisssolar.ch')?.country).toBe('CH');
  });
});
