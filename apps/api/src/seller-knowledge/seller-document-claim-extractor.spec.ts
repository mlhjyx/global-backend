import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import { documentClaimQuoteBytes, verifyDocumentClaimReference } from '../claim/document-claim-basis';
import {
  extractDeterministicDocumentClaims,
  locateQuoteByteRange,
  proposeDocumentClaimCandidates,
} from './seller-document-claim-extractor';
import { SellerDocumentClaimsService } from './seller-document-claims.service';

const W = '10000000-0000-4000-8000-000000000001';
const C = '20000000-0000-4000-8000-000000000002';
const D = '30000000-0000-4000-8000-000000000003';
const U = '40000000-0000-4000-8000-000000000004';
const CTX: RequestContext = { workspaceId: W, userId: U, roles: ['MEMBER'], scopes: ['acquisition:write'] };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const LIANSHENG_BROCHURE = [
  '琏升光伏（Liansheng PV）拥有 8 GW 年产能异质结（HJT）N-type 高效电池与双面组件自动化生产线。',
  'All 600W-720W bifacial HJT modules are certified to IEC 61215, IEC 61730 and TÜV Rheinland standards.',
  'Module conversion efficiency reaches 23.2% with -0.24%/°C temperature coefficient and 30-year linear warranty.',
  'MOQ is 1x40HQ container with 3 weeks lead time from EU Rotterdam warehouse stock.',
  'Products are exported to Germany, Italy, Spain and Brazil for C&I and utility-scale EPC projects.',
].join('\n');

describe('S2 seller document claim extractor', () => {
  it('locates exact UTF-8 byte offsets for multi-byte CJK and symbol quotes', () => {
    const target = '23.2% with -0.24%/°C temperature coefficient';
    const located = locateQuoteByteRange(LIANSHENG_BROCHURE, target);
    expect(located).not.toBeNull();
    const verified = documentClaimQuoteBytes(LIANSHENG_BROCHURE, located!.quoteStartByte, located!.quoteEndByte);
    expect(verified.quote).toBe(target);
    expect(locateQuoteByteRange(LIANSHENG_BROCHURE, 'hallucinated text not in chunk')).toBeNull();
  });

  it('extracts multi-category verifiable B2B facts across mixed Chinese/English brochure chunks', () => {
    const candidates = extractDeterministicDocumentClaims(LIANSHENG_BROCHURE);
    const types = new Set(candidates.map((item) => item.type));
    expect(types.has('capability')).toBe(true);
    expect(types.has('certification')).toBe(true);
    expect(types.has('param')).toBe(true);
    expect(types.has('moq')).toBe(true);
    expect(types.has('market')).toBe(true);

    const contentHash = sha(LIANSHENG_BROCHURE);
    const doc = { id: D, workspaceId: W, companyId: C, contentHash, parseRevision: 1, status: 'ready', deletedAt: null };
    const chunk = { documentId: D, seq: 0, text: LIANSHENG_BROCHURE };
    for (const candidate of candidates) {
      const verified = verifyDocumentClaimReference({
        document: doc,
        chunk,
        evidenceSnippet: candidate.quote,
        reference: {
          documentId: D,
          documentContentHash: contentHash,
          parseRevision: 1,
          chunkSeq: 0,
          chunkTextHash: sha(LIANSHENG_BROCHURE),
          quoteStartByte: candidate.quoteStartByte,
          quoteEndByte: candidate.quoteEndByte,
        },
        context: { workspaceId: W, companyId: C },
      });
      expect(verified.quote).toBe(candidate.quote);
    }
  });

  it('drops ungrounded model suggestions while preserving byte-anchored suggestions', () => {
    const result = proposeDocumentClaimCandidates(LIANSHENG_BROCHURE, [
      {
        type: 'certification',
        statement: 'HJT modules hold IEC 61215, IEC 61730 and TÜV Rheinland certification.',
        quote: 'certified to IEC 61215, IEC 61730 and TÜV Rheinland standards.',
        confidence: 0.96,
      },
      {
        type: 'certification',
        statement: 'Fake NASA space rating',
        quote: 'certified by NASA for Mars rovers',
        confidence: 0.99,
      },
      {
        type: 'invalid type with spaces!',
        statement: 'Bad type',
        quote: 'MOQ is 1x40HQ container',
      },
    ]);
    expect(result.droppedModelSuggestions).toBe(2);
    expect(result.candidates[0]).toMatchObject({
      type: 'certification',
      extractionSource: 'model_verified',
      statement: 'HJT modules hold IEC 61215, IEC 61730 and TÜV Rheinland certification.',
    });
  });

  it('SellerDocumentClaimsService.suggestClaimCandidates & createAssistedDrafts keep every draft in NEEDS_REVIEW', async () => {
    const contentHash = sha(LIANSHENG_BROCHURE);
    const docRow = {
      id: D,
      workspaceId: W,
      companyId: C,
      contentHash,
      parseRevision: 1,
      status: 'ready',
      deletedAt: null,
      kind: 'pdf',
    };
    const chunkRow = { documentId: D, seq: 0, text: LIANSHENG_BROCHURE, meta: { page: 2 } };
    const createdClaims: Array<Record<string, unknown>> = [];
    const tx = {
      sellerDocument: { findFirst: vi.fn(async () => docRow) },
      sellerDocumentChunk: {
        findMany: vi.fn(async () => [chunkRow]),
        findFirst: vi.fn(async () => chunkRow),
      },
      $queryRaw: vi.fn(async () => [{ id: D }]),
      claim: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdClaims.push(data);
          return { id: `claim-${createdClaims.length}`, version: 1, status: data.status };
        }),
      },
      knowledgeSource: { create: vi.fn(async () => ({ id: 'src-1' })) },
      evidence: { create: vi.fn(async () => ({ id: 'ev-1' })) },
      claimDocumentEvidence: { create: vi.fn(async () => ({ id: 'ref-1' })) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new SellerDocumentClaimsService(prisma as unknown as PrismaService);

    const out = await service.createAssistedDrafts(CTX, C, D, { maxCandidates: 3 });
    expect(out.scannedChunks).toBe(1);
    expect(out.drafts).toHaveLength(3);
    expect(createdClaims).toHaveLength(3);
    for (const claim of createdClaims) {
      expect(claim.status).toBe('NEEDS_REVIEW');
    }
    for (const draft of out.drafts) {
      expect(draft.status).toBe('NEEDS_REVIEW');
      expect(draft.bindingHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});
