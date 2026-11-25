import { describe, expect, it, vi } from 'vitest';
import { ChannelCatalogDiscoveryProvider } from './channel-catalog.provider';
import { parseDiscoveryCompanyResultLineage } from '../company-discovery-lineage';
import { validateRawSourceProviderPayload } from '../raw-source-provider-schema';

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
});
