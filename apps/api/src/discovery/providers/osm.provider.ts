import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryResult,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { discoverByArea } from '../../adapters/openstreetmap';
import { INDUSTRY_OSM_TAGS, REGION_OSM_AREA } from '../vocab';

/**
 * OpenStreetMap 地理发现 Provider（Overpass API，ODbL 开放数据，零爬取）。
 * 按 filters.industry → OSM 标签、filters.region/country → OSM area 枚举工业实体。
 * 产出真实企业名 + 坐标 + 地址；website 命中率参差，交 mineDomain 富化。
 * 属 industry_data 类。
 */
export class OsmDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'openstreetmap';
  readonly classes: SourceClass[] = ['industry_data'];

  async discoverCompanies(query: CompanyDiscoveryQuery): Promise<DiscoveryResult> {
    const tagFilters = mapTags(query);
    const areaName = mapArea(query);
    if (!tagFilters.length || !areaName) return { records: [], costCents: 0 };

    const places = await discoverByArea({ areaName, tagFilters, limit: Math.min(query.limit, 80) });
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
  const terms = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
  for (const t of terms) {
    const tags = INDUSTRY_OSM_TAGS[t.toLowerCase().trim()];
    if (tags) return tags;
  }
  return [];
}

function mapArea(query: CompanyDiscoveryQuery): string | undefined {
  const f = query.filters ?? {};
  const terms = [f.region, f.country, f.area_name].flat().filter(Boolean).map(String);
  for (const t of terms) {
    const area = REGION_OSM_AREA[t.toLowerCase().trim()];
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
