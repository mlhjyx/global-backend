import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';

export interface UnderstandingInput {
  workspaceId: string;
  companyId: string;
  website: string;
}

interface ExtractedClaim {
  type: string;
  statement: string;
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

    async crawlWebsite(website: string): Promise<{ url: string; rawHtml: string }> {
      // STUB → WebCrawlerProvider (Crawl4AI/Firecrawl)
      return { url: website, rawHtml: `<html><body>Stub content for ${website}</body></html>` };
    },

    async parseContent(raw: { url: string; rawHtml: string }): Promise<{ text: string }> {
      // STUB → DocumentParserProvider (Docling)
      return { text: `Parsed text from ${raw.url}` };
    },

    async extractClaims(args: { workspaceId: string; text: string }): Promise<{ claims: ExtractedClaim[] }> {
      const result = await deps.gateway.generateStructured(
        {
          task: 'company_understanding.extract_claims',
          prompt: args.text,
          schema: { required: ['claims'] },
        },
        { workspaceId: args.workspaceId },
      );
      const fromModel = (result.data as { claims?: ExtractedClaim[] })?.claims;
      // Stub gateway returns { claims: null }; synthesize a deterministic sample
      // so the loop is observable end-to-end until a real model is registered.
      const claims: ExtractedClaim[] = Array.isArray(fromModel)
        ? fromModel
        : [{ type: 'capability', statement: 'Stub-extracted capability claim', confidence: 0.5 }];
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
          await tx.claim.create({
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
        }
      });
    },
  };
}

export type UnderstandingActivities = ReturnType<typeof createUnderstandingActivities>;
