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

/**
 * qualify 自 (q) 起会把命中已消失的记录改写为 clear。clear 记录上已经没有可复核的命中：在上面记复核态
 * 不起作用（accept 只看 potential_match），所以拒绝，免得复核人以为确认或清白生效了。
 */
describe('LeadService.reviewSanctions', () => {
  it.each(['cleared_false_positive', 'confirmed_true_hit'] as const)(
    '筛查记录已是 clear（命中已消失）→ 409 SANCTIONS_NOTHING_TO_REVIEW，不改复核态：%s',
    async (decision) => {
      const { service, tx } = serviceWithScreening({ id: 'r-1', status: 'clear', reviewState: 'open' });

      await expect(service.reviewSanctions(ctx, LEAD.id, decision)).rejects.toMatchObject({
        response: { error: { code: 'SANCTIONS_NOTHING_TO_REVIEW' } },
        status: 409,
      });
      expect(tx.sanctionsScreeningResult.update).not.toHaveBeenCalled();
      expect(tx.lead.updateMany).not.toHaveBeenCalled();
    },
  );

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
});
