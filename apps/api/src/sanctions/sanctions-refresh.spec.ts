import { describe, expect, it, vi } from 'vitest';
import {
  countryToAlpha2,
  toDesiredEntity,
  diffSanctionsEntities,
  SanctionsRefreshService,
  type ExistingEntityRow,
} from './sanctions-refresh.service';
import type { ParsedSanctionsEntity } from '../adapters/ofac-xml';

const ent = (over: Partial<ParsedSanctionsEntity> = {}): ParsedSanctionsEntity => ({
  externalId: '36',
  primaryName: 'AEROCARIBBEAN AIRLINES',
  country: 'Cuba',
  programs: ['CUBA'],
  aliases: [{ name: 'AERO-CARIBBEAN', quality: 'strong' }],
  ...over,
});

describe('countryToAlpha2', () => {
  it('OFAC 全名 / EU 代码 → alpha-2', () => {
    expect(countryToAlpha2('Cuba')).toBe('CU');
    expect(countryToAlpha2('RU')).toBe('RU');
    expect(countryToAlpha2('Russia')).toBe('RU');
    expect(countryToAlpha2('IRN')).toBe('IR'); // ISO3
  });
  it('未知/空 → null（matcher 视作 unknown，不误判国别）', () => {
    expect(countryToAlpha2('Neverland')).toBeNull();
    expect(countryToAlpha2(null)).toBeNull();
    expect(countryToAlpha2('')).toBeNull();
  });
});

describe('toDesiredEntity', () => {
  it('归一名 + alpha-2 国别 + rawFeatures 仅绿字段（无 person PII）', () => {
    const d = toDesiredEntity(ent(), '2026-07-13');
    expect(d.country).toBe('CU');
    expect(d.normalizedName).toBe('aerocaribbean airlines');
    expect(d.rawFeatures).toEqual({ addressCountry: 'Cuba' });
    expect(d.listVersion).toBe('2026-07-13');
  });
  it('contentHash 确定（同输入同 hash），字段变则变', () => {
    const a = toDesiredEntity(ent(), 'v1');
    const b = toDesiredEntity(ent(), 'v1');
    const c = toDesiredEntity(ent({ programs: ['CUBA', 'SDGT'] }), 'v1');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
  it('别名顺序不同但集合相同 → 同 hash（顺序无关）', () => {
    const a = toDesiredEntity(ent({ aliases: [{ name: 'X', quality: 'strong' }, { name: 'Y', quality: 'weak' }] }), 'v1');
    const b = toDesiredEntity(ent({ aliases: [{ name: 'Y', quality: 'weak' }, { name: 'X', quality: 'strong' }] }), 'v1');
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('diffSanctionsEntities', () => {
  const d1 = toDesiredEntity(ent({ externalId: '1' }), 'v1');
  const d2 = toDesiredEntity(ent({ externalId: '2', programs: ['IRAN'] }), 'v1');

  it('全新 → toCreate', () => {
    const diff = diffSanctionsEntities([], [d1, d2]);
    expect(diff.toCreate.map((d) => d.externalId)).toEqual(['1', '2']);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toWithdrawExternalIds).toEqual([]);
  });

  it('contentHash 未变 → unchanged（不写库）', () => {
    const existing: ExistingEntityRow[] = [{ externalId: '1', contentHash: d1.contentHash, withdrawnAt: null }];
    const diff = diffSanctionsEntities(existing, [d1]);
    expect(diff.unchanged).toBe(1);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
  });

  it('contentHash 变 → toUpdate；之前撤下现又出现 → toUpdate（复活）', () => {
    const existing: ExistingEntityRow[] = [
      { externalId: '1', contentHash: 'old', withdrawnAt: null },
      { externalId: '2', contentHash: d2.contentHash, withdrawnAt: new Date() },
    ];
    const diff = diffSanctionsEntities(existing, [d1, d2]);
    expect(diff.toUpdate.map((d) => d.externalId).sort()).toEqual(['1', '2']);
  });

  it('本次未出现且尚未撤下 → toWithdraw；已撤下的不重复撤', () => {
    const existing: ExistingEntityRow[] = [
      { externalId: '1', contentHash: d1.contentHash, withdrawnAt: null },
      { externalId: '99', contentHash: 'x', withdrawnAt: null },
      { externalId: '98', contentHash: 'y', withdrawnAt: new Date() },
    ];
    const diff = diffSanctionsEntities(existing, [d1]);
    expect(diff.toWithdrawExternalIds).toEqual(['99']);
  });
});

const OFAC_FIXTURE = `<?xml version="1.0"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>07/13/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry><uid>36</uid><lastName>AEROCARIBBEAN AIRLINES</lastName><sdnType>Entity</sdnType><programList><program>CUBA</program></programList><addressList><address><country>Cuba</country></address></addressList></sdnEntry>
  <sdnEntry><uid>9000</uid><lastName>GLOBAL TRADING LLC</lastName><sdnType>Entity</sdnType><programList><program>IRAN</program></programList></sdnEntry>
</sdnList>`;

describe('SanctionsRefreshService — broker, diff persistence, and failure isolation', () => {
  it('persists create/update/unchanged/withdraw chunks and marks the source DONE', async () => {
    const sourceUpdate = vi.fn(async () => ({}));
    const createMany = vi.fn(async () => ({ count: 1 }));
    const entityUpdate = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const ownerDb = {
      sanctionsSource: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'source-1',
          key: 'ofac',
          format: 'ofac_sdn_xml',
          url: 'https://ofac.example/sdn.xml',
          config: { userAgent: 'controlled-test' },
        })),
        update: sourceUpdate,
      },
      sanctionsEntity: {
        findMany: vi.fn(async () => [
          { externalId: '36', contentHash: 'stale', withdrawnAt: null },
          { externalId: '9000', contentHash: toDesiredEntity(ent({ externalId: '9000', primaryName: 'GLOBAL TRADING LLC', country: null, programs: ['IRAN'], aliases: [] }), '2026-07-13').contentHash, withdrawnAt: null },
          { externalId: 'withdraw-me', contentHash: 'old', withdrawnAt: null },
        ]),
        createMany,
        update: entityUpdate,
        updateMany,
      },
    };
    const broker = {
      invoke: vi.fn(async () => ({ data: { body: OFAC_FIXTURE } })),
    };
    const service = new SanctionsRefreshService({ ownerDb, broker } as never);

    const result = await service.refreshSource('source-1');

    expect(result).toMatchObject({
      sourceKey: 'ofac',
      status: 'DONE',
      total: 2,
      added: 0,
      updated: 1,
      unchanged: 1,
      withdrawn: 1,
      publishDate: '2026-07-13',
    });
    expect(broker.invoke).toHaveBeenCalledWith(
      'sanctions.download',
      { url: 'https://ofac.example/sdn.xml', userAgent: 'controlled-test' },
      expect.objectContaining({ purpose: 'sanctions_screening' }),
    );
    expect(createMany).not.toHaveBeenCalled();
    expect(entityUpdate).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(sourceUpdate).toHaveBeenLastCalledWith({
      where: { id: 'source-1' },
      data: expect.objectContaining({ lastFetchStatus: 'DONE', recordCount: 2 }),
    });
  });

  it('aborts an empty parsed download before destructive withdrawal and records FAILED', async () => {
    const sourceUpdate = vi.fn(async () => ({}));
    const ownerDb = {
      sanctionsSource: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'source-1', key: 'ofac', format: 'ofac_sdn_xml', url: 'https://ofac.example/sdn.xml', config: null,
        })),
        update: sourceUpdate,
      },
      sanctionsEntity: {
        findMany: vi.fn(async () => [{ externalId: 'old', contentHash: 'x', withdrawnAt: null }]),
        createMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const service = new SanctionsRefreshService({
      ownerDb,
      broker: { invoke: vi.fn(async () => ({ data: { body: '<sdnList></sdnList>' } })) },
    } as never);

    await expect(service.refreshSource('source-1')).rejects.toThrow('shrink guard');
    expect(sourceUpdate).toHaveBeenCalledWith({
      where: { id: 'source-1' },
      data: expect.objectContaining({ lastFetchStatus: 'FAILED' }),
    });
    expect(ownerDb.sanctionsEntity.updateMany).not.toHaveBeenCalled();
  });

  it('refreshAll isolates unsupported source failure and tolerates failure-status persistence errors', async () => {
    const ownerDb = {
      sanctionsSource: {
        findMany: vi.fn(async () => [{ id: 'bad', key: 'bad-source' }]),
        findUniqueOrThrow: vi.fn(async () => ({ id: 'bad', key: 'bad-source', format: 'unknown', url: 'https://bad.example', config: null })),
        update: vi.fn(async () => { throw new Error('status write unavailable'); }),
      },
    };
    const service = new SanctionsRefreshService({ ownerDb, broker: {} } as never);

    await expect(service.refreshAll()).resolves.toEqual([
      expect.objectContaining({ sourceKey: 'bad-source', status: 'FAILED', error: 'unsupported sanctions format: unknown' }),
    ]);
  });
});
