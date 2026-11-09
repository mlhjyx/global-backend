/**
 * Golden ICP 评测集骨架（2026-11-10，多源证据图核心切片 ⑤）。
 *
 * 口径（README 同文）：对每条已标注 ICP 查询，用**离线确定性排序**从 dev 库候选里取
 * top-K，precision@K = top-K 中已标注正例（expected_domains）占比；同时报告 recall 与
 * 排除域误入。排序规则可解释、无模型调用：
 *   行业词命中（ISIC 别名，与 industry-map 同一匹配器）> 关键词/产品词命中 > 国家匹配；
 * 同分按域名升序（可复现）。
 *
 * YAML 解析：仓库不直接依赖 js-yaml（改锁文件要重签漏洞基线），这里用一个**受限子集**
 * 解析器：支持注释、`version:`、`queries:` 列表、行内 `[a, b]` 列表与缩进 `- item`
 * 块列表、单/双引号字符串。评测集文件保持在该子集内（README 有约束），解析失败报错
 * 带行号，绝不静默吞行。
 */
import { matchIsicNodesForTerms } from '../registry/industry-map';
import { normalizeCountryValue } from '../discovery/company-normalization';
import { lookupMarketRegion } from '../discovery/vocab';

export interface GoldenIcpQuery {
  id: string;
  /** ICP 自然语言描述（标注者写的人话）。 */
  icp: string;
  /** 目标市场（自由词，评估时归一成 ISO 集合）。 */
  targetMarkets: string[];
  /** 行业词（中/英/德均可）。 */
  industryTerms: string[];
  /** 已标注正例域名（无标签时为空数组 = 未标注）。 */
  expectedDomains: string[];
  /** 已标注负例（进入 top-K 时单独计数，不算正例）。 */
  excludedDomains: string[];
  notes?: string;
  labeledBy?: string;
  labeledAt?: string;
}

export interface GoldenIcpSet {
  version: number;
  queries: GoldenIcpQuery[];
}

export class GoldenIcpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenIcpParseError';
  }
}

function stripComment(line: string): string {
  // 引号内的 # 不算注释（评测集只用简单字符串，逐字符扫描足够）。
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new GoldenIcpParseError(`行内列表未闭合：${raw}`);
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => unquote(item)).filter((item) => item.length > 0);
  }
  return unquote(value);
}

const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u;
const LIST_ITEM = /^(\s*)-\s+(.*)$/u;

interface ParserState {
  version: number;
  queries: Array<Record<string, unknown>>;
  current: Record<string, unknown> | null;
  /** 当前等待块列表项的键（如在解析 `expected_domains:` 后跟随 `- x`）。 */
  pendingListKey: string | null;
}

/** 列表行：块列表项（缩进 ≥6 且有待收键）或新查询的 `- id:` 行。 */
function handleListLine(state: ParserState, rawLine: string, lineNo: number): void {
  const item = LIST_ITEM.exec(rawLine)!;
  const indent = item[1]!.length;
  const value = unquote(item[2]!);
  if (state.pendingListKey && indent >= 6) {
    const list = (state.current?.[state.pendingListKey] as string[] | undefined) ?? [];
    list.push(value);
    state.current![state.pendingListKey] = list;
    return;
  }
  const keyed = KEY_LINE.exec(item[2]!);
  if (indent >= 2 && keyed && keyed[2] === 'id') {
    state.current = { id: unquote(keyed[3]!) };
    state.queries.push(state.current);
    state.pendingListKey = null;
    return;
  }
  throw new GoldenIcpParseError(`第 ${lineNo} 行：无法识别的列表项「${rawLine.trim()}」`);
}

/** 键值行：顶层（version / queries）或当前查询字段（标量 / 块列表头）。 */
function handleKeyLine(state: ParserState, rawLine: string, lineNo: number): void {
  const keyed = KEY_LINE.exec(rawLine);
  if (!keyed) throw new GoldenIcpParseError(`第 ${lineNo} 行：无法解析「${rawLine.trim()}」`);
  const indent = keyed[1]!.length;
  const key = keyed[2]!;
  const rawValue = keyed[3]!;
  if (indent === 0) {
    if (key === 'version') {
      state.version = Number.parseInt(unquote(rawValue), 10);
      if (!Number.isInteger(state.version) || state.version < 1) {
        throw new GoldenIcpParseError(`第 ${lineNo} 行：version 必须是正整数`);
      }
    } else if (key !== 'queries') {
      throw new GoldenIcpParseError(`第 ${lineNo} 行：未知顶层键「${key}」`);
    }
    state.pendingListKey = null;
    return;
  }
  if (!state.current) {
    throw new GoldenIcpParseError(`第 ${lineNo} 行：查询字段出现在 queries 列表之前`);
  }
  if (rawValue.trim() === '') {
    // 块列表头：后续缩进 `- item` 归入此键
    state.pendingListKey = key;
    return;
  }
  state.current[key] = parseScalar(rawValue);
  state.pendingListKey = null;
}

/**
 * 受限 YAML 子集解析（见文件头注释）。结构：`version: N` 与 `queries:` 下的对象列表；
 * 对象字段值为标量或字符串列表（行内/块两种写法）。
 */
export function parseGoldenIcpYaml(text: string): GoldenIcpSet {
  const state: ParserState = { version: 1, queries: [], current: null, pendingListKey: null };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripComment(lines[index]!).replace(/\s+$/u, '');
    if (!rawLine.trim()) continue;
    if (LIST_ITEM.test(rawLine)) {
      handleListLine(state, rawLine, index + 1);
    } else {
      handleKeyLine(state, rawLine, index + 1);
    }
  }

  const parsed: GoldenIcpQuery[] = state.queries.map((query, index) => {
    const id = typeof query.id === 'string' ? query.id : '';
    if (!id) throw new GoldenIcpParseError(`第 ${index + 1} 条查询缺少 id`);
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      id,
      icp: typeof query.icp === 'string' ? query.icp : '',
      targetMarkets: list(query.target_markets),
      industryTerms: list(query.industry_terms),
      expectedDomains: list(query.expected_domains).map((domain) => domain.toLowerCase()),
      excludedDomains: list(query.excluded_domains).map((domain) => domain.toLowerCase()),
      ...(typeof query.notes === 'string' && query.notes ? { notes: query.notes } : {}),
      ...(typeof query.labeled_by === 'string' && query.labeled_by ? { labeledBy: query.labeled_by } : {}),
      ...(typeof query.labeled_at === 'string' && query.labeled_at ? { labeledAt: query.labeled_at } : {}),
    };
  });
  const ids = new Set<string>();
  for (const query of parsed) {
    if (ids.has(query.id)) throw new GoldenIcpParseError(`重复的查询 id：${query.id}`);
    ids.add(query.id);
  }
  return { version: state.version, queries: parsed };
}

export interface GoldenCandidate {
  domain: string;
  name: string;
  country: string | null;
  industry: string | null;
  keywords?: string[];
  products?: string[];
  /** 是否已建官网画像（website_profile 命名空间）——真实可接触公司的弱信号，+1。 */
  hasWebsiteProfile?: boolean;
}

export interface RankedCandidate extends GoldenCandidate {
  score: number;
  /** 命中依据（诊断）。 */
  matches: string[];
}

/** 目标市场词 → ISO 集合（地区词就地展开：DACH → DE/AT/CH）。 */
export function targetMarketIsos(terms: readonly string[]): string[] {
  const isos = new Set<string>();
  for (const term of terms) {
    const region = lookupMarketRegion(term.trim().toLowerCase());
    if (region) {
      for (const iso of region) isos.add(iso);
      continue;
    }
    const iso = normalizeCountryValue(term);
    if (iso) isos.add(iso);
  }
  return [...isos];
}

function candidateTerms(candidate: GoldenCandidate): string[] {
  return [
    ...(candidate.industry ? [candidate.industry] : []),
    ...(candidate.keywords ?? []),
    ...(candidate.products ?? []),
  ];
}

/**
 * 确定性排序：行业词 ISIC 命中 +3/词；候选自身词面包含行业词 +2/词；目标市场匹配 +2。
 * 返回全量排序（评测取 top-K；调用方过滤国家后再喂入）。
 */
export function rankGoldenCandidates(
  query: GoldenIcpQuery,
  candidates: readonly GoldenCandidate[],
): RankedCandidate[] {
  const isoTargets = new Set(targetMarketIsos(query.targetMarkets));
  const industryAliases = matchIsicNodesForTerms(query.industryTerms);
  const ranked = candidates.map((candidate) => {
    const matches: string[] = [];
    let score = 0;
    const terms = candidateTerms(candidate);
    const candidateNodes = matchIsicNodesForTerms(terms);
    for (const node of industryAliases) {
      const hit = candidateNodes.find((match) => match.code === node.code);
      if (!hit) continue;
      // 基础 3 分；候选自身有多个词命中同一节点时逐词 +2（证据更强，压过单词巧合）。
      score += 3 + Math.max(0, hit.matchedTerms.length - 1) * 2;
      matches.push(`isic:${node.code}`);
    }
    for (const industryTerm of query.industryTerms) {
      const needle = industryTerm.trim().toLowerCase();
      if (!needle) continue;
      if (terms.some((term) => term.toLowerCase().includes(needle))) {
        score += 2;
        matches.push(`term:${industryTerm}`);
      }
    }
    if (candidate.country && isoTargets.size > 0) {
      const iso = normalizeCountryValue(candidate.country);
      if (iso && isoTargets.has(iso)) {
        score += 2;
        matches.push(`market:${iso}`);
      }
    }
    if (candidate.hasWebsiteProfile) {
      score += 1;
      matches.push('website_profile');
    }
    return { ...candidate, score, matches };
  });
  return ranked.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
}

export interface PrecisionResult {
  queryId: string;
  k: number;
  labeled: boolean;
  topK: string[];
  hits: string[];
  missed: string[];
  excludedInTopK: string[];
  precisionAtK: number;
  recall: number;
}

/** precision@K（分母固定 K；未标注查询返回 labeled=false 且不计分）。 */
export function precisionAtK(
  query: GoldenIcpQuery,
  ranked: readonly RankedCandidate[],
  k = 10,
): PrecisionResult {
  const topK = ranked.slice(0, k).map((candidate) => candidate.domain.toLowerCase());
  const expected = new Set(query.expectedDomains);
  const excluded = new Set(query.excludedDomains);
  const labeled = expected.size > 0;
  const hits = topK.filter((domain) => expected.has(domain));
  return {
    queryId: query.id,
    k,
    labeled,
    topK,
    hits,
    missed: [...expected].filter((domain) => !topK.includes(domain)),
    excludedInTopK: topK.filter((domain) => excluded.has(domain)),
    precisionAtK: labeled ? Number((hits.length / k).toFixed(4)) : 0,
    recall: labeled ? Number((hits.length / expected.size).toFixed(4)) : 0,
  };
}
