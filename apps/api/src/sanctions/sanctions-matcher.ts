import { normForMatch, nameScore } from '../discovery/name-match';

/**
 * 制裁筛查匹配核心（**召回优先**，复用 discovery/name-match 归一 + token 相似度）。
 * 与发现「取唯一最佳、精准不误并」相反：**返回全部超阈候选**（多个疑似都要人审），阈值更松。
 *
 * 🔴 规则（据 OFAC FAQ 124 + 设计 §4.3）：
 *  - **弱别名（weak）绝不 originate 命中**——只用于**升高**已由 primaryName/强别名命中的候选置信。
 *  - 国别背离 → 降**展示分**（供人审 triage），但**不影响候选资格、不自动清**（公司可迁址；名字身份是主信号）。
 *  - 精确归一名 = 满分 1.0（nameScore q===n）。
 */

export interface IndexedAlias {
  name: string;
  normalized: string;
  tokens: Set<string>;
  /** 去掉开头法律形式后的核心词：查询至少与它共享 1 个词，这个名字才算数（分数仍按 tokens 算）。 */
  coreTokens: Set<string>;
  quality: 'strong' | 'weak';
}

/** 进程内索引里的一条被制裁实体（screening service 从 DB 建）。 */
export interface IndexedSanctionsEntity {
  externalId: string;
  sourceKey: string;
  primaryName: string;
  normalizedPrimary: string;
  primaryTokens: Set<string>;
  primaryCoreTokens: Set<string>;
  country: string | null; // alpha-2（或原样）
  listVersion: string;
  aliases: IndexedAlias[];
}

export interface ScreenMatch {
  externalId: string;
  sourceKey: string;
  matchedName: string; // 命中的名（primaryName 或某别名）
  aliasQuality: 'primary' | 'strong' | 'weak'; // primary=命中主名
  score: number; // 展示分（含国别调整，clamp [0,1]）
  nameScore: number; // 纯名字分（决定候选资格，未经国别调整）
  entityCountry: string | null;
  countryMatch: 'same' | 'diverge' | 'unknown';
  listVersion: string;
}

export interface MatcherOpts {
  threshold?: number; // 召回阈值（默认 0.70）：nameScore ≥ 此 → 候选
  countryBonus?: number; // 国别一致展示分加成
  countryPenalty?: number; // 国别背离展示分扣减（不影响候选资格）
}

export const DEFAULT_MATCH_THRESHOLD = 0.7;
const DEFAULT_COUNTRY_BONUS = 0.05;
const DEFAULT_COUNTRY_PENALTY = 0.1;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 双向 token 相似度（召回优先）：max(q⊆n 加权, n⊆q 加权)。
 * `nameScore` 只对「查询 ⊆ 候选」加权；制裁常见形态是**实体短名 ⊆ 公司全名**（如实体 "Tinkoff" vs
 * 公司 "Tinkoff Bank JSC"），单向会漏（复审 M3a）。取两向最大 → 两种子集关系都被召回。
 */
function bidirNameScore(q: string, qTokens: Set<string>, n: string, nTokens: Set<string>): number {
  return Math.max(nameScore(q, qTokens, n, nTokens), nameScore(n, nTokens, q, qTokens));
}

/**
 * 名单实体名开头的俄式 / 独联体法律形式（FSE = Federal State Enterprise、FSUE/FGUP/GUP 国有单一制企业、
 * OOO/OAO/ZAO/PAO/AO 公司形式、JSC 系列），只收两份名单里实际以开头形式出现过的。和 GmbH、LLC 一样不是身份。
 */
const ENTITY_LEADING_LEGAL_FORMS: ReadonlySet<string> = new Set([
  'fse', 'fsue', 'fgup', 'gup',
  'ooo', 'oao', 'zao', 'pao', 'ao',
  'jsc', 'ojsc', 'pjsc', 'cjsc',
]);

/**
 * 实体侧预归一：(normalized, tokens) 与查询侧同法（normForMatch），分数按它们算；另给出 coreTokens——
 * 剥掉**开头**法律形式后的词（名字全由法律形式组成时取完整词集）。只用于门槛：查询与 coreTokens 没有交集时这个名字不算命中，
 * 于是「唯一重合是法律形式」的误报（公司「FSE」↔「FSE Kamensky Zavod」）消失；分数、其余命中都不变。
 * 不直接剥 tokens：那会让「Kalashnikov JSC」↔「JSC KALASHNIKOV CONCERN」这类两侧都带法律形式的真命中漏掉（#660 复审）。
 */
export function prepareName(name: string): { normalized: string; tokens: Set<string>; coreTokens: Set<string> } {
  const normalized = normForMatch(name);
  const parts = normalized.split(' ').filter(Boolean);
  // 名字全部由法律形式组成时没有可剥的名字：核心用完整词集，命中与 main 相同。
  if (parts.every((t) => ENTITY_LEADING_LEGAL_FORMS.has(t))) {
    return { normalized, tokens: new Set(parts), coreTokens: new Set(parts) };
  }
  let start = 0;
  while (ENTITY_LEADING_LEGAL_FORMS.has(parts[start])) start += 1;
  return { normalized, tokens: new Set(parts), coreTokens: new Set(parts.slice(start)) };
}

function sharesCore(qTokens: Set<string>, coreTokens: Set<string>): boolean {
  for (const t of qTokens) if (coreTokens.has(t)) return true;
  return false;
}

/** 建索引的输入行（screening service 从 sanctions_entity 取，sourceId→sourceKey 已解析）。 */
export interface SanctionsEntityRow {
  externalId: string;
  sourceKey: string;
  primaryName: string;
  country: string | null;
  listVersion: string;
  aliases: unknown; // Json：[{ name, quality }]
}

/** DB 行 → 进程内匹配索引（纯函数；归一 + token 预算一次，筛查时零重复归一）。 */
export function buildSanctionsIndex(rows: readonly SanctionsEntityRow[]): IndexedSanctionsEntity[] {
  const out: IndexedSanctionsEntity[] = [];
  for (const r of rows) {
    if (!r.primaryName) continue;
    const p = prepareName(r.primaryName);
    const rawAliases = Array.isArray(r.aliases) ? (r.aliases as { name?: unknown; quality?: unknown }[]) : [];
    const aliases: IndexedAlias[] = [];
    for (const a of rawAliases) {
      const name = typeof a?.name === 'string' ? a.name : null;
      if (!name) continue;
      const pa = prepareName(name);
      aliases.push({
        name,
        normalized: pa.normalized,
        tokens: pa.tokens,
        coreTokens: pa.coreTokens,
        quality: a?.quality === 'weak' ? 'weak' : 'strong',
      });
    }
    out.push({
      externalId: r.externalId,
      sourceKey: r.sourceKey,
      primaryName: r.primaryName,
      normalizedPrimary: p.normalized,
      primaryTokens: p.tokens,
      primaryCoreTokens: p.coreTokens,
      country: r.country,
      listVersion: r.listVersion,
      aliases,
    });
  }
  return out;
}

/**
 * 对一个公司名筛查整个索引 → 全部超阈候选（按展示分降序）。
 * @param companyName 目标公司名
 * @param companyCountry 目标公司国别（alpha-2；无则 null）
 */
export function screenName(
  companyName: string,
  companyCountry: string | null,
  index: readonly IndexedSanctionsEntity[],
  opts?: MatcherOpts,
): ScreenMatch[] {
  const threshold = opts?.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const countryBonus = opts?.countryBonus ?? DEFAULT_COUNTRY_BONUS;
  const countryPenalty = opts?.countryPenalty ?? DEFAULT_COUNTRY_PENALTY;

  const q = normForMatch(companyName);
  const qTokens = new Set(q.split(' ').filter(Boolean));
  if (!qTokens.size) return []; // 无核心 token → 不筛（防泛匹配）

  const matches: ScreenMatch[] = [];
  for (const ent of index) {
    // ① originate：只用 primaryName + 强别名（弱别名不 originate）
    let bestName = ent.primaryName;
    let bestQuality: ScreenMatch['aliasQuality'] = 'primary';
    let best =
      ent.primaryTokens.size && sharesCore(qTokens, ent.primaryCoreTokens)
        ? bidirNameScore(q, qTokens, ent.normalizedPrimary, ent.primaryTokens)
        : 0;
    for (const a of ent.aliases) {
      if (a.quality !== 'strong' || !a.tokens.size || !sharesCore(qTokens, a.coreTokens)) continue;
      const s = bidirNameScore(q, qTokens, a.normalized, a.tokens);
      if (s > best) {
        best = s;
        bestName = a.name;
        bestQuality = 'strong';
      }
    }
    if (best < threshold) continue; // 不够 originate → 跳过（弱别名不能救）

    // ② 弱别名只用于**升高**已 originate 的候选（不能凭空建候选）
    for (const a of ent.aliases) {
      if (a.quality !== 'weak' || !a.tokens.size || !sharesCore(qTokens, a.coreTokens)) continue;
      const s = bidirNameScore(q, qTokens, a.normalized, a.tokens);
      if (s > best) {
        best = s;
        bestName = a.name;
        bestQuality = 'weak';
      }
    }

    // ③ 国别调整（仅动展示分，不影响候选资格——名字已定 originate）
    let countryMatch: ScreenMatch['countryMatch'] = 'unknown';
    let display = best;
    if (companyCountry && ent.country) {
      if (companyCountry.toLowerCase() === ent.country.toLowerCase()) {
        countryMatch = 'same';
        display = clamp01(best + countryBonus);
      } else {
        countryMatch = 'diverge';
        display = clamp01(best - countryPenalty);
      }
    }

    matches.push({
      externalId: ent.externalId,
      sourceKey: ent.sourceKey,
      matchedName: bestName,
      aliasQuality: bestQuality,
      score: Number(display.toFixed(4)),
      nameScore: Number(best.toFixed(4)),
      entityCountry: ent.country,
      countryMatch,
      listVersion: ent.listVersion,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}
