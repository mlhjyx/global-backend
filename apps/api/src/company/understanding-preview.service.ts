import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';

/**
 * 理解预览（注册即建档第 1 步，2026-11-10）：把一次真实 understanding run 的
 * 已落库结果读成客户可勾选的候选。**只读**：不新增 AI Task、不出网、不消费预算，
 * 因此不触 execution-authority 的封闭清单。
 *
 * 数据来源：
 * - 状态/失败：company_profile.status + understanding_failed_at/last_error
 * - 已分析页数：knowledge_source(type=website) 行数（有内容并被解析的页）
 * - 行业建议：profile.industry（extract_profile 回填的自由文本）→ term_alias 精确/子串归一到
 *   canonical_taxonomy(kind=industry)；归不上就只给原文，由客户从受控词表选。
 * - 产品建议：offering（理解抽取，带来源页 URL 与原文片段）
 * - 市场建议：summary/claim 陈述里确定性识别出的国家名（中英德别名），命中才建议并附原句；
 *   不按「总部国家 + 邻国」编造。
 */

export interface IndustryOption {
  code: string;
  labelEn: string;
  label: string;
  labels: Record<string, string>;
  parentCode: string | null;
  nace: string[];
}

export interface IndustrySuggestion {
  raw: string | null;
  code: string | null;
  label: string | null;
  labelEn: string | null;
  matched: boolean;
}

export interface UnderstandingPreview {
  companyId: string;
  name: string;
  website: string | null;
  status: string;
  state: 'not_started' | 'queued' | 'running' | 'ready' | 'failed';
  failure: { stage: string; code: string } | null;
  pagesAnalyzed: number;
  industry: { raw: string | null; suggested: IndustrySuggestion; options: IndustryOption[] };
  products: { name: string; source: string | null; sourceUrl: string | null; evidence: string | null }[];
  markets: {
    code: string;
    name: string;
    labelEn: string;
    labels: Record<string, string>;
    evidence: string;
    sourceUrl: string | null;
  }[];
  updatedAt: string;
}

const CJK = /[㐀-鿿豈-﫿]/u;

function normalizeTerm(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 别名命中：CJK 用子串；拉丁文要求词边界。industry 额外允许 ≥4 字符的子串
 * （德语复合词 Kreiselpumpen 要命中 pump）；**国家不允许子串**——Romania 里的
 * "oman"、Nigeria 里的 "niger"、Somalia 里的 "mali" 都是系统性误报。
 * 拉丁别名一律要求 ≥4 字符，避免 "contact us"/"can"/"are" 这类 2–3 字母码误报。
 */
function aliasMention(
  text: string,
  alias: string,
  minLatinLength: number,
  allowSubstring = false,
): boolean {
  if (!alias) return false;
  if (CJK.test(alias)) return alias.length >= 2 && text.includes(alias);
  if (alias.length < minLatinLength) return false;
  const bounded = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}([^\\p{L}\\p{N}]|$)`,
    'u',
  );
  if (bounded.test(text)) return true;
  return allowSubstring && alias.length >= 4 && text.includes(alias);
}

/** 官网 host（去 www）；无法解析返回 null。 */
function siteHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** 溯源 URL 与当前官网同站才收；没有溯源（注册引导事实）保留。 */
function belongsToSite(sourceUrl: string | null | undefined, host: string | null): boolean {
  if (!host) return true;
  if (!sourceUrl) return true;
  return siteHost(sourceUrl) === host;
}

function stateOf(company: {
  status: string;
  website: string | null;
  understandingFailedAt: Date | null;
}): UnderstandingPreview['state'] {
  if (company.status === 'ENRICHING') return 'running';
  if (company.status === 'REVIEW' || company.status === 'ACTIVE') return 'ready';
  if (company.understandingFailedAt) return 'failed';
  return company.website ? 'queued' : 'not_started';
}

function parseFailure(lastError: string | null): { stage: string; code: string } | null {
  if (!lastError) return null;
  const index = lastError.indexOf(':');
  return index <= 0
    ? { stage: lastError, code: 'UNKNOWN' }
    : { stage: lastError.slice(0, index), code: lastError.slice(index + 1) };
}

function toOption(node: {
  code: string;
  labelEn: string;
  labels: unknown;
  parentCode: string | null;
  crosswalks: unknown;
}): IndustryOption {
  const labels = (node.labels as Record<string, string> | null) ?? {};
  const nace = ((node.crosswalks as { nace?: string[] } | null)?.nace ?? []).slice(0, 8);
  return {
    code: node.code,
    labelEn: node.labelEn,
    label: labels.zh ?? labels.de ?? node.labelEn,
    labels,
    parentCode: node.parentCode,
    nace,
  };
}

interface TaxonomyRow {
  code: string;
  labelEn: string;
  labels: unknown;
  parentCode: string | null;
  crosswalks: unknown;
}

interface AliasRow {
  term: string;
  code: string;
}

/**
 * 词表是 seed 出来的静态平台数据；前端每 4s 轮询一次预览，不缓存会把
 * ~1000 条国家别名反复拉取。60s 过期足够短，seed 变更最迟一分钟生效。
 */
const TAXONOMY_TTL_MS = 60_000;

@Injectable()
export class UnderstandingPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  private taxonomyCache:
    | {
        at: number;
        industryNodes: TaxonomyRow[];
        industryAliases: AliasRow[];
        countryAliases: AliasRow[];
        countryNodes: TaxonomyRow[];
      }
    | null = null;

  async get(ctx: RequestContext, companyId: string): Promise<UnderstandingPreview> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      }

      const [pageRows, taxonomy, offerings, claims] = await Promise.all([
        tx.knowledgeSource.findMany({
          where: { companyId, type: 'website' },
          select: { uri: true },
          distinct: ['uri'],
        }),
        this.taxonomy(tx),
        tx.offering.findMany({
          where: { companyId },
          select: { name: true, source: true, sourceUrl: true, evidence: true },
          orderBy: { createdAt: 'asc' },
          take: 12,
        }),
        tx.claim.findMany({
          where: { companyId, status: { not: 'REVOKED' } },
          select: {
            type: true,
            statement: true,
            evidence: { select: { sourceUrl: true }, take: 1 },
          },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
      ]);
      const { industryNodes, industryAliases } = taxonomy;
      // 换官网重试时旧站点的理解结果仍在库里（run 的落库数据不按站点清理）：
      // 只保留与当前官网同站的溯源，避免把 A 站的产品/市场混进 B 站的预览。
      const host = siteHost(company.website);

      // 重试会让同一页在不同 run 下各留一行（ingestKey=runId:url），按 URI 去重才是"已分析页数"。
      const pagesAnalyzed = pageRows.filter(
        (row) => Boolean(row.uri) && belongsToSite(row.uri, host),
      ).length;
      const options = industryNodes.map(toOption);
      const suggested = this.suggestIndustry(
        company.industry,
        company.industryCode,
        options,
        industryAliases,
      );
      const products = offerings
        .filter((row) => belongsToSite(row.sourceUrl, host))
        .map((row) => ({
          name: row.name,
          source: row.source,
          sourceUrl: row.sourceUrl,
          evidence: row.evidence,
        }));
      const markets = this.suggestMarkets(
        taxonomy.countryAliases,
        taxonomy.countryNodes,
        company.summary,
        claims.filter((claim) => belongsToSite(claim.evidence[0]?.sourceUrl, host)),
      );

      return {
        companyId: company.id,
        name: company.name,
        website: company.website,
        status: company.status,
        state: stateOf(company),
        failure: parseFailure(company.understandingLastError),
        pagesAnalyzed,
        industry: { raw: company.industry, suggested, options },
        products,
        markets,
        updatedAt: company.updatedAt.toISOString(),
      };
    });
  }

  private suggestIndustry(
    raw: string | null,
    storedCode: string | null,
    options: IndustryOption[],
    aliases: { term: string; code: string }[],
  ): IndustrySuggestion {
    const empty: IndustrySuggestion = {
      raw,
      code: null,
      label: null,
      labelEn: null,
      matched: false,
    };
    if (storedCode) {
      const option = options.find((row) => row.code === storedCode);
      if (option) {
        return {
          raw,
          code: option.code,
          label: option.label,
          labelEn: option.labelEn,
          matched: true,
        };
      }
    }
    if (!raw) return empty;
    const term = normalizeTerm(raw);

    const fromAlias = (code: string): IndustrySuggestion | null => {
      const option = options.find((row) => row.code === code);
      if (!option) return null;
      return {
        raw,
        code: option.code,
        label: option.label,
        labelEn: option.labelEn,
        matched: true,
      };
    };

    for (const alias of aliases) {
      if (normalizeTerm(alias.term) === term) {
        const hit = fromAlias(alias.code);
        if (hit) return hit;
      }
    }
    for (const option of options) {
      const labels = [option.labelEn, ...Object.values(option.labels)].map(normalizeTerm);
      if (labels.includes(term) && term.length > 0) {
        return { raw, code: option.code, label: option.label, labelEn: option.labelEn, matched: true };
      }
    }
    let best: { code: string; length: number } | null = null;
    for (const alias of aliases) {
      const aliasTerm = normalizeTerm(alias.term);
      // 行业允许子串（德语复合词/口语），仍要求拉丁 ≥4 字符。
      if (!aliasMention(term, aliasTerm, 4, true)) continue;
      if (!best || aliasTerm.length > best.length) {
        best = { code: alias.code, length: aliasTerm.length };
      }
    }
    return (best && fromAlias(best.code)) || empty;
  }

  /** summary + claim 陈述里的国家名 → 候选市场；每条附命中原句与来源页。 */
  private suggestMarkets(
    aliases: AliasRow[],
    nodes: TaxonomyRow[],
    summary: string | null,
    claims: { type: string; statement: string; evidence: { sourceUrl: string | null }[] }[],
  ): UnderstandingPreview['markets'] {
    if (aliases.length === 0) return [];
    const texts: { text: string; sourceUrl: string | null }[] = [
      ...(summary ? [{ text: summary, sourceUrl: null }] : []),
      ...claims.map((claim) => ({
        text: claim.statement,
        sourceUrl: claim.evidence[0]?.sourceUrl ?? null,
      })),
    ];
    const hits = new Map<string, { evidence: string; sourceUrl: string | null; length: number }>();
    for (const { text, sourceUrl } of texts) {
      const normalized = normalizeTerm(text);
      for (const alias of aliases) {
        const aliasTerm = normalizeTerm(alias.term);
        // 国家只认词边界：Romania/Nigeria/Somalia 不能顺带命中 Oman/Niger/Mali。
        if (!aliasMention(normalized, aliasTerm, 4)) continue;
        const prior = hits.get(alias.code);
        if (!prior || aliasTerm.length > prior.length) {
          hits.set(alias.code, {
            evidence: text.length > 160 ? `${text.slice(0, 160)}…` : text,
            sourceUrl: sourceUrl ?? prior?.sourceUrl ?? null,
            length: aliasTerm.length,
          });
        }
      }
    }
    if (hits.size === 0) return [];
    return [...hits.entries()]
      .slice(0, 6)
      .map(([code, hit]) => {
        const node = nodes.find((row) => row.code === code);
        const labels = (node?.labels as Record<string, string> | null) ?? {};
        const labelEn = node?.labelEn ?? code;
        return {
          code,
          name: labels.zh ?? labelEn,
          labelEn,
          labels,
          evidence: hit.evidence,
          sourceUrl: hit.sourceUrl,
        };
      });
  }

  /** 受控词表（行业节点/别名 + 国家节点/别名）的短 TTL 缓存。 */
  private async taxonomy(tx: Prisma.TransactionClient) {
    const now = Date.now();
    if (this.taxonomyCache && now - this.taxonomyCache.at < TAXONOMY_TTL_MS) {
      return this.taxonomyCache;
    }
    const [industryNodes, industryAliases, countryAliases, countryNodes] = await Promise.all([
      tx.canonicalTaxonomy.findMany({
        where: { kind: 'industry' },
        select: {
          code: true,
          labelEn: true,
          labels: true,
          parentCode: true,
          crosswalks: true,
        },
        orderBy: { code: 'asc' },
      }),
      tx.termAlias.findMany({
        where: { kind: 'industry' },
        select: { term: true, code: true },
      }),
      tx.termAlias.findMany({
        where: { kind: 'country' },
        select: { term: true, code: true },
      }),
      tx.canonicalTaxonomy.findMany({
        where: { kind: 'country' },
        select: { code: true, labelEn: true, labels: true, parentCode: true, crosswalks: true },
      }),
    ]);
    this.taxonomyCache = {
      at: now,
      industryNodes,
      industryAliases,
      countryAliases,
      countryNodes,
    };
    return this.taxonomyCache;
  }
}
