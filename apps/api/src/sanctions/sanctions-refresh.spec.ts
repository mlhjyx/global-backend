import { describe, expect, it, vi } from 'vitest';
import {
  SanctionsRefreshService,
  countryToAlpha2,
  toDesiredEntity,
  diffSanctionsEntities,
  type ExistingEntityRow,
} from './sanctions-refresh.service';
import type { ParsedSanctionsEntity } from '../adapters/ofac-xml';
import type { PrismaClient } from '@prisma/client';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const SANCTIONS_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'platform',
  authorityId: '20000000-0000-4000-8000-000000000001',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'sanctions-download',
  resultStrategy: 'artifact_reference',
  resultSchema: 'sanctions-download/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: '50000000-0000-4000-8000-000000000001',
  usage: {
    currency: 'USD', unit: 'microusd', callCount: 1,
    upperBoundMicrousd: '10000',
  },
  costBasis: 'estimated_upper_bound',
});

const ENTITY_XML = `<sdnList>
  <publshInformation><Publish_Date>08/22/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation>
  <sdnEntry><uid>36</uid><lastName>AEROCARIBBEAN AIRLINES</lastName><sdnType>Entity</sdnType>
    <programList><program>CUBA</program></programList>
  </sdnEntry>
</sdnList>`;

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

describe('SanctionsRefreshService — budget context', () => {
  function successfulOwnerDb() {
    return {
      sanctionsSource: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'source-1', key: 'ofac', format: 'ofac_sdn_xml',
          url: 'https://example.test/sdn.xml', config: null,
        })),
        update: vi.fn(async () => undefined),
      },
      sanctionsEntity: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => undefined),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClient;
  }

  it('persists a successful unreceipted refresh and requires the platform writer once a receipt exists', async () => {
    const ownerDb = successfulOwnerDb();
    const withoutReceipt = new SanctionsRefreshService({
      ownerDb,
      broker: { invoke: vi.fn(async () => ({
        data: { body: ENTITY_XML, contentType: 'application/xml', lastModified: null },
        costCents: 0,
      })) } as unknown as ExecutionBroker,
    });
    await expect(withoutReceipt.refreshSource('source-1', 'platform-run')).resolves.toMatchObject({
      status: 'DONE', total: 1, added: 1,
    });

    const withReceipt = new SanctionsRefreshService({
      ownerDb: successfulOwnerDb(),
      broker: { invoke: vi.fn(async () => ({
        data: { body: ENTITY_XML, contentType: 'application/xml', lastModified: null },
        costCents: 0,
        durableReceipt: SANCTIONS_RECEIPT,
      })) } as unknown as ExecutionBroker,
    });
    await expect(withReceipt.refreshSource('source-1', 'platform-run'))
      .rejects.toThrow('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
  });

  it('passes the activity budget key into the ToolBroker context', async () => {
    const invoke = vi.fn(async () => ({
      data: { body: '<sdnList></sdnList>', contentType: 'application/xml', lastModified: null },
      costCents: 0,
    }));
    const update = vi.fn(async () => undefined);
    const ownerDb = {
      sanctionsSource: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'source-1',
          key: 'ofac',
          format: 'ofac_sdn_xml',
          url: 'https://example.test/sdn.xml',
          config: null,
        })),
        update,
      },
      sanctionsEntity: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const service = new SanctionsRefreshService({
      ownerDb,
      broker: { invoke } as unknown as ExecutionBroker,
    });

    await expect(
      service.refreshSource('source-1', 'sanctions-refresh:workflow-run'),
    ).rejects.toThrow('shrink guard');
    expect(invoke).toHaveBeenCalledWith(
      'sanctions.download',
      expect.objectContaining({ url: 'https://example.test/sdn.xml' }),
      {
        workspaceId: 'platform',
        purpose: 'sanctions_screening',
        runId: 'sanctions-refresh:workflow-run',
      },
    );
  });

  it('rethrows nested authority denial and does not continue to a later source', async () => {
    const failure = { name: 'ActivityFailure', cause: { type: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' } };
    const invoke = vi.fn(async () => Promise.reject(failure));
    const update = vi.fn(async () => undefined);
    const sources = [
      { id: 'source-1', key: 'ofac', format: 'ofac_sdn_xml', url: 'https://example.test/1.xml', config: null },
      { id: 'source-2', key: 'eu', format: 'eu_fsf_xml', url: 'https://example.test/2.xml', config: null },
    ];
    const ownerDb = { sanctionsSource: {
      findMany: vi.fn(async () => sources),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => sources.find((source) => source.id === where.id)),
      update,
    } } as unknown as PrismaClient;
    const service = new SanctionsRefreshService({ ownerDb, broker: { invoke } as unknown as ExecutionBroker });
    await expect(service.refreshAll('platform-account')).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'source-1' }, data: expect.objectContaining({ lastFetchStatus: 'FAILED' }) }));
  });
});
