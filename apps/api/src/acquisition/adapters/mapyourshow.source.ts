import { MonitoredSourceAdapter } from '../source-adapter';
import { RawSourceEntity } from '../clean';

/**
 * MapYourShow 参展商采集源（第二个展会平台，与 RX/Algolia 并列）。
 * MYS 是无鉴权的 ColdFusion 后端，参展商目录由 /8_0/ajax/remote-proxy.cfm 驱动。
 * 覆盖 150+ 北美/全球制造业展（IMTS/PACK EXPO/PROCESS EXPO/IPPE…）。
 *
 * 端点：GET remote-proxy.cfm?action=search&searchtype=exhibitor  →  DATA.results.exhibitor.hit[]
 *   IIS 对裸请求返回 403，必须带浏览器 UA + X-Requested-With + 同源 Referer（已复刻）。
 *
 * ⚠️ 数据分级：列表仅给**公司名 + 展位 + 描述**（🟢公司事实），**无网站/邮箱/国家**——
 *   联系方式需下游富集（website-find → GLEIF/Wikidata → 决策人抽取）。这与 Algolia 源
 *   （联系方式内联）不同，是 MYS 的固有限制，不是缺陷。
 */
interface MysHit {
  fields?: {
    exhid_l?: string;
    exhname_t?: string;
    exhdesc_t?: string;
    boothsdisplay_la?: string[];
    hallid_la?: string[];
  };
}

export class MapYourShowSourceAdapter implements MonitoredSourceAdapter {
  readonly providerKey = 'mapyourshow';

  async fetch(config: Record<string, unknown>, limit = 5000): Promise<RawSourceEntity[]> {
    const host = String(config.host ?? '').trim();
    if (!host || !/^[\w.-]+\.mapyourshow\.com$/.test(host)) {
      throw new Error(`mapyourshow source config needs host like "<show>.mapyourshow.com", got: ${host}`);
    }
    const base = `https://${host}/8_0`;
    const fairSlug = String(config.fairSlug ?? config.sourceKey ?? host.split('.')[0]);
    const url = `${base}/ajax/remote-proxy.cfm?action=search&searchtype=exhibitor&searchterm=&pageID=1&perpage=${limit}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base}/explore/exhibitor-gallery.cfm`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`mapyourshow ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { SUCCESS?: boolean; DATA?: { results?: { exhibitor?: { hit?: MysHit[] } } } };
    const hits = json?.DATA?.results?.exhibitor?.hit ?? [];

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
