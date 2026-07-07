import { SourceAdapterRegistry } from './source-adapter';
import { TradeFairSourceAdapter } from './adapters/trade-fair.source';

/**
 * 采集源适配器总装。新增源类型（名录/官网/注册处/MapYourShow…）在此注册一行即接入
 * 采集层——AcquisitionService 与 Temporal sweep 自动可用，无需改其它处。
 */
export function buildSourceAdapterRegistry(): SourceAdapterRegistry {
  return new SourceAdapterRegistry().register(new TradeFairSourceAdapter());
}
