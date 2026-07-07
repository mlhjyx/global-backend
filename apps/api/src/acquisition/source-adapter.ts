import { RawSourceEntity } from './clean';

/**
 * 采集源适配器（源无关）：给定源配置，抓回一批原始实体。
 * 展会/名录/官网/注册处各实现一个，统一由 AcquisitionService 走「清洗→快照→diff」。
 * 与 discovery 的 CompanyDiscoveryAdapter 区别：那是 ICP-query 驱动的一次性发现；
 * 这是 source-config 驱动的可重复采集（支持增量监控）。
 */
export interface MonitoredSourceAdapter {
  providerKey: string;
  /** 抓取该源全量（或 limit 上限内）原始实体。可重复调用（幂等 by externalId）。 */
  fetch(config: Record<string, unknown>, limit?: number): Promise<RawSourceEntity[]>;
}

/** 按 providerKey 注册源适配器。 */
export class SourceAdapterRegistry {
  private readonly byKey = new Map<string, MonitoredSourceAdapter>();

  register(adapter: MonitoredSourceAdapter): this {
    this.byKey.set(adapter.providerKey, adapter);
    return this;
  }

  get(providerKey: string): MonitoredSourceAdapter | undefined {
    return this.byKey.get(providerKey);
  }
}
