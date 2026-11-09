/**
 * ICP 行业词 → NACE 前缀映射（ch03 §3.9.12 的确定性离线底座，T3-05 子集）。
 *
 * 两条来源都能给出 NACE 前缀：
 *  1. 计划 filters 里的行业自由词（中/英/德）→ 复用 `ISIC_SEED` 的别名与 `crosswalks.nace`
 *     交叉表做**词面**匹配（语义归一仍归 taxonomy 冷路径，这里是确定性兜底）；
 *  2. taxonomy 归一注入的 `_industryCodes`（ISIC 码）→ 直接查交叉表。
 *
 * 另外提供 `canonicalNace`：把各国派生码（NAF rev2 的 `28.13Z`、无点号的 `2813`）归一到
 * NACE Rev.2 类目形态 `28.13`，装载时统一存储（原始码留在源快照里，可从快照回放）。
 *
 * 全部为纯函数：无 IO、无模型调用，可被适配器、装载器与单测共用。
 */
import { ISIC_SEED, type IsicNode } from '../discovery/isic-seed';

const CJK = /[㐀-鿿豈-﫿]/u;

/** 各国派生行业码 → NACE 类目形态（`28.13Z`/`2813`/`28.1`/`28` → `28.13`/`28.13`/`28.1`/`28`）。 */
export function canonicalNace(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim().toUpperCase();
  const match = /^(\d{2})(?:\.(\d{1,2})|(\d{2}))?([A-Z])?$/u.exec(value);
  if (!match) return null;
  const division = match[1]!;
  const group = match[2] ?? match[3];
  return group ? `${division}.${group}` : division;
}

function normalizeAlias(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

interface AliasEntry {
  alias: string;
  node: IsicNode;
  nacePrefixes: string[];
}

const ALIAS_INDEX: readonly AliasEntry[] = (() => {
  const entries: AliasEntry[] = [];
  for (const node of ISIC_SEED as readonly IsicNode[]) {
    const prefixes = node.crosswalks?.nace ?? [];
    if (prefixes.length === 0) continue;
    const terms = new Set<string>(
      [node.en, node.zh, node.de ?? '', ...(node.aliases ?? [])]
        .filter((term) => term.trim().length > 0)
        .map(normalizeAlias),
    );
    for (const alias of terms) entries.push({ alias, node, nacePrefixes: [...prefixes] });
  }
  return entries;
})();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词面匹配：完全相等、词边界包含（拉丁文），或纯子串包含（CJK，及 ≥4 字符的拉丁别名
 * ——德语复合词 Kreiselpumpen 必须命中 pump）。≥4 字符拉丁别名的子串匹配接受少量误配
 * 风险（如 pumpkin→pump），由调用方的结果复核与分层审计兜底。
 */
function aliasMatches(term: string, alias: string): boolean {
  if (term === alias) return true;
  if (CJK.test(alias)) return term.includes(alias);
  const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}([^\\p{L}\\p{N}]|$)`, 'u');
  if (bounded.test(term)) return true;
  return alias.length >= 4 && term.includes(alias);
}

export interface IndustryNaceResolution {
  prefixes: string[];
  matchedTerms: string[];
  unmatchedTerms: string[];
}

/** 行业自由词（一个或多个）→ NACE 前缀集合（去重排序）。 */
export function nacePrefixesForIndustryTerms(terms: readonly string[]): IndustryNaceResolution {
  const prefixes = new Set<string>();
  const matchedTerms: string[] = [];
  const unmatchedTerms: string[] = [];
  for (const raw of terms) {
    const term = normalizeAlias(raw);
    if (!term) continue;
    let matched = false;
    for (const entry of ALIAS_INDEX) {
      if (aliasMatches(term, entry.alias)) {
        matched = true;
        for (const prefix of entry.nacePrefixes) prefixes.add(prefix);
      }
    }
    (matched ? matchedTerms : unmatchedTerms).push(raw.trim());
  }
  return {
    prefixes: [...prefixes].sort(),
    matchedTerms,
    unmatchedTerms,
  };
}

export interface IsicNodeMatch {
  code: string;
  en: string;
  nacePrefixes: string[];
  /** 命中的词（原样，去重后保持首个出现顺序）。 */
  matchedTerms: string[];
}

/**
 * 行业自由词 → 命中的 ISIC 节点（含 matchedTerms），供存量归一推断使用。
 * 同一节点的多个别名命中合并；返回按 matchedTerms 数量与码具体度排序的稳定列表。
 */
export function matchIsicNodesForTerms(terms: readonly string[]): IsicNodeMatch[] {
  const matches = new Map<string, IsicNodeMatch>();
  for (const raw of terms) {
    const term = normalizeAlias(raw);
    if (!term) continue;
    for (const entry of ALIAS_INDEX) {
      if (!aliasMatches(term, entry.alias)) continue;
      const current = matches.get(entry.node.code) ?? {
        code: entry.node.code,
        en: entry.node.en,
        nacePrefixes: [...entry.nacePrefixes],
        matchedTerms: [],
      };
      const value = raw.trim();
      if (!current.matchedTerms.includes(value)) current.matchedTerms.push(value);
      matches.set(entry.node.code, current);
    }
  }
  return [...matches.values()].sort(
    (a, b) =>
      b.matchedTerms.length - a.matchedTerms.length ||
      b.code.length - a.code.length ||
      a.code.localeCompare(b.code),
  );
}

/** taxonomy 归一注入的 ISIC 码 → NACE 前缀（精确节点匹配）。 */
export function nacePrefixesForIsicCodes(codes: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!code) continue;
    for (const node of ISIC_SEED as readonly IsicNode[]) {
      if (node.code.toUpperCase() === code) {
        for (const prefix of node.crosswalks?.nace ?? []) prefixes.add(prefix);
      }
    }
  }
  return [...prefixes].sort();
}

/** 计划 filters 的行业入口（显式 nace_prefix 优先；其次自由词；最后 ISIC 码）。 */
export function resolveNacePrefixes(input: {
  nacePrefix?: unknown;
  industry?: unknown;
  industryCodes?: unknown;
}): string[] {
  const explicit = Array.isArray(input.nacePrefix)
    ? input.nacePrefix.filter((value): value is string => typeof value === 'string')
    : [];
  const normalizedExplicit = explicit
    .map((value) => canonicalNace(value) ?? value.trim())
    .filter((value) => value.length > 0);
  if (normalizedExplicit.length > 0) return [...new Set(normalizedExplicit)].sort();

  const industryTerms =
    typeof input.industry === 'string'
      ? [input.industry]
      : Array.isArray(input.industry)
        ? input.industry.filter((value): value is string => typeof value === 'string')
        : [];
  const fromTerms = nacePrefixesForIndustryTerms(industryTerms).prefixes;
  if (fromTerms.length > 0) return fromTerms;

  const codes = Array.isArray(input.industryCodes)
    ? input.industryCodes.filter((value): value is string => typeof value === 'string')
    : [];
  return nacePrefixesForIsicCodes(codes);
}
