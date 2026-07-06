/**
 * OpenStreetMap 企业实体发现/校验（公开地理数据）。
 * 两个用途：
 * 1) 校验——已发现公司的地址/坐标是否真实存在（实体真实性佐证）。
 * 2) 本地发现——按工业标签 + 地区找制造企业（Overpass API）。
 *
 * 经 SearXNG 的 openstreetmap 引擎做名称→地址查询（已验证可用）；
 * Overpass 直连做标签+地区的批量发现。合规：ODbL 公开数据，遵守 Nominatim/Overpass
 * 使用政策（UA、限流）。
 */

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = process.env.OSM_UA ?? 'GlobalDiscoveryBot/1.0 (b2b discovery)';

export interface OsmPlace {
  osmId: string;
  name: string;
  website?: string;
  city?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
  tags: Record<string, string>;
}

/**
 * Overpass：在给定行政区域内按标签找工业企业。
 * areaName 例 "Baden-Württemberg"；tagFilters 例 [{k:'craft',v:'metal_construction'},{k:'industrial'}]。
 * 只取带 name 的点/面。
 */
export async function discoverByArea(params: {
  areaName: string;
  tagFilters: { k: string; v?: string }[];
  limit?: number;
}): Promise<OsmPlace[]> {
  const { areaName, tagFilters, limit = 80 } = params;
  const filters = tagFilters
    .map((f) => {
      const sel = f.v ? `["${f.k}"="${f.v}"]` : `["${f.k}"]`;
      return `  nwr${sel}["name"](area.a);`;
    })
    .join('\n');
  const query = `[out:json][timeout:40];
area["name"="${areaName}"]->.a;
(
${filters}
);
out center ${Math.min(limit, 300)};`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
    body: query,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { elements?: OsmElement[] };
  return (json.elements ?? []).map(elementToPlace).filter((p): p is OsmPlace => p !== null).slice(0, limit);
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function elementToPlace(el: OsmElement): OsmPlace | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!name || lat == null || lon == null) return null;
  return {
    osmId: `${el.type}/${el.id}`,
    name,
    website: tags.website || tags['contact:website'] || undefined,
    city: tags['addr:city'],
    countryCode: tags['addr:country'],
    latitude: lat,
    longitude: lon,
    tags,
  };
}
