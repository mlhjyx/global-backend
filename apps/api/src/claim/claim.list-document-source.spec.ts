import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import { ClaimService } from './claim.service';
import { loadDocumentClaimBindingInTransaction } from './document-claim-basis';

vi.mock('./document-claim-basis', () => ({
  buildDocumentClaimApprovalProof: vi.fn(),
  loadDocumentClaimBindingInTransaction: vi.fn(),
}));

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const DOC_ID = '40000000-0000-4000-8000-000000000004';
const CLAIM_ID = '50000000-0000-4000-8000-000000000005';
const QUOTE = '合成设备 M-1 仅适用于室内。';

function claimRow(status: string) {
  return {
    id: CLAIM_ID,
    companyId: COMPANY_ID,
    type: 'certification',
    factKey: null,
    statement: QUOTE,
    status,
    confidence: null,
    version: 2,
    createdAt: new Date('2026-11-24T00:00:00Z'),
    evidence: [
      {
        id: '60000000-0000-4000-8000-000000000006',
        workspaceId: CTX.workspaceId,
        claimId: CLAIM_ID,
        sourceUrl: 'https://seller.example/spec.pdf',
        snippet: QUOTE,
        confidence: null,
      },
    ],
  };
}

function fixture(status: string, reference: { claimId: string; documentId: string } | null) {
  const tx = {
    claim: { findMany: vi.fn(async () => [claimRow(status)]) },
    claimDocumentEvidence: { findMany: vi.fn(async () => (reference ? [reference] : [])) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new ClaimService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('ClaimService.listForCompany document source rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('withholds statement and quote when the current document source is unavailable', async () => {
    vi.mocked(loadDocumentClaimBindingInTransaction).mockResolvedValue(null);
    const { service } = fixture('APPROVED', { claimId: CLAIM_ID, documentId: DOC_ID });
    const [row] = await service.listForCompany(CTX, COMPANY_ID);
    expect(row).toMatchObject({
      id: CLAIM_ID,
      status: 'APPROVED',
      statement: null,
      documentSource: { status: 'UNAVAILABLE', documentId: DOC_ID, parseRevision: null },
    });
    expect(row.evidence[0]).toMatchObject({ snippet: null, sourceUrl: null });
  });

  it('serves a current NEEDS_REVIEW draft while approved consumption stays separate', async () => {
    vi.mocked(loadDocumentClaimBindingInTransaction).mockResolvedValue({ parseRevision: 3 } as never);
    const { service } = fixture('NEEDS_REVIEW', { claimId: CLAIM_ID, documentId: DOC_ID });
    const [row] = await service.listForCompany(CTX, COMPANY_ID);
    expect(row).toMatchObject({
      statement: QUOTE,
      documentSource: { status: 'CURRENT', documentId: DOC_ID, parseRevision: 3 },
    });
    expect(row.evidence[0]).toMatchObject({ snippet: QUOTE });
  });

  it('leaves non-document claims untouched', async () => {
    const { service } = fixture('APPROVED', null);
    const [row] = await service.listForCompany(CTX, COMPANY_ID);
    expect(row).toMatchObject({ statement: QUOTE, documentSource: null });
    expect(loadDocumentClaimBindingInTransaction).not.toHaveBeenCalled();
  });
});
