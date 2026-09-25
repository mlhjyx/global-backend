import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';

const mocks = vi.hoisted(() => ({ executeStructuredTaskWithRuntime: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: mocks.executeStructuredTaskWithRuntime,
}));

import { WebsiteProfileProvider } from './website-profile.provider';
import { ToolPolicyDenied } from '../../tools/tool-broker';

const COMPANY = '00000000-0000-4000-8000-0000000000c3';
const CTX = {
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  runId: 'run-1',
  artifactSubject: { subjectType: 'company' as const, subjectId: COMPANY },
};
const INPUT = { domain: 'pumpen-handel.example', homeCountry: 'de', icpContext: 'Pumpen' };

const IMPRESSUM = 'Impressum\n\nPumpen Handel GmbH\nAmtsgericht München HRB 98765\nUSt-IdNr.: DE136695976';

function broker(pages: Record<string, string | Error>) {
  const invoke = vi.fn(async (_toolId: string, input: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> => {
    const url = (input as { url: string }).url;
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new Error('404');
    expect(ctx.artifactSubject).toEqual(CTX.artifactSubject);
    expect(ctx.taskContractId).toBe('discovery.classify_trade_role');
    return { data: { url, text: page, contentHash: 'x' }, costCents: 1 };
  });
  return { checkSourcePolicy: vi.fn(), invoke } as unknown as ExecutionBroker & { invoke: typeof invoke };
}

beforeEach(() => mocks.executeStructuredTaskWithRuntime.mockReset());

describe('WebsiteProfileProvider (G3 5.4)', () => {
  it('decides a clear wholesaler by rules without a model call and binds every fetch to the company', async () => {
    const executionBroker = broker({
      'https://pumpen-handel.example/': 'Ihr Pumpen-Großhandel. Autorisierter Händler und Vertriebspartner für Grundfos, Wilo und Leo Pumpen. Lagerprogramm ab Lager. [Impressum](https://pumpen-handel.example/impressum.html)',
      'https://pumpen-handel.example/impressum.html': IMPRESSUM,
    });
    const profile = await new WebsiteProfileProvider({ gateway: {} as never, broker: executionBroker })
      .profile(INPUT, CTX);

    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
    expect(executionBroker.invoke).toHaveBeenCalledTimes(2);
    expect(profile).toMatchObject({
      tradeRole: 'distributor',
      tradeRoleSource: 'rules',
      impressumUrl: 'https://pumpen-handel.example/impressum.html',
      legalName: 'Pumpen Handel GmbH',
      register: { type: 'HRB', key: 'de-hrb:muenchen:98765' },
      vatId: 'DE136695976',
      carriesChineseBrand: true,
      carriesForeignBrand: true,
    });
    expect(profile?.carriedBrands.map((b) => b.name)).toEqual(['Grundfos', 'Wilo', 'Leo']);
  });

  it('asks the model only when rules are not decisive, and merges its brands', async () => {
    mocks.executeStructuredTaskWithRuntime.mockResolvedValue({
      data: { trade_role: 'mixed', confidence: 0.8, own_manufacturing: true, carried_brands: ['Wilo', 'Acme Pumps'], evidence: ['Hersteller und Händler'] },
    });
    const profile = await new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({
        'https://pumpen-handel.example/': 'Hersteller und Händler von Pumpen. Wir führen Wilo.',
        'https://pumpen-handel.example/impressum': IMPRESSUM,
      }),
    }).profile(INPUT, CTX);

    expect(mocks.executeStructuredTaskWithRuntime).toHaveBeenCalledOnce();
    const [, modelInput, modelCtx] = mocks.executeStructuredTaskWithRuntime.mock.calls[0]!;
    expect(modelInput.task).toBe('discovery.classify_trade_role');
    expect(modelCtx.durableResultSchema).toBe('discovery-classify-trade-role/v1');
    expect(profile).toMatchObject({ tradeRole: 'mixed', tradeRoleSource: 'model', tradeRoleConfidence: 0.8, ownManufacturing: true });
    expect(profile?.carriedBrands).toEqual([
      { name: 'Wilo', country: 'de' },
      { name: 'Acme Pumps', country: null },
    ]);
  });

  it('keeps homepage facts when the Impressum fetch fails, and returns null for an empty homepage', async () => {
    mocks.executeStructuredTaskWithRuntime.mockResolvedValue({ data: { trade_role: 'other' } });
    const withoutImpressum = await new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({ 'https://pumpen-handel.example/': 'Willkommen' }),
    }).profile(INPUT, CTX);
    expect(withoutImpressum).toMatchObject({ impressumUrl: null, tradeRole: 'other', legalName: null });

    const empty = await new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({ 'https://pumpen-handel.example/': '' }),
    }).profile(INPUT, CTX);
    expect(empty).toBeNull();
  });

  it('propagates prohibition-class and control denials so the caller can skip or fail', async () => {
    const tombstoned = new ToolPolicyDenied('crawl4ai.fetch', 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED');
    await expect(new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({ 'https://pumpen-handel.example/': tombstoned }),
    }).profile(INPUT, CTX)).rejects.toBe(tombstoned);

    const budget = Object.assign(new Error('budget'), { code: 'BUDGET_EXCEEDED' });
    await expect(new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({ 'https://pumpen-handel.example/': 'Willkommen', 'https://pumpen-handel.example/impressum': budget }),
    }).profile(INPUT, CTX)).rejects.toBe(budget);
  });

  it('falls back to deterministic facts when the model fails with an ordinary error', async () => {
    mocks.executeStructuredTaskWithRuntime.mockRejectedValue(new Error('gateway 502'));
    const profile = await new WebsiteProfileProvider({
      gateway: {} as never,
      broker: broker({ 'https://pumpen-handel.example/': 'Pumpen', 'https://pumpen-handel.example/impressum': IMPRESSUM }),
    }).profile(INPUT, CTX);
    expect(profile).toMatchObject({ tradeRole: null, tradeRoleSource: null, register: { number: '98765' } });
  });
});
