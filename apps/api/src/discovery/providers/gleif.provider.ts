import { createHash } from 'node:crypto';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from '../provider-contract';
import type { GleifRecord, GleifParent } from '../../adapters/gleif';
import type { GleifFetchInput, GleifFetchOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { normForMatch, pickBestByName } from '../name-match';
import { ELF_LABELS } from '../elf';

const PARSER_VERSION = 'gleif/v1';
const ACCEPT_THRESHOLD = 0.72; // 低于此不贴 LEI（宁缺毋滥，绝不贴错身份）
const AMBIGUITY_MARGIN = 0.1; // 最佳须比次佳高出此边距，否则视为歧义（多个同名实体）→ 不贴

/**
 * GLEIF 法律身份富集 Provider。对已归一公司按「名 + 国家」查 LEI，
 * 客户端做最佳匹配（规范化名 token 比对）+ 置信度门槛，命中才：
 *   贴 LEI + 官方法人名 + 法人形式(ELF 可读) + 实体/登记状态 + 直接/最终母公司。
 * 母子关系是核心增量：能识别目标是子公司/集团总部，供 ICP 与触达用。
 */
export class GleifEnrichmentProvider implements CompanyEnrichmentAdapter {
  readonly key = 'gleif';

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async enrichCompany(input: CompanyEnrichmentInput, ctx: ExecutionContext): Promise<EnrichmentResult> {
    // 收口②：gleif.fetch 是 required 工具——出网只经 Broker（source_policy/预算/限流/Trace 单点强制）。
    // 无 broker → 诚实降级返回 miss（不直连；生产 registry 注入）。
    const broker = this.deps?.broker;
    if (!broker) {
       
      console.warn('[gleif] broker unavailable, skip enrichment (no raw egress)');
      return miss();
    }
    const toolCtx: ToolContext = { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId };
    const country = input.country?.trim();
    // 搜索用**核心名**（剥法人后缀）放宽召回：GLEIF 存全称（"Siemens Aktiengesellschaft"），
    // 直接拿 "Siemens AG" 做 contains 过滤会漏掉真身。核心名 "siemens" 召回全部同名实体，
    // 再交给 pickBest + 歧义护栏挑突出者。
    const searchName = normForMatch(input.name) || input.name;
    let candidates: GleifRecord[];
    try {
      candidates = await searchLeiViaBroker(broker, { name: searchName, country, limit: 15 }, toolCtx);
    } catch {
      return miss();
    }
    if (!candidates.length && country) {
      // 国家过滤可能过严（登记地 ≠ 运营地）；放宽一次仅按名检索
      try {
        candidates = await searchLeiViaBroker(broker, { name: searchName, limit: 15 }, toolCtx);
      } catch {
        return miss();
      }
    }
    if (!candidates.length) return miss();

    const best = pickBest(input.name, candidates);
    // 门槛 + 歧义护栏：分数够高，且明显甩开次佳（否则是"一堆同前缀实体"，不敢贴）
    if (!best || best.score < ACCEPT_THRESHOLD || best.margin < AMBIGUITY_MARGIN) return miss();

    const rec = best.record;
    // 只在声明了母公司时才请求（省调用；未申报是常态）；单侧失败非致命（沿袭原 .catch(()=>null)）
    const [direct, ultimate] = await Promise.all([
      rec.hasDirectParent ? fetchParentViaBroker(broker, 'directParent', rec.lei, toolCtx) : Promise.resolve(null),
      rec.hasUltimateParent ? fetchParentViaBroker(broker, 'ultimateParent', rec.lei, toolCtx) : Promise.resolve(null),
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

/** LEI 检索经 Broker（gleif.fetch op=search）；错误上抛由调用点 miss()。 */
async function searchLeiViaBroker(
  broker: ExecutionBroker,
  params: { name: string; country?: string; limit?: number },
  ctx: ToolContext,
): Promise<GleifRecord[]> {
  const res = await broker.invoke<GleifFetchInput, GleifFetchOutput>('gleif.fetch', { op: 'search', ...params }, ctx);
  return res.data.records ?? [];
}

/** 母公司查询经 Broker（gleif.fetch op=directParent/ultimateParent）；失败返回 null（非致命）。 */
async function fetchParentViaBroker(
  broker: ExecutionBroker,
  op: 'directParent' | 'ultimateParent',
  lei: string,
  ctx: ToolContext,
): Promise<GleifParent | null> {
  try {
    const res = await broker.invoke<GleifFetchInput, GleifFetchOutput>('gleif.fetch', { op, lei }, ctx);
    return res.data.parent ?? null;
  } catch {
    return null;
  }
}

/** GLEIF 最佳匹配（薄封装共用 name-match）：返回 record + 分数 + margin（歧义护栏用）。 */
export function pickBest(
  queryName: string,
  candidates: GleifRecord[],
): { record: GleifRecord; score: number; margin: number } | null {
  const best = pickBestByName(queryName, candidates, (c) => c.legalName);
  return best ? { record: best.item, score: best.score, margin: best.margin } : null;
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
