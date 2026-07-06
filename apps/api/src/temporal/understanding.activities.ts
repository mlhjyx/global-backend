import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { crawlUrl } from '../adapters/web-crawler';
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
}) {
  return {
    async setStatus(args: {
      companyId: string;
      workspaceId: string;
      status: 'ENRICHING' | 'ACTIVE';
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.companyProfile.update({
          where: { id: args.companyId },
          data: { status: args.status },
        }),
      );
    },

    async crawlWebsite(website: string): Promise<CrawledPage> {
      const result = await crawlUrl(website);
      return { url: website, text: result.text.slice(0, MAX_PAGE_CHARS) };
    },

    /** Deterministic: pick key subpages (products/about/certifications/cases/contact…). */
    async selectSubpages(args: { markdown: string; website: string }): Promise<string[]> {
      const links = extractSameSiteLinks(args.markdown, args.website);
      return selectKeySubpages(links, MAX_SUBPAGES);
    },

    /** Crawl subpages, tolerating individual failures — a broken page must not kill the run. */
    async crawlPages(urls: string[]): Promise<{ pages: CrawledPage[] }> {
      const settled = await Promise.allSettled(urls.map((u) => crawlUrl(u)));
      const pages: CrawledPage[] = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value.text.trim()) {
          pages.push({ url: urls[i], text: s.value.text.slice(0, MAX_PAGE_CHARS) });
        } else if (s.status === 'rejected') {
          // eslint-disable-next-line no-console
          console.warn(`[understanding] subpage crawl failed ${urls[i]}: ${String(s.reason).slice(0, 200)}`);
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
      let claimCount = 0;
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const byStatement = new Map<string, string>(); // normalized statement → claim id
        for (const page of args.pages) {
          if (!page.claims.length) continue;
          const source = await tx.knowledgeSource.create({
            data: {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              type: 'website',
              uri: page.url,
              status: 'PARSED',
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
