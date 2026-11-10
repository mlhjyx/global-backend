import { describe, expect, it } from 'vitest';
import { prepareRawSourceBatch, type RawSourcePolicySnapshot } from './raw-source-ingestion';

/**
 * 获客 vNext W4：opencorporates 记录走 Raw Source v2 治理入库——归一后只含公司字段，
 * license 只收 ODbL-1.0，来源锚定 api.opencorporates.com，注册号绑定 identifier。
 */

const NOW = new Date('2026-11-10T00:00:00.000Z');
const LIMITS = Object.freeze({
  maxRecordBytes: 4096,
  maxBatchBytes: 8192,
  defaultRetentionDays: 30,
});
const POLICIES: RawSourcePolicySnapshot[] = [
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    domain: 'api.opencorporates.com',
    retentionDays: 365,
    reviewStatus: 'APPROVED',
    allowedPurpose: ['discovery'],
    updatedAt: new Date('2026-11-09T00:00:00.000Z'),
  },
];

const EXTERNAL_ID = `opencorporates:${'c'.repeat(64)}`;

function openCorporatesRecord(overrides: Record<string, unknown> = {}) {
  return {
    externalId: EXTERNAL_ID,
    name: 'Müller Pumpen GmbH',
    country: 'DE',
    identifier: { scheme: 'oc-company-number:de', value: 'HRB 12345' },
    attributes: {
      opencorporates: {
        company_number: 'HRB 12345',
        jurisdiction_code: 'de',
        status: 'Active',
        registered_address: 'Musterstraße 1, 80331 München',
      },
    },
    license: 'ODbL-1.0',
    provenance: {
      sourceUrl: 'https://opencorporates.com/companies/de/HRB12345',
      fetchedAt: '2026-11-10T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      parserVersion: 'opencorporates/v1',
    },
    ...overrides,
  };
}

function prepare(record: Record<string, unknown>) {
  return prepareRawSourceBatch({
    providerKey: 'opencorporates',
    records: [record],
    policies: POLICIES,
    limits: LIMITS,
    now: NOW,
  }).rows[0]!;
}

describe('opencorporates raw-source ingestion（vNext W4）', () => {
  it('accepts the bounded company-field payload and anchors the source to the API endpoint', () => {
    const row = prepare(openCorporatesRecord());
    expect(row.ingestStatus).toBe('ACCEPTED');
    expect(row.dispositionCode).toBeNull();
    expect(row.retentionDays).toBe(365);
    // 公司页来源归一为受治理 API 检索端点（与 TED/openFDA 同一手法）。
    const payload = JSON.stringify(row.payload);
    expect(payload).toContain('https://api.opencorporates.com/v0.4/companies/search');
    expect(payload).not.toMatch(/\/companies\/de\/HRB12345/u);
  });

  it('trims attribution/license/URL from attributes and keeps only company fields', () => {
    const row = prepare(
      openCorporatesRecord({
        attributes: {
          opencorporates: {
            company_number: 'HRB 12345',
            jurisdiction_code: 'de',
            status: 'Active',
            license: 'ODbL-1.0',
            attribution: 'Source: OpenCorporates',
            opencorporates_url: 'https://opencorporates.com/companies/de/HRB12345',
            officer_name: 'Max Mustermann',
          },
        },
      }),
    );
    expect(row.ingestStatus).toBe('REJECTED');
    expect(JSON.stringify(row.payload)).not.toContain('Mustermann');
  });

  it('rejects a payload whose identifier does not match the company number (no cross-company binding)', () => {
    const row = prepare(
      openCorporatesRecord({
        identifier: { scheme: 'oc-company-number:de', value: 'HRB 99999' },
      }),
    );
    expect(row.ingestStatus).toBe('REJECTED');
    expect(row.dispositionCode).toBe('PROVIDER_PAYLOAD_SCHEMA_INVALID');
  });

  it('rejects a scheme without the jurisdiction namespace and a non-ODbL license', () => {
    const bare = prepare(
      openCorporatesRecord({
        identifier: { scheme: 'oc-company-number', value: 'HRB 12345' },
      }),
    );
    expect(bare.ingestStatus).toBe('REJECTED');
    const licensed = prepare(openCorporatesRecord({ license: 'CC0-1.0' }));
    expect(licensed.ingestStatus).toBe('REJECTED');
  });

  it('rejects an unknown attribute outside the closed opencorporates shape', () => {
    const row = prepare(
      openCorporatesRecord({
        attributes: {
          opencorporates: {
            company_number: 'HRB 12345',
            jurisdiction_code: 'de',
            mystery: 'drop',
          },
        },
      }),
    );
    expect(row.ingestStatus).toBe('REJECTED');
    expect(JSON.stringify(row.payload)).not.toContain('mystery');
  });
});
