import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

/**
 * BI-20（交付闭环设计 §4）：reject 必须带原因码——旧接口不带时返回 422，不是 400，
 * 也不是悄悄接受；accept 的原因码可选。原因码与自由文本备注一起留痕。
 */
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;

function serviceWithTx(tx: unknown): LeadService {
  return new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    { logDecision: vi.fn() } as never,
    { screen: vi.fn() } as never,
  );
}

const lead = {
  id: 'lead-1',
  workspaceId: 'ws-1',
  status: 'REVIEW',
  queue: 'needs_review',
  version: 3,
  canonicalCompanyId: 'company-1',
  totalScore: 0.4,
  scores: null,
  scoreDetail: null,
  fitVerdict: null,
  fitReasons: null,
};

function rejectTx() {
  return {
    lead: {
      findUnique: vi.fn(async () => lead),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    leadDecision: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'decision-1', ...args.data })),
    },
  };
}

describe('LeadService.decide — reject reason code (BI-20)', () => {
  it('refuses a reject without a reason code with 422 before touching the database', async () => {
    const withWorkspace = vi.fn();
    const service = new LeadService({ withWorkspace } as never, {} as never, {} as never);
    await expect(service.decide(ctx, 'lead-1', 'reject')).rejects.toMatchObject({
      status: 422,
      response: { error: { code: 'REASON_CODE_REQUIRED' } },
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a reason code that is not in the reject enum', async () => {
    const withWorkspace = vi.fn();
    const service = new LeadService({ withWorkspace } as never, {} as never, {} as never);
    await expect(service.decide(ctx, 'lead-1', 'reject', 'freitext', 'GOOD_FIT')).rejects.toMatchObject({
      status: 422,
      response: { error: { code: 'INVALID_REASON_CODE' } },
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('persists the reject reason code next to the free-text note', async () => {
    const tx = rejectTx();
    await serviceWithTx(tx).decide(ctx, 'lead-1', 'reject', 'kein Importeur', 'NOT_TARGET_ROLE');
    expect(tx.leadDecision.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        action: 'reject',
        reason: 'kein Importeur',
        reasonCode: 'NOT_TARGET_ROLE',
        decidedBy: 'user-1',
      },
    });
  });

  it('keeps the reason code optional on accept', async () => {
    const withWorkspace = vi.fn(async (_ws: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback({ lead: { findUnique: vi.fn(async () => null) } }),
    );
    const service = new LeadService({ withWorkspace } as never, {} as never, {} as never);
    // Past enum validation the transaction runs; a missing lead then yields NOT_FOUND, never 422.
    await expect(service.decide(ctx, 'lead-1', 'accept', undefined, 'GOOD_FIT')).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(withWorkspace).toHaveBeenCalledTimes(1);
  });
});
