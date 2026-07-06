import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { crawlUrl } from '../adapters/web-crawler';

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

/**
 * Activities do the real (side-effectful) work — DB writes go through
 * withWorkspace so RLS confines them to the tenant. Crawl/parse are stubs today;
 * they get replaced by WebCrawlerProvider (Crawl4AI) and DocumentParserProvider
 * (Docling) without touching the workflow. Extraction already runs through the
 * ModelGateway (stub provider now, real model later — no code change).
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

    async crawlWebsite(website: string): Promise<{ url: string; text: string }> {
      // Real crawl via Crawl4AI (WebCrawlerProvider). Returns extracted markdown.
      const result = await crawlUrl(website);
      return { url: website, text: result.text };
    },

    async parseContent(raw: { url: string; text: string }): Promise<{ text: string }> {
      // Website path: Crawl4AI already returns extracted text. Docling is for
      // UPLOADED documents (PDF/DOCX/PPTX) — a separate ingestion path (KNW-001).
      return { text: raw.text };
    },

    async extractClaims(args: { workspaceId: string; text: string }): Promise<{ claims: ExtractedClaim[] }> {
      // Driven by the AI Task Contract: its schema shapes the output, its
      // modelPolicy decides which vendor the router prefers (business-need routing).
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

    async persistClaims(args: UnderstandingInput & { claims: ExtractedClaim[] }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const source = await tx.knowledgeSource.create({
          data: {
            workspaceId: args.workspaceId,
            companyId: args.companyId,
            type: 'website',
            uri: args.website,
            status: 'PARSED',
          },
        });
        for (const c of args.claims) {
          const claim = await tx.claim.create({
            data: {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              sourceId: source.id,
              type: c.type,
              statement: c.statement,
              status: 'NEEDS_REVIEW', // human Gate before ACTIVE outbound use
              confidence: c.confidence,
            },
          });
          // Field-level Evidence (PRD 7.4.9 / P-04): each fact traces back to the
          // real source URL + the supporting snippet — 事实 vs 推断 的关键区别。
          await tx.evidence.create({
            data: {
              workspaceId: args.workspaceId,
              claimId: claim.id,
              sourceUrl: args.website,
              snippet: c.evidence ?? null,
              confidence: c.confidence,
              fetchedAt: new Date(),
            },
          });
        }
      });
    },
  };
}

export type UnderstandingActivities = ReturnType<typeof createUnderstandingActivities>;
