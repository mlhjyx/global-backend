import { MonitoredSourceAdapter } from '../source-adapter';
import { RawSourceEntity } from '../clean';
import { queryAlgoliaExhibitors, AlgoliaFairConfig } from '../../adapters/trade-fair-algolia';

/**
 * 展会参展商采集源（RX/Algolia 平台）。config = 某届的 Algolia 配置 + 展会标识。
 * 抓回参展商作为原始实体，externalId=Algolia objectID（届内稳定）供增量 diff。
 * 与 discovery 的 TradeFairDiscoveryProvider 共用底层 queryAlgoliaExhibitors。
 */
export class TradeFairSourceAdapter implements MonitoredSourceAdapter {
  readonly providerKey = 'trade_fair';

  async fetch(config: Record<string, unknown>, limit = 2000): Promise<RawSourceEntity[]> {
    const algolia = config.algolia as AlgoliaFairConfig | undefined;
    if (!algolia?.appId || !algolia?.apiKey || !algolia?.indexName || !algolia?.eventEditionId) {
      throw new Error('trade_fair source config missing algolia {appId,apiKey,indexName,eventEditionId}');
    }
    const fairSlug = String(config.fairSlug ?? config.sourceKey ?? 'fair');
    const exhibitors = await queryAlgoliaExhibitors(algolia, limit);
    return exhibitors.map((e) => ({
      externalId: e.externalId,
      name: e.companyName,
      website: e.website,
      country: e.country,
      fields: {
        email: e.email,
        phone: e.phone,
        stand: e.stand,
        products: e.products,
        hiring: e.hiring,
        description: e.description,
        source_fair: fairSlug,
        source_kind: 'trade_fair_exhibitor',
      },
    }));
  }
}
