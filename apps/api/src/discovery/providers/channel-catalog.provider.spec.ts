import { describe, expect, it, vi } from 'vitest';
import { ChannelCatalogDiscoveryProvider } from './channel-catalog.provider';
import { parseDiscoveryCompanyResultLineage } from '../company-discovery-lineage';
import { validateRawSourceProviderPayload } from '../raw-source-provider-schema';
import { buildGovernedDiscoveryQueryExecutionPlan } from '../../temporal/discovery-query-governed-execution';

const WS = '00000000-0000-4000-8000-0000000000a1';
const RUN = '11111111-1111-4111-8111-111111111111';
const AUTH = '22222222-2222-4222-8222-222222222222';
const ACC = '33333333-3333-4333-8333-333333333333';
const CH_ID = '44444444-4444-4444-8444-444444444444';
const REC_ID = '55555555-5555-4555-8555-555555555555';

describe('ChannelCatalogDiscoveryProvider (本地已审渠道库 zero-egress)', () => {
  it('按国家与关键词过滤 APPROVED 记录，生成确定性 local_query 回执且通过 Raw 载荷校验', async () => {
    const findMany = vi.fn(async () => [
      {
        id: REC_ID,
        channelId: CH_ID,
        dedupeKey: 'domain:coesaenergy.it',
        name: 'Coesa Energy S.r.l.',
        website: 'https://www.coesaenergy.it',
        country: 'Italy',
        industry: 'photovoltaic EPC',
        products: ['solar module'],
        keywords: ['HJT', 'fotovoltaico'],
        sourceUrl: 'https://www.key-expo.com/exhibitors/coesa',
        contentHash: 'a'.repeat(64),
        lastSeenAt: new Date('2026-11-25T00:00:00.000Z'),
        channel: { name: 'KEY Energy Rimini', category: 'trade_fair', license: 'public' },
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        channelId: CH_ID,
        dedupeKey: 'domain:unrelated.de',
        name: 'Unrelated Bakery GmbH',
        website: 'https://unrelated.de',
        country: 'DE',
        industry: 'bakery',
        products: ['bread'],
        keywords: [],
        sourceUrl: 'https://example.de/bakery',
        contentHash: 'b'.repeat(64),
        lastSeenAt: new Date('2026-11-25T00:00:00.000Z'),
        channel: { name: 'Food Fair', category: 'trade_fair', license: 'public' },
      },
    ]);
    const onDurableReceipt = vi.fn();
    const provider = new ChannelCatalogDiscoveryProvider({
      prisma: { sourceChannelRecord: { findMany } } as never,
      lineageEnabled: true,
    });
    const res = await provider.discoverCompanies(
      {
        sourceClass: 'industry_data',
        filters: { country: 'IT', industry: 'photovoltaic' },
        keywords: ['HJT'],
        limit: 20,
      },
      {
        workspaceId: WS,
        runId: RUN,
        durableBudgetAuthority: { authorityId: AUTH, accountId: ACC },
        onDurableReceipt,
      },
    );
    expect(res.costCents).toBe(0);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.domain).toBe('coesaenergy.it');
    expect(res.records[0]?.country).toBe('IT');
    expect(validateRawSourceProviderPayload('channel_catalog', res.records[0]).ok).toBe(true);
    expect(onDurableReceipt).toHaveBeenCalledTimes(1);
    expect(parseDiscoveryCompanyResultLineage(res.lineage, 'channel_catalog').recordCount).toBe(1);
  });

  it('生产环境 129 字符 binding.accountKey 不会触发 operationKey 超 200 字符报错', async () => {
    const prodAccountKey = `discovery.run:discovery_run:${RUN}:${'c'.repeat(64)}`;
    expect(prodAccountKey.length).toBe(129);
    const onDurableReceipt = vi.fn();
    const provider = new ChannelCatalogDiscoveryProvider({
      prisma: { sourceChannelRecord: { findMany: vi.fn(async () => []) } } as never,
      lineageEnabled: true,
    });
    const res = await provider.discoverCompanies(
      { sourceClass: 'industry_data', filters: { country: 'IT' }, keywords: [], limit: 20 },
      {
        workspaceId: WS,
        runId: prodAccountKey,
        durableBudgetAuthority: { authorityId: AUTH, accountId: ACC },
        onDurableReceipt,
      },
    );
    expect(res.records).toHaveLength(0);
    expect(onDurableReceipt).toHaveBeenCalledTimes(1);
    const receipt = onDurableReceipt.mock.calls[0]?.[1] as { operationKey: string };
    expect(receipt.operationKey.length).toBeLessThanOrEqual(200);
    const parsed = parseDiscoveryCompanyResultLineage(res.lineage, 'channel_catalog');
    expect(parsed.recordCount).toBe(0);
    expect(parsed.attemptReceipts).toHaveLength(1);
    const plan = buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [provider],
      settled: [
        {
          status: 'fulfilled',
          value: {
            key: 'channel_catalog',
            r: res,
            durableReceipts: onDurableReceipt.mock.calls.map(([producerId, r]) => ({ producerId, receipt: r })) as never,
          },
        },
      ],
    });
    expect(plan.mode).toBe('governed');
    if (plan.mode !== 'governed') return;
    expect(plan.auxiliaryReceipts).toEqual([]);
    expect(plan.providerPlan.attempts).toHaveLength(1);
    expect(plan.providerPlan.attempts[0]).toMatchObject({
      providerKey: 'channel_catalog',
      producerId: 'channel_catalog.query',
      recordIndexes: [],
      providerRecordCount: 0,
    });
  });

  it('Phase 1: channel-level admission reads APPROVED and PENDING records from ENABLED channels (excluding REJECTED)', async () => {
    const findMany = vi.fn(async () => [
      {
        id: REC_ID,
        channelId: CH_ID,
        dedupeKey: 'domain:propak-exhibitor.th',
        name: 'ProPak Exhibitor Co., Ltd.',
        website: 'https://propak-exhibitor.th',
        country: 'TH',
        industry: 'packaging machinery',
        products: ['filling line'],
        keywords: ['packaging'],
        sourceUrl: 'https://www.propakasia.com/exhibitor/1',
        contentHash: 'd'.repeat(64),
        lastSeenAt: new Date('2026-11-25T00:00:00.000Z'),
        channel: { name: 'ProPak Asia 2026', category: 'trade_fair', license: 'public' },
      },
    ]);
    const provider = new ChannelCatalogDiscoveryProvider({
      prisma: { sourceChannelRecord: { findMany } } as never,
      lineageEnabled: true,
    });
    const res = await provider.discoverCompanies(
      { sourceClass: 'industry_data', filters: { country: 'TH', industry: 'packaging' }, keywords: [], limit: 20 },
      { workspaceId: WS, runId: RUN, durableBudgetAuthority: { authorityId: AUTH, accountId: ACC }, onDurableReceipt: vi.fn() },
    );

    expect(res.records).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reviewStatus: { in: ['APPROVED', 'PENDING'] },
          channel: { status: 'ENABLED' },
        },
      }),
    );
  });
});
