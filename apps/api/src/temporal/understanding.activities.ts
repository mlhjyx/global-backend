import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';

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
      // STUB（真实感样例，Crawl4AI 接上前先这样）→ WebCrawlerProvider
      const sample = `<html><body>
        <h1>Shenzhen Acme Tech Co., Ltd.</h1>
        <p>专注新能源逆变器与储能系统的研发与制造，产品通过 ISO 9001 质量体系认证与 CE 认证。</p>
        <p>起订量 MOQ 500 台，标准交期 30 天，支持 OEM/ODM 定制。</p>
        <p>产品出口欧洲、东南亚与中东，已服务 20+ 海外分销商，提供两年质保。</p>
      </body></html>`;
      return { url: website, rawHtml: sample };
    },

    async parseContent(raw: { url: string; rawHtml: string }): Promise<{ text: string }> {
      // STUB → DocumentParserProvider (Docling)。先朴素去标签。
      const text = raw.rawHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { text };
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
