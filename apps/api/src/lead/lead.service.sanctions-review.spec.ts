import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [] } as never;
const LEAD = { id: '40000000-0000-4000-8000-000000000004', canonicalCompanyId: 'company-1' };

function serviceWithScreening(result: { id: string; status: string; reviewState: string } | null) {
  const tx = {
    lead: {
      findUnique: vi.fn(async () => LEAD),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    sanctionsScreeningResult: {
      findFirst: vi.fn(async () => result),
      update: vi.fn(async () => ({})),
    },
  };
  const service = new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
  return { service, tx };
}

describe('LeadService.reviewSanctions', () => {
  it('有待复核的命中 → 记复核态，误报清白把该公司被 hold 的 lead 回落 needs_review', async () => {
    const { service, tx } = serviceWithScreening({ id: 'r-1', status: 'potential_match', reviewState: 'open' });

    await expect(service.reviewSanctions(ctx, LEAD.id, 'cleared_false_positive', 'name only')).resolves.toEqual({
      leadId: LEAD.id,
      reviewState: 'cleared_false_positive',
    });
    expect(tx.sanctionsScreeningResult.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { reviewState: 'cleared_false_positive', reviewedBy: 'user-1', reviewNote: 'name only' },
    });
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { canonicalCompanyId: 'company-1', queue: 'sanctions_hold' },
      data: { queue: 'needs_review' },
    });
  });

  it('确认过的真命中不能经本端点清白 → 409 SANCTIONS_CONFIRMED_IMMUTABLE', async () => {
    const { service, tx } = serviceWithScreening({ id: 'r-1', status: 'potential_match', reviewState: 'confirmed_true_hit' });

    await expect(service.reviewSanctions(ctx, LEAD.id, 'cleared_false_positive')).rejects.toMatchObject({
      response: { error: { code: 'SANCTIONS_CONFIRMED_IMMUTABLE' } },
      status: 409,
    });
    expect(tx.sanctionsScreeningResult.update).not.toHaveBeenCalled();
  });
});
