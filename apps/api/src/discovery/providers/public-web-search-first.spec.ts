import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import type { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';

const mocks = vi.hoisted(() => ({
  executeStructuredTaskWithRuntime: vi.fn(),
  isAllowedByRobots: vi.fn(async () => true),
}));

vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: mocks.executeStructuredTaskWithRuntime,
}));
vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: mocks.isAllowedByRobots,
}));

import {
  PublicWebDiscoveryProvider,
  buildSearchQueries,
  searchLanguageFor,
  tradeRoleFor,
} from './public-web.provider';
import { getTask } from '../../ai-tasks/task-registry';

const CTX: ExecutionContext = {
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  runId: 'run-1',
};

function distributorQuery(overrides: Partial<CompanyDiscoveryQuery> = {}): CompanyDiscoveryQuery {
  return {
    sourceClass: 'public_intelligence',
    filters: { industry: 'Pumpen', country: 'Germany', trade_side: 'distributor / importer' },
    keywords: ['Kreiselpumpen', 'Tauchpumpen'],
    limit: 20,
    ...overrides,
  };
}

type Invoke = (toolId: string, input: unknown, ctx: ToolContext) => Promise<ToolResult<unknown>>;

function broker(invoke: Invoke): ExecutionBroker & { invoke: ReturnType<typeof vi.fn> } {
  return {
    checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
    invoke: vi.fn(invoke) as never,
  } as never;
}

beforeEach(() => {
  mocks.executeStructuredTaskWithRuntime.mockReset();
  mocks.isAllowedByRobots.mockClear();
});

describe('search language and trade role (G3 5.3)', () => {
  it.each([
    [{ country: 'Germany' }, 'de'],
    [{ country: 'DE' }, 'de'],
    [{ country: 'Deutschland' }, 'de'],
    [{ country: '德国' }, 'de'],
    [{ country: ['Austria', 'Switzerland'] }, 'de'],
    [{ region: 'Bayern', country: 'DEU' }, 'de'],
    [{ country: 'France' }, 'fr'],
    [{ country: 'Italia' }, 'it'],
    [{ country: 'Nowhere' }, 'en'],
    [{}, 'en'],
  ])('maps %o to search language %s', (filters, language) => {
    expect(searchLanguageFor({ filters })).toBe(language);
  });

  it.each([
    [{ trade_side: 'distributor' }, 'distributor'],
    [{ business_model: 'Großhandel / Händler' }, 'distributor'],
    [{ establishment_type: 'importer' }, 'distributor'],
    [{ trade_side: '经销商' }, 'distributor'],
    [{ business_model: 'OEM manufacturer' }, 'manufacturer'],
    [{ trade_side: 'Hersteller' }, 'manufacturer'],
    [{}, null],
  ])('derives trade role from %o', (filters, role) => {
    expect(tradeRoleFor({ filters })).toBe(role);
  });

  it('builds German distributor queries without the hard-coded manufacturer suffix', () => {
    const queries = buildSearchQueries(distributorQuery());
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries.join(' | ')).not.toMatch(/manufacturer company/i);
    expect(queries.some((q) => /Großhandel/.test(q))).toBe(true);
    expect(queries.some((q) => /Händler|Vertrieb/.test(q))).toBe(true);
    expect(queries.every((q) => /Kreiselpumpen|Tauchpumpen|Pumpen/.test(q))).toBe(true);
  });

  it('keeps a neutral query without any role word when no role is known', () => {
    const queries = buildSearchQueries(distributorQuery({ filters: { industry: 'pumps', country: 'Germany' } }));
    expect(queries.join(' | ')).not.toMatch(/manufacturer|supplier|Großhandel|Hersteller/i);
    expect(queries.length).toBeGreaterThan(0);
  });
});

describe('PublicWebDiscoveryProvider search-first discovery (G3 5.3)', () => {
  function searchBroker(results: Array<{ url: string; title: string; content?: string }>) {
    return broker(async (toolId) => {
      if (toolId === 'searxng.search') return { data: { results }, costCents: 0 };
      throw new Error(`unexpected tool ${toolId}`);
    });
  }

  it('never fetches a page before a company exists and judges from search hits in the target language', async () => {
    const executionBroker = searchBroker([
      { url: 'https://www.pumpen-handel.example/', title: 'Pumpen Handel GmbH – Großhandel für Pumpen', content: 'Ihr Pumpen-Großhändler: Grundfos, Wilo, Leo' },
      { url: 'https://www.pumpen-handel.example/produkte', title: 'Produkte', content: 'Kreiselpumpen und Tauchpumpen ab Lager' },
      { url: 'https://pompes.example.fr/', title: 'Pompes France', content: 'distributeur' },
    ]);
    mocks.executeStructuredTaskWithRuntime.mockResolvedValue({
      data: { is_company_site: true, name: 'Pumpen Handel GmbH', country: 'Germany' },
      provider: 'gateway', model: 'model', runtimeExecution: {},
    });

    const result = await new PublicWebDiscoveryProvider({ gateway: {} as never, broker: executionBroker })
      .discoverCompanies(distributorQuery(), CTX);

    const tools = executionBroker.invoke.mock.calls.map(([toolId]) => toolId);
    expect(tools.every((toolId) => toolId === 'searxng.search')).toBe(true);
    for (const [, input] of executionBroker.invoke.mock.calls) {
      expect(input).toMatchObject({ language: 'de' });
    }
    expect(mocks.isAllowedByRobots).not.toHaveBeenCalled();
    expect(mocks.executeStructuredTaskWithRuntime).toHaveBeenCalledOnce();
    const [, modelInput] = mocks.executeStructuredTaskWithRuntime.mock.calls[0]!;
    expect(modelInput.prompt).toContain('Pumpen Handel GmbH – Großhandel für Pumpen');
    expect(modelInput.prompt).toContain('Kreiselpumpen und Tauchpumpen ab Lager');
    expect(modelInput.prompt).not.toContain('Pompes France');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'pumpen-handel.example',
      domain: 'pumpen-handel.example',
      name: 'Pumpen Handel GmbH',
      provenance: expect.objectContaining({ parserVersion: 'public_web/v2-search' }),
    });
  });

  it('skips candidates with no usable search text without a model call', async () => {
    mocks.executeStructuredTaskWithRuntime.mockResolvedValue({
      data: { is_company_site: true, name: 'X' }, provider: 'gateway', model: 'model', runtimeExecution: {},
    });
    const result = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: searchBroker([{ url: 'https://empty.example/', title: '   ' }]),
    }).discoverCompanies(distributorQuery(), CTX);
    expect(result.records).toEqual([]);
    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('allows the extract task only the search tool', () => {
    expect(getTask('discovery.extract_company')?.allowedTools).toEqual(['searxng.search']);
  });
});

describe('DirectoryDiscoveryProvider without a subject (G3 5.3)', () => {
  it('skips a listing page held by the artifact subject binding instead of failing the run', async () => {
    const { DirectoryDiscoveryProvider } = await import('./directory.provider');
    const { ToolPolicyDenied } = await import('../../tools/tool-broker');
    const executionBroker = broker(async (toolId) => {
      if (toolId === 'searxng.search') {
        return {
          data: { results: [{ url: 'https://verband.example/mitglieder', title: 'Mitgliederverzeichnis Pumpen' }] },
          costCents: 0,
        };
      }
      throw new ToolPolicyDenied(toolId, 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD');
    });
    const result = await new DirectoryDiscoveryProvider({ gateway: {} as never, broker: executionBroker })
      .discoverCompanies(distributorQuery({ sourceClass: 'industry_data' }), CTX);
    expect(result.records).toEqual([]);
    expect(result.lineage?.recordCount).toBe(0);
    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('still fails the query on a non-skippable control error', async () => {
    const { DirectoryDiscoveryProvider } = await import('./directory.provider');
    const executionBroker = broker(async (toolId) => {
      if (toolId === 'searxng.search') {
        return { data: { results: [{ url: 'https://verband.example/mitglieder', title: 'Mitgliederverzeichnis' }] }, costCents: 0 };
      }
      throw Object.assign(new Error('budget'), { code: 'BUDGET_EXCEEDED' });
    });
    await expect(new DirectoryDiscoveryProvider({ gateway: {} as never, broker: executionBroker })
      .discoverCompanies(distributorQuery({ sourceClass: 'industry_data' }), CTX))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});
