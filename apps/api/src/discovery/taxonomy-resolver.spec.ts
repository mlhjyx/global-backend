import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask } from '../ai-tasks/task-registry';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { cpvSubtreePrefix, TaxonomyResolver } from './taxonomy-resolver';

vi.mock('../ai-tasks/task-registry', () => ({ getTask: vi.fn() }));
vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

const CONTRACT = {
  id: 'taxonomy.normalize',
  description: 'normalize taxonomy',
  model: 'fake-model',
};

function taxonomyRow(kind: string, code: string) {
  return {
    kind,
    scheme: kind.toUpperCase(),
    code,
    labelEn: `Label ${code}`,
    labels: { zh: `标签 ${code}` },
    wikidataQid: null,
    osmTags: [{ k: 'industry', v: code }],
    crosswalks: { cpv: [code] },
  };
}

function fakePrisma() {
  return {
    termAlias: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    canonicalTaxonomy: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function resolver(prisma = fakePrisma()) {
  return {
    prisma,
    service: new TaxonomyResolver(prisma as never, { provider: 'fake' } as never),
  };
}

describe('TaxonomyResolver deterministic paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(CONTRACT as never);
  });

  it('normalizes CPV subtree prefixes without ever returning an empty prefix', () => {
    expect(cpvSubtreePrefix('42120000')).toBe('4212');
    expect(cpvSubtreePrefix('42122130')).toBe('4212213');
    expect(cpvSubtreePrefix('00000000')).toBe('00000000');
  });

  it('fails closed for an empty term before touching storage or the model', async () => {
    const { prisma, service } = resolver();

    await expect(service.resolve('industry', ' \u3000 ')).resolves.toBeNull();
    expect(prisma.termAlias.findUnique).not.toHaveBeenCalled();
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('returns a complete canonical node on a normalized alias hit', async () => {
    const { prisma, service } = resolver();
    prisma.termAlias.findUnique.mockResolvedValue({ code: '28' });
    prisma.canonicalTaxonomy.findUnique.mockResolvedValue(taxonomyRow('industry', '28'));

    await expect(service.resolve('industry', '  PUMPS  ')).resolves.toEqual(taxonomyRow('industry', '28'));
    expect(prisma.termAlias.findUnique).toHaveBeenCalledWith({
      where: { kind_term: { kind: 'industry', term: 'pumps' } },
    });
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('returns null when an alias points to a missing canonical node', async () => {
    const { prisma, service } = resolver();
    prisma.termAlias.findUnique.mockResolvedValue({ code: 'missing' });

    await expect(service.resolve('industry', 'pumps')).resolves.toBeNull();
  });

  it('does not enter the model cold path when allowLlm is false', async () => {
    const { service } = resolver();

    await expect(service.resolve('industry', 'unseen', { allowLlm: false, workspaceId: 'ws-1' })).resolves.toBeNull();
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('deduplicates resolved nodes by code while preserving first-seen order', async () => {
    const { service } = resolver();
    const a = taxonomyRow('industry', '28');
    const b = taxonomyRow('industry', '29');
    vi.spyOn(service, 'resolve')
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b);

    await expect(service.resolveMany('industry', ['a', 'none', 'a-again', 'b'])).resolves.toEqual([a, b]);
  });
});

describe('TaxonomyResolver generic LLM cold path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(CONTRACT as never);
  });

  it('requires a real workspace before loading a catalog or calling the model', async () => {
    const { prisma, service } = resolver();

    await expect(service.resolve('country', 'Germany')).resolves.toBeNull();
    expect(prisma.canonicalTaxonomy.findMany).not.toHaveBeenCalled();
  });

  it('fails closed when the task contract or candidate catalog is unavailable', async () => {
    const first = resolver();
    vi.mocked(getTask).mockReturnValueOnce(undefined);
    await expect(first.service.resolve('country', 'Germany', { workspaceId: 'ws-1' })).resolves.toBeNull();
    expect(first.prisma.canonicalTaxonomy.findMany).not.toHaveBeenCalled();

    const second = resolver();
    await expect(second.service.resolve('country', 'Germany', { workspaceId: 'ws-1' })).resolves.toBeNull();
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('validates the selected code, sediments the normalized alias, and tolerates sediment failure', async () => {
    const { prisma, service } = resolver();
    prisma.canonicalTaxonomy.findMany.mockResolvedValue([
      { code: 'DE', labelEn: 'Germany', labels: { zh: '德国' } },
      { code: 'FR', labelEn: 'France', labels: null },
    ]);
    prisma.canonicalTaxonomy.findUnique.mockResolvedValue(taxonomyRow('country', 'DE'));
    prisma.termAlias.upsert.mockRejectedValue(new Error('write unavailable'));
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { code: 'DE' } } as never);

    await expect(service.resolve('country', '  Germany ', { workspaceId: 'ws-1' })).resolves.toMatchObject({ code: 'DE' });
    expect(prisma.termAlias.upsert).toHaveBeenCalledWith({
      where: { kind_term: { kind: 'country', term: 'germany' } },
      update: { code: 'DE', source: 'llm' },
      create: { kind: 'country', term: 'germany', code: 'DE', source: 'llm' },
    });
    expect(vi.mocked(executeStructuredTaskWithRuntime).mock.calls[0]?.[2]).toEqual({ workspaceId: 'ws-1' });
  });

  it('returns null for a model null, a missing selected node, or a model failure', async () => {
    for (const mode of ['null', 'missing', 'reject'] as const) {
      const { prisma, service } = resolver();
      prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: 'DE', labelEn: 'Germany', labels: null }]);
      if (mode === 'null') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: null } } as never);
      if (mode === 'missing') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: 'DE' } } as never);
      if (mode === 'reject') vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValueOnce(new Error('model unavailable'));

      await expect(service.resolve('country', `term-${mode}`, { workspaceId: 'ws-1' })).resolves.toBeNull();
    }
  });
});

describe('TaxonomyResolver bounded CPV refinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(CONTRACT as never);
  });

  it('rejects empty inputs before storage access', async () => {
    const { prisma, service } = resolver();

    await expect(service.resolveCpvForProduct(' ', ['42120000'])).resolves.toBeNull();
    await expect(service.resolveCpvForProduct('pump', [])).resolves.toBeNull();
    expect(prisma.termAlias.findUnique).not.toHaveBeenCalled();
  });

  it('uses a cached alias only when it remains inside the current subtree', async () => {
    const cached = resolver();
    cached.prisma.termAlias.findUnique.mockResolvedValue({ code: '42122130' });
    await expect(cached.service.resolveCpvForProduct('Pump', ['42120000'])).resolves.toBe('42122130');

    const stale = resolver();
    stale.prisma.termAlias.findUnique.mockResolvedValue({ code: '99999999' });
    await expect(stale.service.resolveCpvForProduct('Pump', ['42120000'], { allowLlm: false })).resolves.toBeNull();
  });

  it('requires workspace, rows, and a task contract before model execution', async () => {
    const noWorkspace = resolver();
    await expect(noWorkspace.service.resolveCpvForProduct('pump', ['42120000'])).resolves.toBeNull();

    const noRows = resolver();
    await expect(noRows.service.resolveCpvForProduct('pump', ['42120000'], { workspaceId: 'ws-1' })).resolves.toBeNull();

    const noTask = resolver();
    noTask.prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '42122130', labelEn: 'Pumps', labels: null }]);
    vi.mocked(getTask).mockReturnValueOnce(undefined);
    await expect(noTask.service.resolveCpvForProduct('pump', ['42120000'], { workspaceId: 'ws-1' })).resolves.toBeNull();
  });

  it('queries only normalized subtree prefixes and sediments a validated result', async () => {
    const { prisma, service } = resolver();
    prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '42122130', labelEn: 'Pumps', labels: { zh: '泵' } }]);
    prisma.canonicalTaxonomy.findUnique.mockResolvedValue(taxonomyRow('cpv', '42122130'));
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { code: '42122130' } } as never);

    await expect(service.resolveCpvForProduct(' Water Pump ', ['42120000'], { workspaceId: 'ws-1' })).resolves.toBe('42122130');
    expect(prisma.canonicalTaxonomy.findMany).toHaveBeenCalledWith({
      where: { kind: 'cpv', OR: [{ code: { startsWith: '4212' } }] },
      select: { code: true, labelEn: true, labels: true },
      take: 500,
    });
    expect(prisma.termAlias.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind_term: { kind: 'cpv', term: 'water pump' } },
    }));
  });

  it('fails closed for null output, an unknown selected code, and model errors', async () => {
    for (const mode of ['null', 'unknown', 'reject'] as const) {
      const { prisma, service } = resolver();
      prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '42122130', labelEn: 'Pumps', labels: null }]);
      if (mode === 'null') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: null } } as never);
      if (mode === 'unknown') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: '42122130' } } as never);
      if (mode === 'reject') vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValueOnce(new Error('offline'));

      await expect(service.resolveCpvForProduct(mode, ['42120000'], { workspaceId: 'ws-1' })).resolves.toBeNull();
    }
  });
});

describe('TaxonomyResolver bounded NAICS refinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(CONTRACT as never);
  });

  it('rejects empty products and blank-only prefixes', async () => {
    const { prisma, service } = resolver();
    await expect(service.resolveNaicsForProduct('', ['33'])).resolves.toBeNull();
    await expect(service.resolveNaicsForProduct('pump', [' ', '\t'])).resolves.toBeNull();
    expect(prisma.termAlias.findUnique).not.toHaveBeenCalled();
  });

  it('uses only in-subtree cached aliases and otherwise respects allowLlm=false', async () => {
    const hit = resolver();
    hit.prisma.termAlias.findUnique.mockResolvedValue({ code: '333914' });
    await expect(hit.service.resolveNaicsForProduct('pump', ['3339'])).resolves.toBe('333914');

    const miss = resolver();
    miss.prisma.termAlias.findUnique.mockResolvedValue({ code: '334517' });
    await expect(miss.service.resolveNaicsForProduct('pump', ['3339'], { allowLlm: false })).resolves.toBeNull();
  });

  it('returns null without workspace, rows, or task contract', async () => {
    const noWorkspace = resolver();
    await expect(noWorkspace.service.resolveNaicsForProduct('pump', ['3339'])).resolves.toBeNull();

    const noRows = resolver();
    await expect(noRows.service.resolveNaicsForProduct('pump', ['3339'], { workspaceId: 'ws-1' })).resolves.toBeNull();

    const noTask = resolver();
    noTask.prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '333914', labelEn: 'Pumps', labels: null }]);
    vi.mocked(getTask).mockReturnValueOnce(undefined);
    await expect(noTask.service.resolveNaicsForProduct('pump', ['3339'], { workspaceId: 'ws-1' })).resolves.toBeNull();
  });

  it('validates, sediments, and returns a bounded NAICS result even if sediment fails', async () => {
    const { prisma, service } = resolver();
    prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '333914', labelEn: 'Pump manufacturing', labels: null }]);
    prisma.canonicalTaxonomy.findUnique.mockResolvedValue(taxonomyRow('naics', '333914'));
    prisma.termAlias.upsert.mockRejectedValue(new Error('read-only'));
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { code: '333914' } } as never);

    await expect(service.resolveNaicsForProduct('Pump', [' 3339 '], { workspaceId: 'ws-1' })).resolves.toBe('333914');
    expect(prisma.canonicalTaxonomy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: 'naics', OR: [{ code: { startsWith: '3339' } }] },
    }));
  });

  it('returns null for null output, a missing node, or model failure', async () => {
    for (const mode of ['null', 'missing', 'reject'] as const) {
      const { prisma, service } = resolver();
      prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: '333914', labelEn: 'Pumps', labels: null }]);
      if (mode === 'null') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: null } } as never);
      if (mode === 'missing') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: '333914' } } as never);
      if (mode === 'reject') vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValueOnce(new Error('offline'));

      await expect(service.resolveNaicsForProduct(mode, ['3339'], { workspaceId: 'ws-1' })).resolves.toBeNull();
    }
  });
});

describe('TaxonomyResolver bounded FDA refinement and listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(CONTRACT as never);
  });

  it('rejects empty product or panel input before storage access', async () => {
    const { prisma, service } = resolver();
    await expect(service.resolveFdaProductCode(' ', ['RA'])).resolves.toBeNull();
    await expect(service.resolveFdaProductCode('x-ray', [])).resolves.toBeNull();
    expect(prisma.termAlias.findUnique).not.toHaveBeenCalled();
  });

  it('uses a cached alias only when its canonical leaf belongs to the current panel', async () => {
    const hit = resolver();
    hit.prisma.termAlias.findUnique.mockResolvedValue({ code: 'LLZ' });
    hit.prisma.canonicalTaxonomy.findUnique.mockResolvedValue({ parentCode: 'RA' });
    await expect(hit.service.resolveFdaProductCode('x-ray', ['RA'])).resolves.toBe('LLZ');

    const stale = resolver();
    stale.prisma.termAlias.findUnique.mockResolvedValue({ code: 'LLZ' });
    stale.prisma.canonicalTaxonomy.findUnique.mockResolvedValue({ parentCode: 'CV' });
    await expect(stale.service.resolveFdaProductCode('x-ray', ['RA'], { allowLlm: false })).resolves.toBeNull();
  });

  it('requires workspace, panel rows, and task contract before model execution', async () => {
    const noWorkspace = resolver();
    await expect(noWorkspace.service.resolveFdaProductCode('x-ray', ['RA'])).resolves.toBeNull();

    const noRows = resolver();
    await expect(noRows.service.resolveFdaProductCode('x-ray', ['RA'], { workspaceId: 'ws-1' })).resolves.toBeNull();

    const noTask = resolver();
    noTask.prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: 'LLZ', labelEn: 'Imaging', labels: null }]);
    vi.mocked(getTask).mockReturnValueOnce(undefined);
    await expect(noTask.service.resolveFdaProductCode('x-ray', ['RA'], { workspaceId: 'ws-1' })).resolves.toBeNull();
  });

  it('validates and sediments a panel-bounded FDA code', async () => {
    const { prisma, service } = resolver();
    prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: 'LLZ', labelEn: 'Imaging', labels: null }]);
    prisma.canonicalTaxonomy.findUnique.mockResolvedValue(taxonomyRow('fda_product_code', 'LLZ'));
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { code: 'LLZ' } } as never);

    await expect(service.resolveFdaProductCode(' X-Ray ', ['RA'], { workspaceId: 'ws-1' })).resolves.toBe('LLZ');
    expect(prisma.canonicalTaxonomy.findMany).toHaveBeenCalledWith({
      where: { kind: 'fda_product_code', parentCode: { in: ['RA'] } },
      select: { code: true, labelEn: true, labels: true },
      take: 500,
    });
    expect(prisma.termAlias.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ term: 'x-ray', code: 'LLZ' }),
    }));
  });

  it('fails closed for null output, unknown selected code, and model failure', async () => {
    for (const mode of ['null', 'missing', 'reject'] as const) {
      const { prisma, service } = resolver();
      prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: 'LLZ', labelEn: 'Imaging', labels: null }]);
      if (mode === 'null') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: null } } as never);
      if (mode === 'missing') vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValueOnce({ data: { code: 'LLZ' } } as never);
      if (mode === 'reject') vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValueOnce(new Error('offline'));

      await expect(service.resolveFdaProductCode(mode, ['RA'], { workspaceId: 'ws-1' })).resolves.toBeNull();
    }
  });

  it('lists at most the bounded panel code set and short-circuits empty panels', async () => {
    const { prisma, service } = resolver();
    await expect(service.listFdaProductCodes([])).resolves.toEqual([]);
    expect(prisma.canonicalTaxonomy.findMany).not.toHaveBeenCalled();

    prisma.canonicalTaxonomy.findMany.mockResolvedValue([{ code: 'LLZ' }, { code: 'IZF' }]);
    await expect(service.listFdaProductCodes(['RA'])).resolves.toEqual(['LLZ', 'IZF']);
    expect(prisma.canonicalTaxonomy.findMany).toHaveBeenCalledWith({
      where: { kind: 'fda_product_code', parentCode: { in: ['RA'] } },
      select: { code: true },
      take: 500,
    });
  });
});
