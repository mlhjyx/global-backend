import { MonitoredSourceAdapter } from '../source-adapter';
import { RawSourceEntity } from '../clean';
import { ExecutionBroker } from '../../tools/tool-contract';
import type { MapYourShowFetchInput, MysRawHit } from '../../tools/source-tools';
import { PLATFORM_WORKSPACE } from '../../discovery/provider-contract';

/**
 * MapYourShow 参展商采集源（第二个展会平台，与 RX/Algolia 并列）。
 * MYS 是无鉴权的 ColdFusion 后端，参展商目录由 /8_0/ajax/remote-proxy.cfm 驱动。
 * 覆盖 150+ 北美/全球制造业展（IMTS/PACK EXPO/PROCESS EXPO/IPPE…）。
 *
 * 出网走 ToolBroker 的 mapyourshow.fetch（收口②）：required 治理域（mapyourshow.com），
 * source_policy 未登记/SUSPENDED 即 fail-closed；未注入 broker 同样拒绝——
 * acquire 对单源失败已有容错，不影响其余源。
 *
 * ⚠️ 数据分级：列表仅给**公司名 + 展位 + 描述**（🟢公司事实），**无网站/邮箱/国家**——
 *   联系方式需下游富集（website-find → GLEIF/Wikidata → 决策人抽取）。这与 Algolia 源
 *   （联系方式内联）不同，是 MYS 的固有限制，不是缺陷。
 */
export class MapYourShowSourceAdapter implements MonitoredSourceAdapter {
  readonly providerKey = 'mapyourshow';

  constructor(private readonly broker?: ExecutionBroker) {}

  async fetch(config: Record<string, unknown>, limit = 5000): Promise<RawSourceEntity[]> {
    const host = String(config.host ?? '').trim();
    if (!host || !/^[\w.-]+\.mapyourshow\.com$/.test(host)) {
      throw new Error(`mapyourshow source config needs host like "<show>.mapyourshow.com", got: ${host}`);
    }
    const fairSlug = String(config.fairSlug ?? config.sourceKey ?? host.split('.')[0]);
    if (!this.broker) throw new Error('mapyourshow: broker unavailable (fail-closed)');

    const result = await this.broker.invoke<MapYourShowFetchInput, { hits: MysRawHit[] }>(
      'mapyourshow.fetch',
      { host, limit },
      { workspaceId: PLATFORM_WORKSPACE, correlationId: 'acquisition-sweep' },
    );
    const hits = result.data.hits;

    const out: RawSourceEntity[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const f = h.fields ?? {};
      const externalId = (f.exhid_l ?? '').trim();
      const name = (f.exhname_t ?? '').trim();
      if (!externalId || !name || seen.has(externalId)) continue;
      seen.add(externalId);
      out.push({
        externalId,
        name,
        // MYS 列表无 website/country；留空由下游富集补
        fields: {
          stand: Array.isArray(f.boothsdisplay_la) ? f.boothsdisplay_la[0] : undefined,
          hall: Array.isArray(f.hallid_la) ? f.hallid_la[0] : undefined,
          description: f.exhdesc_t,
          source_fair: fairSlug,
          source_kind: 'trade_fair_exhibitor_mys',
        },
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
