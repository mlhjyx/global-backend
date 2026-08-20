import { describe, expect, it, vi } from 'vitest';
import { BudgetOperationReplayError } from '../tools/budget-store';
import { TaxonomyResolver } from './taxonomy-resolver';

describe('TaxonomyResolver — durable model budget binding', () => {
  it('opens before the model call, passes the same runId, and closes in finally', async () => {
    const order: string[] = [];
    const generateStructured = vi.fn(async (_input, context) => {
      order.push('model');
      expect(context).toMatchObject({
        workspaceId: 'workspace-1',
        runId: 'discovery:run-1',
        genericReplay: expect.objectContaining({ schema: 'taxonomy-result/v1' }),
      });
      return { data: { code: 'industry-1' }, provider: 'gateway', model: 'model', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const prisma = {
      termAlias: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
      canonicalTaxonomy: {
        findMany: vi.fn(async () => [{ code: 'industry-1', labelEn: 'Pumps', labels: {} }]),
        findUnique: vi.fn(async () => ({
          kind: 'industry', scheme: 'isic', code: 'industry-1', labelEn: 'Pumps', labels: {},
          wikidataQid: null, osmTags: null, crosswalks: null,
        })),
      },
    };
    const budgetStore = {
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    };
    const resolver = new TaxonomyResolver(prisma as never, { generateStructured } as never, undefined, budgetStore as never);

    await expect(resolver.resolve('industry', 'pumps', {
      workspaceId: 'workspace-1', runId: 'discovery:run-1',
    })).resolves.toMatchObject({ code: 'industry-1' });
    expect(budgetStore.open).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', accountKey: 'discovery:run-1', capCents: expect.any(Number), replayScope: true,
    });
    expect(budgetStore.close).toHaveBeenCalledWith({ workspaceId: 'workspace-1', accountKey: 'discovery:run-1' });
    expect(order).toEqual(['open', 'model', 'close']);
  });

  it('does not downgrade generic replay loss to a taxonomy miss', async () => {
    const replayError = new BudgetOperationReplayError('taxonomy-op');
    const prisma = {
      termAlias: { findUnique: vi.fn(async () => null) },
      canonicalTaxonomy: { findMany: vi.fn(async () => [{ code: 'industry-1', labelEn: 'Pumps', labels: {} }]) },
    };
    const budgetStore = { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const resolver = new TaxonomyResolver(
      prisma as never,
      { generateStructured: vi.fn(async () => { throw replayError; }) } as never,
      undefined,
      budgetStore as never,
    );

    await expect(resolver.resolve('industry', 'pumps', {
      workspaceId: 'workspace-1', runId: 'discovery:run-1',
    })).rejects.toBe(replayError);
    expect(budgetStore.close).toHaveBeenCalled();
  });
});
