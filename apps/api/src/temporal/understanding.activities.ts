import { Context } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import type { CrawlResult } from '../adapters/web-crawler';
import type { ExecutionBroker } from '../tools/tool-contract';
import { extractSameSiteLinks, selectKeySubpages } from '../adapters/site-links';
import { extractPublicContacts } from '../adapters/contact-extractor';

export interface UnderstandingInput {
  workspaceId: string;
  companyId: string;
  website: string;
}

interface ExtractedClaim {
  type: string;
  statement: string;
  evidence?: string; // 源文本中支持该结论的原文片段（溯源）
  confidence: number;
}

interface ExtractedOffering {
  name: string;
  description?: string;
  attributes?: Record<string, unknown>;
  evidence?: string;
  confidence: number;
}

export interface CrawledPage {
  url: string;
  text: string;
}

/** Keep Temporal payloads bounded — a page beyond this adds noise, not facts. */
const MAX_PAGE_CHARS = 40_000;
const MAX_SUBPAGES = 6;

/**
 * Activities do the real (side-effectful) work — DB writes go through
 * withWorkspace so RLS confines them to the tenant. Crawling runs on Crawl4AI
 * (WebCrawlerProvider); extraction runs through the ModelGateway with the model
 * chosen per AI Task Contract. Docling handles UPLOADED documents in a separate
 * ingestion path (KNW-001) — not here.
 */
export function createUnderstandingActivities(deps: {
  prisma: PrismaService;
  gateway: ModelGateway;
  /** 收口②：页面抓取经 ToolBroker（crawl4ai.fetch，白名单绑定 extract_claims 契约）。 */
  broker?: ExecutionBroker;
}) {
  const crawlViaBroker = async (workspaceId: string, url: string): Promise<string> => {
    if (!deps.broker) throw new Error('understanding: broker unavailable (fail-closed, no raw egress)');
    const r = await deps.broker.invoke<{ url: string }, CrawlResult>(
      'crawl4ai.fetch',
      { url },
      // FIX C（Codex P1）：显式声明 discovery/enrichment 用途——crawl4ai.fetch 追加 site_builder 后，
      // 不带 purpose 会 fallback 到扩宽全集，令仅授权 site_builder 的域连带放行；显式声明精确复现变更前有效集。
      {
        workspaceId,
        taskContractId: 'company_understanding.extract_claims',
        correlationId: url,
        purpose: ['discovery', 'enrichment'],
      },
    );
    return r.data.text;
  };

  return {
    async setStatus(args: {
      companyId: string;
      workspaceId: string;
      status: 'ENRICHING' | 'REVIEW' | 'ACTIVE';
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.companyProfile.update({
          where: { id: args.companyId },
          data: { status: args.status },
        }),
      );
    },

    async crawlWebsite(args: { workspaceId: string; website: string }): Promise<CrawledPage> {
      const text = await crawlViaBroker(args.workspaceId, args.website);
      return { url: args.website, text: text.slice(0, MAX_PAGE_CHARS) };
    },

    /** Deterministic: pick key subpages (products/about/certifications/cases/contact…). */
    async selectSubpages(args: { markdown: string; website: string }): Promise<string[]> {
      const links = extractSameSiteLinks(args.markdown, args.website);
      return selectKeySubpages(links, MAX_SUBPAGES);
    },

    /** Crawl subpages, tolerating individual failures — a broken page must not kill the run. */
    async crawlPages(args: { workspaceId: string; urls: string[] }): Promise<{ pages: CrawledPage[] }> {
      const settled = await Promise.allSettled(args.urls.map((u) => crawlViaBroker(args.workspaceId, u)));
      const pages: CrawledPage[] = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value.trim()) {
          pages.push({ url: args.urls[i], text: s.value.slice(0, MAX_PAGE_CHARS) });
        } else if (s.status === 'rejected') {

          console.warn(`[understanding] subpage crawl failed ${args.urls[i]}: ${String(s.reason).slice(0, 200)}`);
        }
      });
      return { pages };
    },

    async extractClaims(args: { workspaceId: string; text: string }): Promise<{ claims: ExtractedClaim[] }> {
      const contract = getTask('company_understanding.extract_claims');
      const result = await deps.gateway.generateStructured(
        {
          task: contract?.id ?? 'company_understanding.extract_claims',
          prompt: args.text,
          system: contract?.description,
          model: contract?.model, // 中转站解析该 model 名（DeepSeek 等）
          schema: contract?.outputSchema ?? { required: ['claims'] },
        },
        { workspaceId: args.workspaceId },
      );
      const fromModel = (result.data as { claims?: ExtractedClaim[] })?.claims;
      // Stub gateway returns { claims: null }; synthesize a deterministic sample
      // so the loop is observable end-to-end until a real model is registered.
      const claims: ExtractedClaim[] = Array.isArray(fromModel)
        ? fromModel
        : [{ type: 'capability', statement: 'Stub-extracted capability claim', evidence: '(stub)', confidence: 0.5 }];
      return { claims };
    },

    /** 画像回填（KNW-002/5.2.3）：行业 + 简介，只在首页文本上跑一次。 */
    async extractAndPersistProfile(args: UnderstandingInput & { text: string }): Promise<void> {
      const contract = getTask('company_understanding.extract_profile');
      const result = await deps.gateway.generateStructured(
        {
          task: contract?.id ?? 'company_understanding.extract_profile',
          prompt: args.text,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['industry', 'summary'] },
        },
        { workspaceId: args.workspaceId },
      );
      const out = result.data as { industry?: string; summary?: string };
      if (!out?.industry && !out?.summary) return; // stub/空输出不回填
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.companyProfile.update({
          where: { id: args.companyId },
          data: {
            ...(out.industry ? { industry: out.industry } : {}),
            ...(out.summary ? { summary: out.summary } : {}),
          },
        }),
      );
    },

    async extractOfferings(args: {
      workspaceId: string;
      text: string;
    }): Promise<{ offerings: ExtractedOffering[] }> {
      const contract = getTask('company_understanding.extract_offerings');
      const result = await deps.gateway.generateStructured(
        {
          task: contract?.id ?? 'company_understanding.extract_offerings',
          prompt: args.text,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['offerings'] },
        },
        { workspaceId: args.workspaceId },
      );
      const fromModel = (result.data as { offerings?: ExtractedOffering[] })?.offerings;
      return { offerings: Array.isArray(fromModel) ? fromModel : [] };
    },

    /**
     * Persist per-page claims. One knowledge_source per crawled page; every claim's
     * Evidence points at the actual page it came from (P-04 真实性). Cross-page
     * duplicates collapse into one claim with evidence from each page.
     */
    async persistClaims(
      args: UnderstandingInput & { pages: { url: string; claims: ExtractedClaim[] }[] },
    ): Promise<{ claimCount: number }> {
      // 幂等（PRD 11.16）：at-least-once 的活动重试不得重复写入。
      // 每页的 source+claims 在同一事务里原子落库，ingestKey = runId+页URL；
      // 已存在则整页跳过。
      const runId = Context.current().info.workflowExecution?.runId ?? Context.current().info.activityId;
      let claimCount = 0;
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        // KNW-004 冲突检测的对照集：本公司既有（其他来源/往次运行）的有效 Claim
        const priorClaims = await tx.claim.findMany({
          where: { companyId: args.companyId, status: { in: ['APPROVED', 'NEEDS_REVIEW'] } },
          select: { id: true, type: true, statement: true },
        });
        let conflictBudget = 20; // 防洪：单次运行最多报 20 组冲突
        const byStatement = new Map<string, string>(); // normalized statement → claim id
        for (const page of args.pages) {
          if (!page.claims.length) continue;
          const ingestKey = `${runId}:${page.url}`;
          const existing = await tx.knowledgeSource.findFirst({
            where: { companyId: args.companyId, ingestKey },
            select: { id: true },
          });
          if (existing) continue; // 本次运行已写过该页
          const source = await tx.knowledgeSource.create({
            data: {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              type: 'website',
              uri: page.url,
              status: 'PARSED',
              ingestKey,
            },
          });
          for (const c of page.claims) {
            const key = c.statement.toLowerCase().replace(/\s+/g, ' ').trim();
            let claimId = byStatement.get(key);
            if (!claimId) {
              const claim = await tx.claim.create({
                data: {
                  workspaceId: args.workspaceId,
                  companyId: args.companyId,
                  sourceId: source.id,
                  type: c.type,
                  statement: c.statement,
                  status: 'NEEDS_REVIEW', // human Gate before outbound use (KNW-003)
                  confidence: c.confidence,
                },
              });
              claimId = claim.id;
              byStatement.set(key, claimId);
              claimCount += 1;
              // KNW-004：与既有同类型 Claim 高度相似但不相同 → 冲突，供人工裁决，绝不静默覆盖
              const rival = priorClaims.find(
                (p) => p.type === c.type && p.statement !== c.statement && jaccard(p.statement, c.statement) >= 0.55,
              );
              if (rival && conflictBudget > 0) {
                conflictBudget -= 1;
                await tx.knowledgeConflict.create({
                  data: {
                    workspaceId: args.workspaceId,
                    companyId: args.companyId,
                    claimAId: rival.id,
                    claimBId: claim.id,
                    claimType: c.type,
                  },
                });
                await tx.outboxEvent.create({
                  data: {
                    workspaceId: args.workspaceId,
                    eventType: 'KnowledgeConflictDetected',
                    aggregateType: 'CompanyProfile',
                    aggregateId: args.companyId,
                    payload: { claimAId: rival.id, claimBId: claim.id, type: c.type },
                  },
                });
              }
            }
            await tx.evidence.create({
              data: {
                workspaceId: args.workspaceId,
                claimId,
                sourceUrl: page.url,
                snippet: c.evidence ?? null,
                confidence: c.confidence,
                fetchedAt: new Date(),
              },
            });
          }
        }
      });
      return { claimCount };
    },

    /** Merge per-page offerings by name and upsert (idempotent on re-runs). */
    async persistOfferings(
      args: UnderstandingInput & { pages: { url: string; offerings: ExtractedOffering[] }[] },
    ): Promise<{ offeringCount: number }> {
      const merged = new Map<string, ExtractedOffering & { sourceUrl: string }>();
      for (const page of args.pages) {
        for (const o of page.offerings) {
          if (!o.name?.trim()) continue;
          const key = o.name.toLowerCase().replace(/\s+/g, ' ').trim();
          const existing = merged.get(key);
          if (!existing || (o.confidence ?? 0) > (existing.confidence ?? 0)) {
            merged.set(key, { ...o, sourceUrl: page.url });
          }
        }
      }
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        for (const o of merged.values()) {
          await tx.offering.upsert({
            where: { companyId_name: { companyId: args.companyId, name: o.name } },
            update: {
              description: o.description ?? null,
              attributes: (o.attributes ?? undefined) as never,
              sourceUrl: o.sourceUrl,
              evidence: o.evidence ?? null,
              confidence: o.confidence,
            },
            create: {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              name: o.name,
              description: o.description ?? null,
              attributes: (o.attributes ?? undefined) as never,
              sourceUrl: o.sourceUrl,
              evidence: o.evidence ?? null,
              confidence: o.confidence,
            },
          });
        }
      });
      return { offeringCount: merged.size };
    },

    /**
     * Deterministic regex extraction of the company's own public contacts
     * (emails/phones/social) — no LLM, so every value verifiably exists on the
     * source page. Buyer Trust 原料 (PRD 7.15).
     */
    async persistPublicContacts(
      args: UnderstandingInput & { pages: CrawledPage[] },
    ): Promise<{ contactCount: number }> {
      const contacts = extractPublicContacts(args.pages);
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.companyProfile.update({
          where: { id: args.companyId },
          data: { publicContacts: contacts as never },
        }),
      );
      return { contactCount: contacts.length };
    },
  };
}

export type UnderstandingActivities = ReturnType<typeof createUnderstandingActivities>;

/** 词集 Jaccard 相似度（确定性冲突启发式，KNW-004）。 */
function jaccard(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    );
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}
