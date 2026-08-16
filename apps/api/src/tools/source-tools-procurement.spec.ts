import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PublicHttpDependencies,
  PublicHttpRequestOptions,
  PublicHttpResponse,
} from '../adapters/guarded-http';

const { requestPublicHttpMock } = vi.hoisted(() => ({ requestPublicHttpMock: vi.fn() }));

vi.mock('../adapters/guarded-http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/guarded-http')>();
  return { ...actual, requestPublicHttp: requestPublicHttpMock };
});
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import {
  brazilPncpSearchTool,
  registerSourceTools,
  singaporeGebizSearchTool,
  ukContractsFinderSearchTool,
  ukFtsSearchTool,
  usaSpendingSearchTool,
  worldBankProcurementTool,
} from './source-tools';

beforeEach(() => {
  requestPublicHttpMock.mockReset();
  requestPublicHttpMock.mockImplementation(async (
    raw: string,
    options: PublicHttpRequestOptions,
    dependencies: PublicHttpDependencies,
  ): Promise<PublicHttpResponse> => {
    await dependencies.beforeRequest?.();
    const response = await fetch(new URL(raw), {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      text: body.toString('utf8'),
      finalUrl: raw,
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('public procurement ToolBroker boundary', () => {
  const tools = [
    [worldBankProcurementTool, 'search.worldbank.org', 'world_bank_procurement'],
    [usaSpendingSearchTool, 'api.usaspending.gov', 'usaspending_awards'],
    [ukFtsSearchTool, 'www.find-tender.service.gov.uk', 'uk_find_a_tender'],
    [brazilPncpSearchTool, 'pncp.gov.br', 'brazil_pncp'],
    [singaporeGebizSearchTool, 'data.gov.sg', 'singapore_gebiz'],
    [ukContractsFinderSearchTool, 'www.contractsfinder.service.gov.uk', 'uk_contracts_finder'],
  ] as const;

  it('registers every procurement tool as a required, read-only, bounded source', () => {
    const registry = registerSourceTools(new ToolRegistry());
    for (const [tool, domain, providerKey] of tools) {
      expect(registry.get(tool.id)).toBe(tool);
      expect(tool.compliance).toMatchObject({
        sourcePolicy: 'required',
        policyDomain: domain,
        providerKey,
        allowedPurpose: ['discovery'],
        reversible: true,
        authRequired: false,
      });
      expect(tool.rateLimit).toMatchObject({ rps: 1, concurrency: 1 });
    }
  });

  it('fails before fetch when the exact source domain is suspended', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();
    registry.register(worldBankProcurementTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async (domain) =>
        domain === 'search.worldbank.org'
          ? { suspended: true, allowedPurpose: ['discovery'] }
          : null,
    });

    await expect(
      broker.invoke(
        worldBankProcurementTool.id,
        { keywords: ['pump'], country: 'Kenya', offset: 0, limit: 10 },
        { workspaceId: 'workspace-test', purpose: 'discovery' },
      ),
    ).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps USAspending blocked before fetch while its source policy is suspended', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();
    registry.register(usaSpendingSearchTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async (domain) =>
        domain === 'api.usaspending.gov'
          ? { suspended: true, allowedPurpose: ['discovery'] }
          : null,
    });

    await expect(
      broker.invoke(
        usaSpendingSearchTool.id,
        { keywords: ['pump'], startDate: '2024-08-13', endDate: '2026-08-13', page: 1, limit: 10 },
        { workspaceId: 'workspace-test', purpose: 'discovery' },
      ),
    ).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops before a retry when the source policy is suspended between physical requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"detail":"unavailable"}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();
    registry.register(worldBankProcurementTool);
    let policyReads = 0;
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({
        suspended: ++policyReads >= 3,
        allowedPurpose: ['discovery'],
      }),
    });

    const pending = broker.invoke(
      worldBankProcurementTool.id,
      { keywords: ['pump'], country: 'Kenya', offset: 0, limit: 10 },
      { workspaceId: 'workspace-test', purpose: 'discovery' },
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(ToolPolicyDenied);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(policyReads).toBe(3);
  });

  it('preserves actual response provenance through the Tool result', async () => {
    const body = JSON.stringify({
      total: 1,
      procnotices: [{
        id: 'OP-1',
        contact_organization: 'Water Project Unit',
        project_ctry_name: 'Kenya',
        bid_description: 'Industrial pump package',
      }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const result = await worldBankProcurementTool.execute(
      { keywords: ['pump'], country: 'Kenya', offset: 0, limit: 10 },
      { workspaceId: 'workspace-test', purpose: 'discovery' },
    );

    expect(result.data.records).toHaveLength(1);
    expect(result.provenance).toBe(result.data.provenance);
    expect(result.provenance).toMatchObject({
      sourceUrl: expect.stringContaining('search.worldbank.org/api/v2/procnotices'),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      parserVersion: 'world-bank-procurement/v1',
    });
  });
});
