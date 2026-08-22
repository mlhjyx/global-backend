import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { BudgetOperationReplayError } from '../tools/budget-store';
import { TaxonomyResolver } from './taxonomy-resolver';

describe('TaxonomyResolver — durable model budget binding', () => {
  it('uses the verified ICP authority binding for nested taxonomy model calls without a legacy account fallback', async () => {
    const requestSha256 = 'a'.repeat(64);
    const binding = {
      authorityId: '20000000-0000-4000-8000-000000000002',
      replay: false,
      scopeKey: '10000000-0000-4000-8000-000000000001',
      accountKey: `icp.query_plan:icp:30000000-0000-4000-8000-000000000003:${requestSha256}`,
      purpose: 'icp.query_plan' as const,
      subjectType: 'icp',
      subjectId: '30000000-0000-4000-8000-000000000003',
      requestSha256,
    };
    const generateStructured = vi.fn(async (_input, context) => ({
      data: { code: 'industry-1' },
      provider: 'gateway',
      model: 'model',
      context,
    }));
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
      open: vi.fn(async () => undefined),
      attestAuthorized: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const resolver = new TaxonomyResolver(
      prisma as never,
      { generateStructured } as never,
      undefined,
      budgetStore as never,
    );

    await resolver.resolve('industry', 'pumps', {
      workspaceId: binding.scopeKey,
      runId: binding.accountKey,
      executionBudget: binding,
    });

    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
    expect(budgetStore.open).not.toHaveBeenCalled();
    expect(budgetStore.close).not.toHaveBeenCalled();
    expect(generateStructured).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceId: binding.scopeKey,
        runId: binding.accountKey,
      }),
    );
  });

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

  it('sends all four real taxonomy wires an exact enum over the closed bounded task schema', async () => {
    const codesByKind: Record<string, string[]> = {
      industry: ['industry-1', 'industry-2'],
      cpv: ['42120000', '42121000'],
      naics: ['333911', '333912'],
      fda_product_code: ['ABC', 'ABD'],
    };
    const generateStructured = vi.fn(async (input, context) => {
      expect(input.task).toBe('taxonomy.normalize');
      expect(input.model).toBe('deepseek-v4-flash');
      expect(context.genericReplay).toEqual(expect.objectContaining({ schema: 'taxonomy-result/v1' }));
      const code = ((input.schema as {
        properties: { code: { enum: (string | null)[] } };
      }).properties.code.enum[0]);
      return {
        data: { code }, provider: 'gateway', model: 'model',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const prisma = {
      termAlias: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({})),
      },
      canonicalTaxonomy: {
        findMany: vi.fn(async (input: { where: { kind: string } }) =>
          codesByKind[input.where.kind].map((code) => ({
            code, labelEn: code, labels: {}, parentCode: input.where.kind === 'fda_product_code' ? 'RA' : null,
          }))),
        findUnique: vi.fn(async (input: { where: { kind_code: { kind: string; code: string } } }) => ({
          kind: input.where.kind_code.kind,
          scheme: input.where.kind_code.kind,
          code: input.where.kind_code.code,
          labelEn: input.where.kind_code.code,
          labels: {},
          wikidataQid: null,
          osmTags: null,
          crosswalks: null,
        })),
      },
    };
    const budgetStore = {
      open: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    };
    const resolver = new TaxonomyResolver(
      prisma as never, { generateStructured } as never, undefined, budgetStore as never,
    );

    await resolver.resolve('industry', 'pumps', { workspaceId: 'workspace-1', runId: 'run-1' });
    await resolver.resolveCpvForProduct('pump', ['4212'], { workspaceId: 'workspace-1', runId: 'run-1' });
    await resolver.resolveNaicsForProduct('pump', ['3339'], { workspaceId: 'workspace-1', runId: 'run-1' });
    await resolver.resolveFdaProductCode('pump', ['RA'], { workspaceId: 'workspace-1', runId: 'run-1' });

    expect(generateStructured).toHaveBeenCalledTimes(4);
    const expectedEnums = [
      ['industry-1', 'industry-2', null],
      ['42120000', '42121000', null],
      ['333911', '333912', null],
      ['ABC', 'ABD', null],
    ];
    for (const [index, call] of generateStructured.mock.calls.entries()) {
      const schema = call[0].schema as Record<string, unknown>;
      const code = (schema.properties as {
        code: { type: string[]; maxLength?: number; enum: (string | null)[] };
      }).code;
      expect(schema.additionalProperties, `wire ${index}`).toBe(false);
      expect(code.type, `wire ${index}`).toEqual(['string', 'null']);
      expect(code.maxLength, `wire ${index}`).toBe(80);
      expect(code.enum, `wire ${index}`).toEqual(expectedEnums[index]);
      const validate = new Ajv({ strict: false }).compile(schema);
      expect(validate({ code: expectedEnums[index][0] }), `wire ${index}`).toBe(true);
      expect(validate({ code: expectedEnums[index][0], rawResponse: 'forbidden' }), `wire ${index}`).toBe(false);
    }
  });
});
