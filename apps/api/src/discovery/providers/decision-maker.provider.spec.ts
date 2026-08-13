import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import {
  DecisionMakerContactAdapter,
  DecisionMakerProvider,
  scorePeoplePageUrl,
} from './decision-maker.provider';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));
vi.mock('../../adapters/site-links', () => ({ extractSameSiteLinks: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'company-1',
};

function crawl(text: string) {
  return { data: { url: 'https://pump.example', text }, costCents: 0 };
}

describe('DecisionMakerProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
    vi.mocked(extractSameSiteLinks).mockReturnValue([]);
  });

  it.each([
    ['https://pump.example/impressum', 100],
    ['https://pump.example/management', 95],
    ['https://pump.example/team', 85],
    ['https://pump.example/about-us', 70],
    ['https://pump.example/contact', 60],
    ['https://pump.example/products', 0],
  ])('scores people page %s as %s', (url, score) => {
    expect(scorePeoplePageUrl(url)).toBe(score);
  });

  it('fails closed before robots or egress when no broker is present', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DecisionMakerProvider({ gateway: {} as any });
    await expect(provider.findDecisionMakers({ domain: 'pump.example' }, ctx)).resolves.toEqual([]);
    expect(isAllowedByRobots).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    log.mockRestore();
  });

  it('stops before the home-page crawl when robots disallows the company', async () => {
    vi.mocked(isAllowedByRobots).mockResolvedValueOnce(false);
    const broker = { invoke: vi.fn() };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DecisionMakerProvider({ gateway: {} as any, broker: broker as any });
    await expect(provider.findDecisionMakers({ domain: 'pump.example' }, ctx)).resolves.toEqual([]);
    expect(broker.invoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('prioritizes linked people pages, merges duplicate people, and keeps source evidence', async () => {
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { url: string }) => {
        if (input.url === 'https://pump.example/') return crawl('<a>home</a>');
        return crawl(`public management content for ${input.url} ${'x'.repeat(180)}`);
      }),
    };
    vi.mocked(extractSameSiteLinks).mockReturnValue([
      'https://pump.example/about-us',
      'https://pump.example/team',
      'https://pump.example/contact',
      'https://pump.example/management',
      'https://pump.example/management',
      'https://pump.example/products',
    ]);
    vi.mocked(executeStructuredTaskWithRuntime)
      .mockResolvedValueOnce({ data: { people: [{
        full_name: ' Jane Doe ',
        title: ' CEO ',
        department: 'Management',
        seniority: 'C-level',
        buying_role: 'economic buyer',
        is_target_role: true,
      }] } } as any)
      .mockResolvedValueOnce({ data: { people: [
        { full_name: 'jane   doe', email: 'jane@pump.example', phone: '+493012345678' },
        { full_name: 'John Buyer', title: '', email: '', phone: '', is_target_role: false },
        { full_name: '   ', title: 'ignored' },
      ] } } as any)
      .mockResolvedValueOnce({ data: {} } as any)
      .mockRejectedValueOnce(new Error('model returned private response text'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DecisionMakerProvider({
      gateway: {} as any,
      broker: broker as any,
      runtimeTelemetry: {} as any,
    });

    const people = await provider.findDecisionMakers(
      { domain: 'pump.example', name: 'Pump GmbH' },
      ctx,
      { seller: 'Seller', target_roles: ['CPO'], offering: 'pump' },
    );

    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({
      fullName: 'Jane Doe',
      title: 'CEO',
      email: 'jane@pump.example',
      phone: '+493012345678',
      personalData: true,
      isTargetRole: true,
      parserVersion: 'decision_maker/v1',
    });
    expect(people[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(people[1]).toMatchObject({
      fullName: 'John Buyer',
      title: undefined,
      email: undefined,
      isTargetRole: false,
    });
    expect(broker.invoke).toHaveBeenCalledWith(
      'crawl4ai.fetch',
      { url: 'https://pump.example/management' },
      expect.objectContaining({
        workspaceId: ctx.workspaceId,
        taskContractId: 'contact.find_decision_makers',
        purpose: ['discovery', 'enrichment'],
      }),
    );
    const renderedLogs = JSON.stringify(log.mock.calls);
    expect(renderedLogs).toMatch(/ERROR_TEXT_SHA256:/);
    expect(renderedLogs).not.toContain('private response text');
    log.mockRestore();
  });

  it('uses fixed paths when home discovery fails and isolates page-level failures', async () => {
    let call = 0;
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { url: string }) => {
        call += 1;
        if (call === 1) throw new Error('home unavailable');
        if (input.url.endsWith('/kontakt')) throw new Error('page unavailable');
        if (input.url.endsWith('/en/imprint')) return crawl('short');
        return crawl(`${'valid public company text '.repeat(8)} ${input.url}`);
      }),
    };
    // Base allowed; /impressum disallowed; remaining page-level checks allowed.
    vi.mocked(isAllowedByRobots)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { people: [] } } as any);
    const provider = new DecisionMakerProvider({ gateway: {} as any, broker: broker as any });

    await expect(provider.findDecisionMakers({ domain: 'pump.example' }, ctx)).resolves.toEqual([]);

    expect(executeStructuredTaskWithRuntime).toHaveBeenCalledOnce();
    expect(broker.invoke).toHaveBeenCalledWith(
      'crawl4ai.fetch',
      { url: 'https://pump.example/impressum.html' },
      expect.anything(),
    );
  });

  it('maps contacts into the registry contract without changing personal-data classification', () => {
    expect(DecisionMakerProvider.toContactRecords([{
      fullName: 'Jane Doe',
      title: 'CEO',
      seniority: 'C-level',
      department: 'Management',
      email: 'jane@pump.example',
      phone: '+493012345678',
      buyingRole: 'economic buyer',
      isTargetRole: true,
      personalData: true,
      sourcePage: 'https://pump.example/impressum',
      contentHash: 'hash',
      parserVersion: 'decision_maker/v1',
    }])).toEqual([{
      externalId: 'https://pump.example/impressum#jane-doe',
      fullName: 'Jane Doe',
      title: 'CEO',
      seniority: 'C-level',
      department: 'Management',
      email: 'jane@pump.example',
      phone: '+493012345678',
      buyingRole: 'economic buyer',
      isTargetRole: true,
      personalData: true,
      sourcePage: 'https://pump.example/impressum',
    }]);
  });

  it('adapts domain-less and domain-backed companies with optional seller context', async () => {
    const broker = { invoke: vi.fn(async () => crawl('home')) };
    vi.mocked(isAllowedByRobots).mockResolvedValueOnce(false);
    const adapter = new DecisionMakerContactAdapter({ gateway: {} as any, broker: broker as any });
    await expect(adapter.discoverContacts({ name: 'No Domain' }, ctx)).resolves.toEqual({ contacts: [], costCents: 0 });
    await expect(adapter.discoverContacts(
      { name: 'Pump GmbH', domain: 'pump.example', country: 'DE' },
      ctx,
      { seller: 'Seller', targetRoles: ['CPO'], offering: 'pump' },
    )).resolves.toEqual({ contacts: [], costCents: 0 });
  });
});
