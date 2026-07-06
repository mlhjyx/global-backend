import { createHash } from 'node:crypto';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
} from '../provider-contract';
import { searchLeiRecords, getDirectParent, getUltimateParent, GleifRecord } from '../../adapters/gleif';
import { normalizeCompanyName } from '../identity';
import { ELF_LABELS } from '../elf';

const PARSER_VERSION = 'gleif/v1';
const ACCEPT_THRESHOLD = 0.72; // 低于此不贴 LEI（宁缺毋滥，绝不贴错身份）
const AMBIGUITY_MARGIN = 0.1; // 最佳须比次佳高出此边距，否则视为歧义（多个同名实体）→ 不贴

/**
 * 拼写全称的法人形式词（缩写由 identity.normalizeCompanyName 处理）。剥掉它们让
 * "Siemens AG" 与 "Siemens Aktiengesellschaft" 归到同一 key，真身脱颖而出。
 */
const EXTRA_LEGAL_TOKENS = new Set([
  'aktiengesellschaft', 'kommanditgesellschaft', 'gesellschaft', 'mbh', 'kgaa',
  'mit', 'beschränkter', 'beschrankter', 'haftung', 'societas', 'europaea',
  'incorporated', 'corporation', 'und', 'and',
]);

/** GLEIF 名称匹配专用归一：基础归一 + 剥拼写全称法人词（先 NFC 防组合变音符裂词）。 */
function normForMatch(name: string): string {
  return normalizeCompanyName(name.normalize('NFC'))
    .split(' ')
    .filter((t) => t && !EXTRA_LEGAL_TOKENS.has(t))
    .join(' ');
}

/**
 * GLEIF 法律身份富集 Provider。对已归一公司按「名 + 国家」查 LEI，
 * 客户端做最佳匹配（规范化名 token 比对）+ 置信度门槛，命中才：
 *   贴 LEI + 官方法人名 + 法人形式(ELF 可读) + 实体/登记状态 + 直接/最终母公司。
 * 母子关系是核心增量：能识别目标是子公司/集团总部，供 ICP 与触达用。
 */
export class GleifEnrichmentProvider implements CompanyEnrichmentAdapter {
  readonly key = 'gleif';

  async enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult> {
    const country = input.country?.trim();
    // 搜索用**核心名**（剥法人后缀）放宽召回：GLEIF 存全称（"Siemens Aktiengesellschaft"），
    // 直接拿 "Siemens AG" 做 contains 过滤会漏掉真身。核心名 "siemens" 召回全部同名实体，
    // 再交给 pickBest + 歧义护栏挑突出者。
    const searchName = normForMatch(input.name) || input.name;
    let candidates: GleifRecord[];
    try {
      candidates = await searchLeiRecords({ name: searchName, country, limit: 15 });
    } catch {
      return miss();
    }
    if (!candidates.length && country) {
      // 国家过滤可能过严（登记地 ≠ 运营地）；放宽一次仅按名检索
      try {
        candidates = await searchLeiRecords({ name: searchName, limit: 15 });
      } catch {
        return miss();
      }
    }
    if (!candidates.length) return miss();

    const best = pickBest(input.name, candidates);
    // 门槛 + 歧义护栏：分数够高，且明显甩开次佳（否则是"一堆同前缀实体"，不敢贴）
    if (!best || best.score < ACCEPT_THRESHOLD || best.margin < AMBIGUITY_MARGIN) return miss();

    const rec = best.record;
    // 只在声明了母公司时才请求（省调用；未申报是常态）
    const [direct, ultimate] = await Promise.all([
      rec.hasDirectParent ? getDirectParent(rec.lei).catch(() => null) : Promise.resolve(null),
      rec.hasUltimateParent ? getUltimateParent(rec.lei).catch(() => null) : Promise.resolve(null),
    ]);

    const attributes: Record<string, unknown> = {
      lei: rec.lei,
      legal_name: rec.legalName,
      legal_form: rec.legalFormId ? (ELF_LABELS[rec.legalFormId] ?? rec.legalFormId) : undefined,
      legal_form_code: rec.legalFormId,
      entity_status: rec.entityStatus,
      registration_status: rec.registrationStatus,
      registered_country: rec.country,
      registered_city: rec.city,
      match_confidence: Number(best.score.toFixed(2)),
    };
    if (direct) {
      attributes.parent_lei = direct.lei;
      attributes.parent_name = direct.legalName;
      attributes.is_subsidiary = true;
    }
    if (ultimate && ultimate.lei !== rec.lei) {
      attributes.ultimate_parent_lei = ultimate.lei;
      attributes.ultimate_parent_name = ultimate.legalName;
    }

    return {
      matched: true,
      confidence: best.score,
      attributes: prune(attributes),
      provenance: {
        sourceUrl: `https://search.gleif.org/#/record/${rec.lei}`,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(`${rec.lei}:${rec.legalName}`).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}

/**
 * 从候选里挑规范化名最相似的一条。返回最佳分与 margin（最佳 − 次佳），
 * 供调用方做歧义护栏：一堆同前缀实体会挤在同一分段，margin 很小 → 应弃。
 */
export function pickBest(
  queryName: string,
  candidates: GleifRecord[],
): { record: GleifRecord; score: number; margin: number } | null {
  const q = normForMatch(queryName);
  const qTokens = new Set(q.split(' ').filter(Boolean));
  if (!qTokens.size) return null;

  const scored: { record: GleifRecord; score: number }[] = [];
  for (const c of candidates) {
    const n = normForMatch(c.legalName);
    const nTokens = new Set(n.split(' ').filter(Boolean));
    if (!nTokens.size) continue;
    scored.push({ record: c, score: nameScore(q, qTokens, n, nTokens) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const margin = scored[0].score - (scored[1]?.score ?? 0);
  return { record: scored[0].record, score: scored[0].score, margin };
}

/**
 * 规范化名相似度：精确=1；**查询完全被候选包含**（候选更具体，如 "trumpf laser" ⊂
 * "trumpf laser se"）给子集加权，多出的 token 每个扣 0.05；否则（含"候选更泛"）按 Jaccard。
 * 只对"候选更具体"加权，避免泛名（"TRUMPF" 集团）对具体查询制造假高分/假并列。
 */
function nameScore(q: string, qTokens: Set<string>, n: string, nTokens: Set<string>): number {
  if (q === n) return 1;
  const inter = [...qTokens].filter((t) => nTokens.has(t)).length;
  const union = qTokens.size + nTokens.size - inter;
  const jaccard = inter / union;
  if (inter === qTokens.size && qTokens.size > 0) {
    const extra = nTokens.size - qTokens.size; // 候选比查询多出的 token 数
    return Math.max(0.85 - extra * 0.05, jaccard);
  }
  return jaccard;
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
