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

import { requestDiscoverySourceJson, type DiscoverySourceDispatch } from './discovery-v3-source-http';

const PRIMARY_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const OSM_NATIVE_TIMEOUT_MS = 30_000;
const OSM_NATIVE_LIMIT = 80;

// 公共 Overpass 实例限流严格且易超载（504）——多实例 fallback。
// 生产建议自托管 Overpass（OVERPASS_URL 覆盖）以获得稳定配额。
const OVERPASS_ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      PRIMARY_OVERPASS_ENDPOINT,
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
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
},
  beforeRequest?: () => Promise<void>,
): Promise<OsmPlace[]> {
  const { areaName, tagFilters, limit = 80 } = params;
  // 逐标签分别查询再合并：一个慢/超时的标签不至于让整批返回空（州级 union 易超时）。
  const perTag = Math.max(10, Math.ceil(limit / Math.max(1, tagFilters.length)));
  const settled = await Promise.allSettled(tagFilters.map((f) => queryOneTag(areaName, f, perTag, beforeRequest)));
  const authorizationDenial = settled.find(
    (result) =>
      result.status === 'rejected' &&
      result.reason instanceof Error &&
      result.reason.name === 'ExternalToolActionDeniedError',
  );
  if (authorizationDenial?.status === 'rejected') {
    throw authorizationDenial.reason;
  }
  const byId = new Map<string, OsmPlace>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const p of s.value) if (!byId.has(p.osmId)) byId.set(p.osmId, p);
  }
  return [...byId.values()].slice(0, limit);
}

/** One tag and the primary policy-covered endpoint per native operation. */
export async function discoverByAreaNative(
  params: Parameters<typeof discoverByArea>[0],
  dispatch: DiscoverySourceDispatch,
): Promise<OsmPlace[]> {
  if (OVERPASS_ENDPOINTS[0] !== PRIMARY_OVERPASS_ENDPOINT) {
    throw new Error('OSM_NATIVE_ENDPOINT_NOT_REGISTERED');
  }
  const { areaName, tagFilters, limit = OSM_NATIVE_LIMIT } = params;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OSM_NATIVE_LIMIT) {
    throw new Error('OSM_NATIVE_LIMIT_INVALID');
  }
  const tag = tagFilters[0];
  if (tagFilters.length !== 1 || !tag || !/^[a-z0-9:_-]{1,80}$/iu.test(tag.k) ||
      (tag.v !== undefined && !isOverpassQueryTerm(tag.v, 120)) || !isOverpassQueryTerm(areaName, 160)) {
    throw new Error('OSM_NATIVE_QUERY_INVALID');
  }
  const selector = tag.v ? `[${JSON.stringify(tag.k)}=${JSON.stringify(tag.v)}]` : `[${JSON.stringify(tag.k)}]`;
  const query = buildOverpassQuery(JSON.stringify(areaName), selector, limit);
  const json = await requestDiscoverySourceJson<{ elements?: OsmElement[]; remark?: unknown }>(PRIMARY_OVERPASS_ENDPOINT, {
    source: 'OSM', method: 'POST', timeoutMs: OSM_NATIVE_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
  }, dispatch);
  if (json.remark || !Array.isArray(json.elements) || json.elements.length > limit) {
    throw new Error('OSM_NATIVE_RESPONSE_INVALID');
  }
  return json.elements.map(elementToPlace).filter((place): place is OsmPlace => place !== null).map((place): OsmPlace => {
    const craft = place.tags.craft;
    return { ...place, tags: craft === 'metal_construction' || craft === 'blacksmith' ? { craft } : {} };
  });
}

function isOverpassQueryTerm(value: string, maxLength: number): boolean {
  return value.length <= maxLength && Boolean(value.trim()) && !/\p{Cc}/u.test(value);
}

function buildOverpassQuery(area: string, selector: string, limit: number): string {
  return `[out:json][timeout:25];
area["name"=${area}]->.a;
nwr${selector}["name"](area.a);
out center ${limit};`;
}

// Overpass 规范：POST 以 application/x-www-form-urlencoded 的 data= 参数传查询。
async function queryOneTag(areaName: string, f: { k: string; v?: string }, limit: number,
  beforeRequest?: () => Promise<void>,
): Promise<OsmPlace[]> {
  const sel = f.v ? `["${f.k}"="${f.v}"]` : `["${f.k}"]`;
  const query = buildOverpassQuery(`"${areaName}"`, sel, Math.min(limit, 200));
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    await beforeRequest?.();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
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
