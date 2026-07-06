import { normalizeCompanyName } from './identity';

/**
 * 公司名最佳匹配（GLEIF / Wikidata 等按名富集共用）。
 * 归一（剥缩写 + 拼写全称法人词）→ token 相似度 → 返回最佳 + margin（歧义护栏用）。
 * 纪律：一堆同前缀实体挤在同一分段、无突出者 → margin 小 → 调用方应弃（绝不贴错身份）。
 */

/** 拼写全称法人形式词（缩写由 normalizeCompanyName 处理）：让 "Siemens AG"≡"Siemens Aktiengesellschaft"。 */
const EXTRA_LEGAL_TOKENS = new Set([
  'aktiengesellschaft', 'kommanditgesellschaft', 'gesellschaft', 'mbh', 'kgaa',
  'mit', 'beschränkter', 'beschrankter', 'haftung', 'societas', 'europaea',
  'incorporated', 'corporation', 'und', 'and',
]);

/** 匹配专用归一：基础归一 + 剥拼写全称法人词（先 NFC 防组合变音符裂词）。 */
export function normForMatch(name: string): string {
  return normalizeCompanyName(name.normalize('NFC'))
    .split(' ')
    .filter((t) => t && !EXTRA_LEGAL_TOKENS.has(t))
    .join(' ');
}

/**
 * token 相似度：精确=1；**查询完全被候选包含**（候选更具体）给子集加权，多出的 token
 * 每个扣 0.05；否则（含"候选更泛"）按 Jaccard。只对"候选更具体"加权，避免泛名造假高分。
 */
export function nameScore(q: string, qTokens: Set<string>, n: string, nTokens: Set<string>): number {
  if (q === n) return 1;
  const inter = [...qTokens].filter((t) => nTokens.has(t)).length;
  const union = qTokens.size + nTokens.size - inter;
  const jaccard = union ? inter / union : 0;
  if (inter === qTokens.size && qTokens.size > 0) {
    const extra = nTokens.size - qTokens.size;
    return Math.max(0.85 - extra * 0.05, jaccard);
  }
  return jaccard;
}

export interface BestMatch<T> {
  item: T;
  score: number;
  margin: number; // 最佳 − 次佳；小 = 歧义
}

/**
 * 从候选里挑名字最像的一条 + margin。getName 取候选的可比名。
 * 返回 null：查询无核心 token，或候选为空。
 */
export function pickBestByName<T>(
  queryName: string,
  items: T[],
  getName: (item: T) => string,
): BestMatch<T> | null {
  const q = normForMatch(queryName);
  const qTokens = new Set(q.split(' ').filter(Boolean));
  if (!qTokens.size) return null;

  const scored: { item: T; score: number }[] = [];
  for (const it of items) {
    const n = normForMatch(getName(it));
    const nTokens = new Set(n.split(' ').filter(Boolean));
    if (!nTokens.size) continue;
    scored.push({ item: it, score: nameScore(q, qTokens, n, nTokens) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return { item: scored[0].item, score: scored[0].score, margin: scored[0].score - (scored[1]?.score ?? 0) };
}
