import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditRecall } from './recall-audit';
import {
  RECALL_POOL_EXPORT_SCHEMA,
  RecallPoolExportError,
  buildRecallPoolExport,
  parseRegistryExternalId,
  type RecallPoolSourceRow,
} from './recall-pool-export';

const NOW = '2026-11-10T09:00:00.000Z';

const row = (overrides: Partial<RecallPoolSourceRow> = {}): RecallPoolSourceRow => ({
  companyId: 'c1',
  name: 'POMPES MARTIN SAS',
  domain: 'pompes-martin.fr',
  registryScheme: 'fr_siren',
  registryNumber: '529990001',
  contacts: 2,
  ...overrides,
});

describe('parseRegistryExternalId', () => {
  it('parses the registry_frame external id into scheme and number', () => {
    expect(parseRegistryExternalId('fr_siren:529990001')).toEqual({
      scheme: 'fr_siren',
      number: '529990001',
    });
    expect(parseRegistryExternalId('gb_companies_house:01234567')).toEqual({
      scheme: 'gb_companies_house',
      number: '01234567',
    });
  });

  it('rejects non-registry external ids and malformed values', () => {
    expect(parseRegistryExternalId(null)).toBeNull();
    expect(parseRegistryExternalId('')).toBeNull();
    expect(parseRegistryExternalId('https://pompes-martin.fr')).toBeNull();
    expect(parseRegistryExternalId('UPS:1Z999AA10123456784')).toBeNull(); // 大写 scheme 不是注册键
    expect(parseRegistryExternalId('fr_siren:')).toBeNull();
    expect(parseRegistryExternalId('fr siren:123')).toBeNull();
    expect(parseRegistryExternalId(`fr_siren:${'9'.repeat(65)}`)).toBeNull();
  });
});

describe('buildRecallPoolExport', () => {
  it('emits the recall-audit pool shape with a canonical, recomputable hash', () => {
    const exported = buildRecallPoolExport({
      rows: [row({ companyId: 'c2', domain: 'Ventile.Example', registryNumber: '529990002', contacts: 0, name: 'VENTILE' }), row()],
      runId: 'run-1',
      workspaceId: 'ws-1',
      exportedAt: NOW,
    });
    expect(exported.schemaVersion).toBe(RECALL_POOL_EXPORT_SCHEMA);
    expect(exported.manifest).toMatchObject({ runId: 'run-1', workspaceId: 'ws-1', rowCount: 2, exportedAt: NOW });
    // 域名规范化（去空白、小写）；contactFound 与 contacts 口径一致。
    expect(exported.pool).toEqual([
      {
        name: 'POMPES MARTIN SAS',
        registryScheme: 'fr_siren',
        registryNumber: '529990001',
        domain: 'pompes-martin.fr',
        contactFound: true,
        contacts: 2,
      },
      {
        name: 'VENTILE',
        registryScheme: 'fr_siren',
        registryNumber: '529990002',
        domain: 'ventile.example',
        contactFound: false,
        contacts: 0,
      },
    ]);
    // 独立重算：排序后逐行规范 JSON 的 sha256。
    const canonical = exported.pool
      .map((entry) => JSON.stringify([entry.registryScheme ?? '', entry.registryNumber ?? '', entry.domain ?? '', entry.contacts, entry.name]))
      .join('\n');
    expect(exported.manifest.sha256).toBe(createHash('sha256').update(canonical).digest('hex'));

    // 与 recall-audit 直连：注册号键命中算 found。
    const audit = auditRecall({
      frame: [
        { scheme: 'fr_siren', regNumber: '529990001', country: 'FR', employeeBand: '50-249' },
        { scheme: 'fr_siren', regNumber: '529990099', country: 'FR', employeeBand: '50-249' },
      ],
      pool: exported.pool,
    });
    expect(audit.strata[0]).toMatchObject({ N: 2, n: 2, found: 1, domainResolved: 1, contactFound: 1 });
  });

  it('keeps companies without a registry identity (they cannot match, but the pool is complete)', () => {
    const exported = buildRecallPoolExport({
      rows: [row({ companyId: 'c9', registryScheme: null, registryNumber: null, domain: null, contacts: 0 })],
      exportedAt: NOW,
    });
    expect(exported.pool).toEqual([
      { name: 'POMPES MARTIN SAS', registryScheme: null, registryNumber: null, domain: null, contactFound: false, contacts: 0 },
    ]);
  });

  it('merges duplicate registry identities: any domain wins, contact count takes the maximum', () => {
    const exported = buildRecallPoolExport({
      rows: [
        row({ companyId: 'c1', domain: null, contacts: 0 }),
        row({ companyId: 'c1b', domain: 'pompes-martin.fr', contacts: 3 }),
      ],
      exportedAt: NOW,
    });
    expect(exported.pool).toHaveLength(1);
    expect(exported.pool[0]).toMatchObject({ domain: 'pompes-martin.fr', contactFound: true, contacts: 3 });
  });

  it('is stable across row order (hash covers the sorted pool, not insertion order)', () => {
    const a = buildRecallPoolExport({ rows: [row(), row({ companyId: 'c2', registryNumber: '529990002' })], exportedAt: NOW });
    const b = buildRecallPoolExport({ rows: [row({ companyId: 'c2', registryNumber: '529990002' }), row()], exportedAt: NOW });
    expect(b.manifest.sha256).toBe(a.manifest.sha256);
    expect(b.pool).toEqual(a.pool);
  });

  it('fails closed on invalid rows or timestamps', () => {
    expect(() =>
      buildRecallPoolExport({ rows: [row({ contacts: -1 })], exportedAt: NOW }),
    ).toThrow(RecallPoolExportError);
    expect(() =>
      buildRecallPoolExport({ rows: [row({ companyId: '' })], exportedAt: NOW }),
    ).toThrow(RecallPoolExportError);
    expect(() => buildRecallPoolExport({ rows: [], exportedAt: 'not-a-date' })).toThrow(/exportedAt/u);
    // 空池是合法的（run 无产出），manifest 记录 rowCount 0。
    expect(buildRecallPoolExport({ rows: [], exportedAt: NOW }).manifest.rowCount).toBe(0);
  });
});
