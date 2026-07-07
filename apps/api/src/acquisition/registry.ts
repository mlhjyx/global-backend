import { SourceAdapterRegistry } from './source-adapter';
import { TradeFairSourceAdapter } from './adapters/trade-fair.source';
import { MapYourShowSourceAdapter } from './adapters/mapyourshow.source';

/**
 * 采集源适配器总装。新增源类型（名录/官网/注册处…）在此注册一行即接入采集层——
 * AcquisitionService 与 Temporal sweep 自动可用，无需改其它处。
 * 已接入平台：
 *   - trade_fair  = RX/Algolia（全球 350+ 展，联系方式内联）
 *   - mapyourshow = MapYourShow（北美/全球 150+ 制造业展，列表仅公司名/展位，联系方式靠富集）
 */
export function buildSourceAdapterRegistry(): SourceAdapterRegistry {
  return new SourceAdapterRegistry()
    .register(new TradeFairSourceAdapter())
    .register(new MapYourShowSourceAdapter());
}
