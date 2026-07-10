import { MonitoredSourceAdapter } from '../source-adapter';
import { RawSourceEntity } from '../clean';
import { ExecutionBroker } from '../../tools/tool-contract';
import type { TradeFairAlgoliaInput } from '../../tools/source-tools';
import type { AlgoliaFairConfig, FairExhibitor } from '../../adapters/trade-fair-algolia';
import { PLATFORM_WORKSPACE } from '../../discovery/provider-contract';

/**
 * 展会参展商采集源（RX/Algolia 平台）。config = 某届的 Algolia 配置 + 展会标识。
 * 抓回参展商作为原始实体，externalId=Algolia objectID（届内稳定）供增量 diff。
 * 出网走 ToolBroker 的 tradefair.algolia（收口②，与 discovery 的
 * TradeFairDiscoveryProvider 共用同一 L0 工具）：required 治理域（ToS 灰偏红源），
 * source_policy 未登记/SUSPENDED 即 fail-closed；未注入 broker 同样拒绝——
 * acquire 对单源失败已有容错，不影响其余源。
 */
export class TradeFairSourceAdapter implements MonitoredSourceAdapter {
  readonly providerKey = 'trade_fair';

  constructor(private readonly broker?: ExecutionBroker) {}

  async fetch(config: Record<string, unknown>, limit = 2000): Promise<RawSourceEntity[]> {
    const algolia = config.algolia as AlgoliaFairConfig | undefined;
    if (!algolia?.appId || !algolia?.apiKey || !algolia?.indexName || !algolia?.eventEditionId) {
      throw new Error('trade_fair source config missing algolia {appId,apiKey,indexName,eventEditionId}');
    }
    const fairSlug = String(config.fairSlug ?? config.sourceKey ?? 'fair');
    if (!this.broker) throw new Error('trade_fair: broker unavailable (fail-closed)');

    const result = await this.broker.invoke<TradeFairAlgoliaInput, { exhibitors: FairExhibitor[] }>(
      'tradefair.algolia',
      { cfg: algolia, limit },
      { workspaceId: PLATFORM_WORKSPACE, correlationId: 'acquisition-sweep' },
    );
    return result.data.exhibitors.map((e) => ({
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
