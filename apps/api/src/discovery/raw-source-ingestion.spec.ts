import { describe, expect, it } from 'vitest';
import {
  RAW_SOURCE_INGEST_VERSION,
  prepareRawSourceBatch,
  reconcileRawSourceBatch,
  rawPayloadHash,
  type RawSourcePolicySnapshot,
} from './raw-source-ingestion';

const NOW = new Date('2026-08-12T00:00:00.000Z');
const LIMITS = {
  maxRecordBytes: 512,
  maxBatchBytes: 1_024,
  defaultRetentionDays: 30,
};

const POLICIES: RawSourcePolicySnapshot[] = [
  {
    id: 'policy-1',
    domain: 'registry.example',
    retentionDays: 90,
    reviewStatus: 'APPROVED',
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  },
];

function record(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'company-1',
    name: 'Acme GmbH',
    domain: 'acme.example',
    country: 'DE',
    provenance: {
      sourceUrl: 'https://registry.example/companies/1',
      fetchedAt: '2026-08-11T12:00:00.000Z',
      contentHash: 'provider-page-hash',
      parserVersion: 'registry-v1',
    },
    ...overrides,
  };
}

describe('Raw Source v2 ingestion', () => {
  it('canonicalizes object key order before hashing', () => {
    expect(rawPayloadHash({ b: 2, a: { d: 4, c: 3 } })).toBe(rawPayloadHash({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('treats fetchedAt as transport metadata so an unchanged provider fact replays idempotently', () => {
    const first = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [record()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0];
    const replayed = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [
        record({
          provenance: {
            ...record().provenance,
            fetchedAt: '2026-08-12T12:00:00.000Z',
          },
        }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0];

    expect(replayed.payloadHash).toBe(first.payloadHash);
    expect(replayed.fetchedAt?.toISOString()).toBe('2026-08-12T12:00:00.000Z');
    expect(
      reconcileRawSourceBatch([replayed], [
        {
          id: 'raw-original',
          externalId: first.externalId,
          ingestKey: first.ingestKey,
          payloadHash: first.payloadHash,
          payload: first.payload,
        },
      ]),
    ).toMatchObject({ rows: [], duplicateCount: 1, quarantinedCount: 0 });
  });

  it('still detects changed provider content when only contentHash differs', () => {
    const first = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [record()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0];
    const changed = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [
        record({
          provenance: {
            ...record().provenance,
            fetchedAt: '2026-08-12T12:00:00.000Z',
            contentHash: 'changed-provider-page-hash',
          },
        }),
      ],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    }).rows[0];

    expect(changed.payloadHash).not.toBe(first.payloadHash);
  });

  it('normalizes optional undefined object fields without persisting non-JSON values', () => {
    const result = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [record({ region: undefined })],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    });

    expect(result.rows[0].ingestStatus).toBe('ACCEPTED');
    expect(result.rows[0].payload).not.toHaveProperty('region');
  });

  it('accepts bounded JSON with a mandatory hash, deterministic key and policy retention snapshot', () => {
    const result = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [record()],
      policies: POLICIES,
      limits: LIMITS,
      now: NOW,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      ingestVersion: RAW_SOURCE_INGEST_VERSION,
      ingestStatus: 'ACCEPTED',
      dispositionCode: null,
      retentionDays: 90,
      sourcePolicySnapshot: {
        kind: 'source_policy',
        id: 'policy-1',
        domain: 'registry.example',
        retentionDays: 90,
      },
    });
    expect(result.rows[0].ingestKey).toMatch(/^external:[a-f0-9]{64}$/u);
    expect(result.rows[0].payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.rows[0].payloadBytes).toBeGreaterThan(0);
    expect(result.rows[0].expiresAt.toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('derives a stable identity key when externalId is absent so changed attributes cannot create duplicates', () => {
    const first = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record({ externalId: '', attributes: { employees: 10 } })],
      policies: [],
      limits: LIMITS,
      now: NOW,
    }).rows[0];
    const changed = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record({ externalId: '', attributes: { employees: 11 } })],
      policies: [],
      limits: LIMITS,
      now: NOW,
    }).rows[0];

    expect(first.ingestKey).toMatch(/^identity:[a-f0-9]{64}$/u);
    expect(changed.ingestKey).toBe(first.ingestKey);
    expect(changed.payloadHash).not.toBe(first.payloadHash);
  });

  it('stores only a bounded quarantine receipt for an oversized record', () => {
    const result = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record({ attributes: { page: 'x'.repeat(2_000) } })],
      policies: [],
      limits: LIMITS,
      now: NOW,
    });

    expect(result.rows[0]).toMatchObject({
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'PAYLOAD_TOO_LARGE',
      payload: {
        _rawReceipt: 'raw-source/quarantine-v1',
        reason: 'PAYLOAD_TOO_LARGE',
      },
    });
    expect(JSON.stringify(result.rows[0].payload)).not.toContain('x'.repeat(100));
  });

  it('fails closed if a provider returns data from a source policy suspended after dispatch', () => {
    const result = prepareRawSourceBatch({
      providerKey: 'registry',
      records: [record()],
      policies: [{ ...POLICIES[0], reviewStatus: 'SUSPENDED' }],
      limits: LIMITS,
      now: NOW,
    });

    expect(result.rows[0]).toMatchObject({
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'SOURCE_POLICY_SUSPENDED',
    });
  });

  it('rejects non-JSON provider output without persisting the unsafe value', () => {
    const invalid = record({ attributes: { count: BigInt(1) } });
    const result = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [invalid],
      policies: [],
      limits: LIMITS,
      now: NOW,
    });

    expect(result.rows[0]).toMatchObject({
      ingestStatus: 'REJECTED',
      dispositionCode: 'INVALID_JSON',
      payload: {
        _rawReceipt: 'raw-source/rejected-v1',
        reason: 'INVALID_JSON',
      },
    });
    expect(() => JSON.stringify(result.rows[0].payload)).not.toThrow();
  });

  it('quarantines later records when the bounded batch budget is exhausted', () => {
    const sampleBytes = Buffer.byteLength(JSON.stringify(record()), 'utf8');
    const result = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record({ externalId: 'one' }), record({ externalId: 'two' })],
      policies: [],
      limits: {
        ...LIMITS,
        maxRecordBytes: sampleBytes + 100,
        maxBatchBytes: sampleBytes + 100,
      },
      now: NOW,
    });

    expect(result.rows.map((row) => row.ingestStatus)).toEqual(['ACCEPTED', 'QUARANTINED']);
    expect(result.rows[1].dispositionCode).toBe('BATCH_LIMIT_EXCEEDED');
  });

  it('turns processing-key content drift into one deterministic quarantine receipt', () => {
    const prepared = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record({ name: 'Changed GmbH' })],
      policies: [],
      limits: LIMITS,
      now: NOW,
    }).rows;
    const original = prepareRawSourceBatch({
      providerKey: 'directory',
      records: [record()],
      policies: [],
      limits: LIMITS,
      now: NOW,
    }).rows[0];

    const first = reconcileRawSourceBatch(prepared, [
      {
        id: 'raw-original',
        externalId: 'company-1',
        ingestKey: original.ingestKey,
        payloadHash: original.payloadHash,
        payload: original.payload,
      },
    ]);
    expect(first).toMatchObject({
      acceptedCount: 0,
      quarantinedCount: 1,
      duplicateCount: 0,
    });
    expect(first.rows[0]).toMatchObject({
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'PROCESSING_KEY_DRIFT',
      externalId: null,
      payload: {
        _rawReceipt: 'raw-source/quarantine-v1',
        reason: 'PROCESSING_KEY_DRIFT',
        conflictWithRawId: 'raw-original',
      },
    });

    const repeated = reconcileRawSourceBatch(prepared, [
      {
        id: 'raw-original',
        externalId: 'company-1',
        ingestKey: original.ingestKey,
        payloadHash: original.payloadHash,
        payload: original.payload,
      },
      {
        id: 'raw-quarantine',
        externalId: null,
        ingestKey: first.rows[0].ingestKey,
        payloadHash: first.rows[0].payloadHash,
        payload: first.rows[0].payload,
      },
    ]);
    expect(repeated).toMatchObject({
      acceptedCount: 0,
      quarantinedCount: 0,
      duplicateCount: 1,
    });
    expect(repeated.rows).toEqual([]);
  });
});
