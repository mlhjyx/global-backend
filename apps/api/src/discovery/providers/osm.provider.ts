import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { OsmPlace } from '../../adapters/openstreetmap';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { lookupIndustryOsmTags, lookupRegionOsmArea } from '../vocab';

/**
 * OpenStreetMap 地理发现 Provider（Overpass API，ODbL 开放数据，零爬取）。
 * 按 filters.industry → OSM 标签、filters.region/country → OSM area 枚举工业实体。
 * 产出真实企业名 + 坐标 + 地址；website 命中率参差，交 mineDomain 富化。
 * 属 industry_data 类。
 *
 * 收口②：出网经 ToolBroker（`osm.overpass` 为 required 工具）——SUSPENDED/未登记/
 * 用途不符一律 fail-closed；无 broker 不允许直连。
 */
export class OsmDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'openstreetmap';
  readonly classes: SourceClass[] = ['industry_data'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    if (!this.deps?.broker) {
       
      console.warn('[openstreetmap] broker unavailable, fail-closed (no raw egress)');
      return { records: [], costCents: 0 };
    }
    void opts; // 本源产出多无域名，blockedDomains 不适用（签名统一保留）

    const tagFilters = mapTags(query);
    const areaName = mapArea(query);
    if (!tagFilters.length || !areaName) return { records: [], costCents: 0 };

    let places: OsmPlace[];
    try {
      const res = await this.deps.broker.invoke<
        { areaName: string; tagFilters: { k: string; v?: string }[]; limit?: number },
        { places: OsmPlace[] }
      >(
        'osm.overpass',
        { areaName, tagFilters, limit: Math.min(query.limit, 80) },
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      places = res.data.places ?? [];
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace
       
      console.warn(`[openstreetmap] discover failed: ${String(err).slice(0, 150)}`);
      return { records: [], costCents: 0 };
    }

    const now = new Date().toISOString();
    const records: ProviderCompanyRecord[] = places.map((p) => ({
      externalId: `osm:${p.osmId}`,
      name: p.name,
      domain: p.website ? normalizeToDomain(p.website) : undefined,
      country: p.countryCode,
      attributes: {
        osm_id: p.osmId,
        latitude: p.latitude,
        longitude: p.longitude,
        city: p.city,
        osm_tags: p.tags,
        source_class: query.sourceClass,
      },
      provenance: {
        sourceUrl: `https://www.openstreetmap.org/${p.osmId}`,
        fetchedAt: now,
        contentHash: p.osmId,
        parserVersion: 'osm/1',
      },
    }));
    return { records, costCents: 0 };
  }
}

function mapTags(query: CompanyDiscoveryQuery): { k: string; v?: string }[] {
  const f = query.filters ?? {};
  // 优先用活动层归一好的 OSM 标签（DB taxonomy）；回退到内置 vocab。
  const resolved = f._osmTags as { k: string; v?: string }[] | undefined;
  if (resolved?.length) return resolved;
  const terms = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
  for (const t of terms) {
    const tags = lookupIndustryOsmTags(t);
    if (tags) return tags;
  }
  return [];
}

function mapArea(query: CompanyDiscoveryQuery): string | undefined {
  const f = query.filters ?? {};
  const terms = [f.region, f.country, f.area_name].flat().filter(Boolean).map(String);
  for (const t of terms) {
    const area = lookupRegionOsmArea(t);
    if (area) return area;
  }
  return undefined;
}

function normalizeToDomain(website: string): string | undefined {
  try {
    const u = website.includes('://') ? new URL(website) : new URL(`https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
