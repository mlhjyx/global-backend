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

// 公共 Overpass 实例限流严格且易超载（504）——多实例 fallback。
// 生产建议自托管 Overpass（OVERPASS_URL 覆盖）以获得稳定配额。
const OVERPASS_ENDPOINTS = (process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]);
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
  // 逐标签分别查询再合并：一个慢/超时的标签不至于让整批返回空（州级 union 易超时）。
  const perTag = Math.max(10, Math.ceil(limit / Math.max(1, tagFilters.length)));
  const settled = await Promise.allSettled(tagFilters.map((f) => queryOneTag(areaName, f, perTag)));
  const byId = new Map<string, OsmPlace>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const p of s.value) if (!byId.has(p.osmId)) byId.set(p.osmId, p);
  }
  return [...byId.values()].slice(0, limit);
}

// Overpass 规范：POST 以 application/x-www-form-urlencoded 的 data= 参数传查询。
async function queryOneTag(areaName: string, f: { k: string; v?: string }, limit: number): Promise<OsmPlace[]> {
  const sel = f.v ? `["${f.k}"="${f.v}"]` : `["${f.k}"]`;
  const query = `[out:json][timeout:25];
area["name"="${areaName}"]->.a;
nwr${sel}["name"](area.a);
out center ${Math.min(limit, 200)};`;
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) {
        lastErr = new Error(`overpass ${res.status}`); // 504/429 → 换下一个实例
        continue;
      }
      const json = (await res.json()) as { elements?: OsmElement[] };
      return (json.elements ?? []).map(elementToPlace).filter((p): p is OsmPlace => p !== null);
    } catch (err) {
      lastErr = err; // 超时/网络 → 换下一个实例
    }
  }
  throw lastErr ?? new Error('all overpass endpoints failed');
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
