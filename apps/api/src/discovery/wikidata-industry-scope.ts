/**
 * Wikidata 行业枢轴闸门。
 *
 * Wikidata 的 P452（行业）是企业自报的宽口径字段：节点一旦落到 `Q187939`（制造业）这类根编号，
 * SPARQL 就会按 P279* 子类闭包召回任意制造商（家具、游乐设施、食品机械……），与 ICP 无关。
 * 因此：解析层不把字母 section（C）和两位 division（24/25/26/27/28/29）的行业编号当作查询枢轴；
 * provider 层再对最终 QID 做一次 fail-closed 兜底（覆盖内置词表回退路径）。
 *
 * 窄编号（三位以上 ISIC 类级码，如 279/2610/4659）不受影响；`Q192127`、`Q220695` 等具体行业可正常出网。
 */
export const BROAD_WIKIDATA_INDUSTRY_QIDS: ReadonlySet<string> = new Set(['Q187939']);

/**
 * 内置词表回退路径没有"节点粒度"可依据，只能按 QID 判断；它的表本身就是行业大类，
 * 因此对回退结果采用更宽的拒绝集合。注入路径（活动层已按节点码过滤）不使用本集合，
 * 以免误伤映射到宽 QID 的具体节点（例如钣金 2599 也映射到 Q1857831）。
 */
export const BROAD_FALLBACK_INDUSTRY_QIDS: ReadonlySet<string> = new Set([
  ...BROAD_WIKIDATA_INDUSTRY_QIDS,
  'Q1857831',
  'Q11650',
  'Q11661',
  'Q206894',
  'Q19541171',
  'Q190117',
  'Q12705122',
]);

export type WikidataBroadIndustryMode = 'off' | 'enforce';

/** 只有显式 `off` 关闭闸门；缺省、空串与未知值一律 fail-safe 到 enforce。 */
export function wikidataBroadIndustryMode(
  raw: string | undefined = process.env.DISCOVERY_WIKIDATA_BROAD_INDUSTRY_MODE,
): WikidataBroadIndustryMode {
  return raw?.trim().toLowerCase() === 'off' ? 'off' : 'enforce';
}

export function isBroadIndustryQid(qid: string): boolean {
  return BROAD_WIKIDATA_INDUSTRY_QIDS.has(qid.trim());
}

/**
 * 行业节点能否作为 Wikidata 查询枢轴：必须有 QID，且 code 是三位以上的数字类级码。
 * 字母 section（C）与两位 division（24/25/26/27/28/29）太宽，不能作为 P452 枢轴。
 */
export function isSpecificIndustryNode(node: { code: string; wikidataQid?: string | null }): boolean {
  const qid = node.wikidataQid?.trim();
  if (!qid) return false;
  return /^\d{3,}$/.test(node.code.trim());
}

export function applyBroadIndustryGate(
  qids: readonly string[],
  mode: WikidataBroadIndustryMode,
  broad: ReadonlySet<string> = BROAD_WIKIDATA_INDUSTRY_QIDS,
): { accepted: string[]; rejected: string[] } {
  if (mode === 'off') return { accepted: [...qids], rejected: [] };
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of qids) {
    const qid = raw.trim();
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    if (broad.has(qid)) rejected.push(qid);
    else accepted.push(qid);
  }
  return { accepted, rejected };
}
