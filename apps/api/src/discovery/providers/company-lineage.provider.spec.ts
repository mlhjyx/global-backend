import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
} from '../company-discovery-lineage';
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

import { DirectoryDiscoveryProvider } from './directory.provider';
import { PublicWebDiscoveryProvider } from './public-web.provider';
import { TradeFairDiscoveryProvider } from './trade-fair.provider';

const AUTHORITY_ID = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const ACCOUNT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';

function receipt(
  operationId: string,
  resultSchema: string,
): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'discovery-run',
    authorityId: AUTHORITY_ID,
    accountId: ACCOUNT_ID,
    operationId,
    operationKey: `discovery:company:${operationId}`,
    resultStrategy: 'typed_projection',
    resultSchema,
    resultDigest: operationId.replaceAll('-', '').padEnd(64, 'b').slice(0, 64),
    artifactId: null,
    usage: Object.freeze({
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      upperBoundMicrousd: '0',
    }),
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  });
}

const SEARCH_RECEIPT = receipt(
  '0267d7e1-89b5-4f37-8cdb-b7a6a05a9235',
  'searxng-search/v1',
);
const CRAWL_RECEIPT = receipt(
  '15c41486-746a-4aab-b54a-b739647e9a3d',
  'crawl4ai-fetch/v1',
);
const MODEL_A = receipt(
  'f9c22f2a-3578-4ed2-ac8b-0819e9147c40',
  'discovery-extract-company/v1',
);
const MODEL_B = receipt(
  '2e09726e-16de-42c5-875c-92d02cf58df0',
  'discovery-extract-list/v1',
);
const MODEL_C = receipt(
  '897b8c13-c50b-49bc-8a82-cb58cd40c010',
  'discovery-extract-list/v1',
);
const FAIR_RECEIPT = receipt(
  'c28595b4-9880-4134-bec4-4166d69f4900',
  'tradefair-algolia/v1',
);

const query: CompanyDiscoveryQuery = {
  sourceClass: 'industry_data',
  filters: { industry: 'sheet metal working', region: 'Germany' },
  keywords: ['laser cutting'],
  limit: 20,
};

const context = (onDurableReceipt = vi.fn()): ExecutionContext => ({
  workspaceId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  runId: '693de0dc-5474-4d19-9270-83694bfeea09',
  onDurableReceipt,
});

function broker(
  invoke: (toolId: string, input: unknown, ctx: ToolContext) => Promise<ToolResult<unknown>>,
): ExecutionBroker {
  return {
    checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
    invoke: vi.fn(invoke) as ExecutionBroker['invoke'],
  };
}

describe('provider-owned company receipt lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAllowedByRobots.mockResolvedValue(true);
  });

  it('trade-fair emits only tradefair.algolia coverage and forwards its receipt once', async () => {
    const parent = vi.fn();
    const executionBroker = broker(async (toolId, _input, ctx) => {
      expect(toolId).toBe('tradefair.algolia');
      ctx.onDurableReceipt?.(toolId, FAIR_RECEIPT);
      return {
        data: {
          exhibitors: [
            { externalId: 'a', companyName: 'Acme', website: 'https://acme.test' },
            { externalId: 'a-duplicate', companyName: 'Acme duplicate', website: 'https://acme.test' },
          ],
        },
        costCents: 0,
        durableReceipt: FAIR_RECEIPT,
      };
    });
    const provider = new TradeFairDiscoveryProvider({ broker: executionBroker });

    const result = await provider.discoverCompanies(query, context(parent));

    expect(provider.companyResultLineage).toBe(DISCOVERY_COMPANY_RESULT_LINEAGE_V1);
    expect(result.records).toHaveLength(1);
    expect(result.lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [],
      receiptCoverage: [{
        producerId: 'tradefair.algolia',
        receipt: FAIR_RECEIPT,
        recordIndexes: [0],
      }],
    });
    expect(parent).toHaveBeenCalledOnce();
    expect(parent).toHaveBeenCalledWith('tradefair.algolia', FAIR_RECEIPT);
  });

  it('trade-fair records a settled empty physical call as an attempt', async () => {
    const executionBroker = broker(async (toolId, _input, ctx) => {
      ctx.onDurableReceipt?.(toolId, FAIR_RECEIPT);
      return { data: { exhibitors: [] }, costCents: 0, durableReceipt: FAIR_RECEIPT };
    });
    const result = await new TradeFairDiscoveryProvider({ broker: executionBroker })
      .discoverCompanies(query, context());
    expect(result.records).toEqual([]);
    expect(result.lineage?.attemptReceipts).toEqual([
      { producerId: 'tradefair.algolia', receipt: FAIR_RECEIPT },
    ]);
    expect(result.lineage?.receiptCoverage).toEqual([]);
  });

  it('trade-fair keeps non-invoked exits explicit and invoked missing receipts fail closed', async () => {
    const noBroker = await new TradeFairDiscoveryProvider()
      .discoverCompanies(query, context());
    expect(noBroker.lineage?.recordCount).toBe(0);

    const executionBroker = broker(async () => {
      throw new Error('upstream failed before settlement');
    });
    const missing = await new TradeFairDiscoveryProvider({ broker: executionBroker })
      .discoverCompanies(query, context());
    expect(missing).not.toHaveProperty('lineage');

    const noFair = await new TradeFairDiscoveryProvider({ broker: executionBroker })
      .discoverCompanies({ ...query, filters: {}, keywords: [] }, context());
    expect(noFair.lineage?.recordCount).toBe(0);
  });

  it('trade-fair propagates malformed duplicate receipt callbacks', async () => {
    const executionBroker = broker(async (toolId, _input, ctx) => {
      ctx.onDurableReceipt?.(toolId, FAIR_RECEIPT);
      ctx.onDurableReceipt?.(toolId, FAIR_RECEIPT);
      return { data: { exhibitors: [] }, costCents: 0 };
    });
    await expect(new TradeFairDiscoveryProvider({ broker: executionBroker })
      .discoverCompanies(query, context()))
      .rejects.toThrow('DISCOVERY_COMPANY_LINEAGE_INVALID');
  });

  it('public-web excludes search/crawl receipts and covers only the final model record', async () => {
    const parent = vi.fn();
    const executionBroker = broker(async (toolId, _input, ctx) => {
      if (toolId === 'searxng.search') {
        ctx.onDurableReceipt?.(toolId, SEARCH_RECEIPT);
        return {
          data: { results: [{ url: 'https://acme.test/', title: 'Acme' }] },
          costCents: 0,
          durableReceipt: SEARCH_RECEIPT,
        };
      }
      ctx.onDurableReceipt?.(toolId, CRAWL_RECEIPT);
      return {
        data: { text: 'Acme industrial pump manufacturer '.repeat(20) },
        costCents: 0,
        durableReceipt: CRAWL_RECEIPT,
      };
    });
    mocks.executeStructuredTaskWithRuntime.mockImplementation(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_A);
        return {
          data: { is_company_site: true, name: 'Acme GmbH' },
          provider: 'gateway',
          model: 'model',
          durableReceipt: MODEL_A,
          runtimeExecution: {},
        };
      },
    );

    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: executionBroker,
    });
    const result = await provider.discoverCompanies(query, context(parent));

    expect(provider.companyResultLineage).toBe(DISCOVERY_COMPANY_RESULT_LINEAGE_V1);
    expect(result.records).toHaveLength(1);
    expect(result.lineage?.receiptCoverage).toEqual([{
      producerId: 'discovery.extract_company',
      receipt: MODEL_A,
      recordIndexes: [0],
    }]);
    expect(result.lineage?.attemptReceipts).toEqual([]);
    expect(JSON.stringify(result.lineage)).not.toContain(SEARCH_RECEIPT.operationId);
    expect(JSON.stringify(result.lineage)).not.toContain(CRAWL_RECEIPT.operationId);
    expect(parent.mock.calls.filter(([producer]) => producer === 'discovery.extract_company'))
      .toEqual([['discovery.extract_company', MODEL_A]]);
  });

  it('omits the entire public-web lineage when the expected model call returns no receipt', async () => {
    const executionBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://acme.test/', title: 'Acme' }] }, costCents: 0 }
      : { data: { text: 'Acme industrial pump manufacturer '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockResolvedValue({
      data: { is_company_site: true, name: 'Acme GmbH' },
      provider: 'gateway',
      model: 'model',
      runtimeExecution: {},
    });
    const result = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: executionBroker,
    }).discoverCompanies(query, context());

    expect(result.records).toHaveLength(1);
    expect(result).not.toHaveProperty('lineage');
  });

  it('returns an empty public-web lineage when robots prevents the model invocation', async () => {
    mocks.isAllowedByRobots.mockResolvedValue(false);
    const executionBroker = broker(async () => ({
      data: { results: [{ url: 'https://acme.test/', title: 'Acme' }] },
      costCents: 0,
    }));
    const result = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: executionBroker,
    }).discoverCompanies(query, context());

    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
    expect(result.lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    });
  });

  it('public-web covers no-broker, too-short, ordinary rejection and settled no-output paths', async () => {
    const noBroker = await new PublicWebDiscoveryProvider({ gateway: {} as never })
      .discoverCompanies(query, context());
    expect(noBroker.lineage?.recordCount).toBe(0);

    const tooShortBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://short.test/', title: 'Short' }] }, costCents: 0 }
      : { data: { text: 'short' }, costCents: 0 });
    const tooShort = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: tooShortBroker,
    }).discoverCompanies(query, context());
    expect(tooShort.lineage?.recordCount).toBe(0);

    mocks.isAllowedByRobots.mockRejectedValueOnce(new Error('robots unavailable'));
    const rejected = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: tooShortBroker,
    }).discoverCompanies(query, context());
    expect(rejected.lineage?.recordCount).toBe(0);

    const settledBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://noncompany.test/', title: 'Candidate' }] }, costCents: 0 }
      : { data: { text: 'candidate content '.repeat(30) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockImplementationOnce(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_A);
        return {
          data: { is_company_site: false },
          provider: 'gateway',
          model: 'model',
          runtimeExecution: {},
        };
      },
    );
    const noOutput = await new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: settledBroker,
    }).discoverCompanies(query, context());
    expect(noOutput.lineage?.attemptReceipts).toEqual([
      { producerId: 'discovery.extract_company', receipt: MODEL_A },
    ]);
  });

  it('public-web propagates malformed company callback lineage', async () => {
    const executionBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://acme.test/', title: 'Acme' }] }, costCents: 0 }
      : { data: { text: 'Acme industrial pump manufacturer '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockImplementationOnce(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_A);
        ctx.onDurableReceipt?.(input.task, MODEL_A);
        throw new Error('unreachable');
      },
    );
    await expect(new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: executionBroker,
    }).discoverCompanies(query, context()))
      .rejects.toThrow('DISCOVERY_COMPANY_LINEAGE_INVALID');
  });

  it('public-web logs only a stable failure class for a secret-bearing model error', async () => {
    const executionBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://secret-domain.test/', title: 'Candidate' }] }, costCents: 0 }
      : { data: { text: 'candidate content '.repeat(30) }, costCents: 0 });
    const sensitiveErrorText = [
      'Bearer',
      'test-credential',
      'token=redacted',
      'https://private.invalid/prompt-response',
    ].join(' ');
    mocks.executeStructuredTaskWithRuntime.mockRejectedValueOnce(
      new Error(sensitiveErrorText),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let serialized: string;

    try {
      const result = await new PublicWebDiscoveryProvider({
        gateway: {} as never,
        broker: executionBroker,
      }).discoverCompanies(query, context());
      expect(result.records).toEqual([]);
    } finally {
      serialized = log.mock.calls.flat().join(' ');
      log.mockRestore();
    }

    expect(serialized).toContain('[public_web] skip: extract failed (ERROR)');
    expect(serialized).not.toMatch(
      /Bearer|test-credential|token=redacted|secret-domain|private\.invalid|prompt-response/u,
    );
  });

  it('public-web passes hostile getter and descriptor-trap failures through without logging', async () => {
    const executionBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://hostile.test/', title: 'Candidate' }] }, costCents: 0 }
      : { data: { text: 'candidate content '.repeat(30) }, costCents: 0 });
    let getterCalls = 0;
    const hostileGetter = Object.defineProperty({}, 'code', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'sensitive-getter-payload';
      },
    });
    const hostileProxy = new Proxy(Object.create(null), {
      ownKeys() {
        throw new Error('sensitive-descriptor-payload');
      },
    });
    mocks.executeStructuredTaskWithRuntime
      .mockRejectedValueOnce(hostileGetter)
      .mockRejectedValueOnce(hostileProxy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const caught: unknown[] = [];

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await new PublicWebDiscoveryProvider({
            gateway: {} as never,
            broker: executionBroker,
          }).discoverCompanies(query, context());
        } catch (error) {
          caught.push(error);
        }
      }
      expect(caught[0]).toBe(hostileGetter);
      expect(caught[1]).toBe(hostileProxy);
      expect(getterCalls).toBe(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('directory applies first-wins final dedup indexes to each physical extract-list receipt', async () => {
    const parent = vi.fn();
    const executionBroker = broker(async (toolId, _input, ctx) => {
      if (toolId === 'searxng.search') {
        return {
          data: { results: [
            { url: 'https://directory.test/members-a', title: 'Members directory A' },
            { url: 'https://directory.test/members-b', title: 'Members directory B' },
          ] },
          costCents: 0,
        };
      }
      ctx.onDurableReceipt?.(toolId, CRAWL_RECEIPT);
      return { data: { text: 'Directory member companies '.repeat(20) }, costCents: 0 };
    });
    mocks.executeStructuredTaskWithRuntime.mockImplementation(
      async (_gateway, input, ctx) => {
        const second = input.prompt.includes('members-b');
        const settled = second ? MODEL_C : MODEL_B;
        ctx.onDurableReceipt?.(input.task, settled);
        return {
          data: {
            is_directory: true,
            companies: second
              ? [
                  { name: 'Acme duplicate', website: 'https://acme.test' },
                  { name: 'Charlie', website: 'https://charlie.test' },
                ]
              : [
                  { name: 'Acme', website: 'https://acme.test' },
                  { name: 'Bravo', website: 'https://bravo.test' },
                ],
            has_next_page: false,
          },
          provider: 'gateway',
          model: 'model',
          durableReceipt: settled,
          runtimeExecution: {},
        };
      },
    );
    const provider = new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: executionBroker,
    });

    const result = await provider.discoverCompanies(query, context(parent));

    expect(provider.companyResultLineage).toBe(DISCOVERY_COMPANY_RESULT_LINEAGE_V1);
    expect(result.records.map((record) => record.domain)).toEqual([
      'acme.test',
      'bravo.test',
      'charlie.test',
    ]);
    expect(result.lineage?.receiptCoverage).toEqual([
      {
        producerId: 'discovery.extract_list',
        receipt: MODEL_B,
        recordIndexes: [0, 1],
      },
      {
        producerId: 'discovery.extract_list',
        receipt: MODEL_C,
        recordIndexes: [2],
      },
    ]);
    expect(result.lineage?.attemptReceipts).toEqual([]);
    expect(parent.mock.calls.filter(([producer]) => producer === 'discovery.extract_list'))
      .toEqual([
        ['discovery.extract_list', MODEL_B],
        ['discovery.extract_list', MODEL_C],
      ]);
  });

  it('directory preserves early exits and omits lineage after an invoked model lacks a receipt', async () => {
    const noBroker = await new DirectoryDiscoveryProvider({ gateway: {} as never })
      .discoverCompanies(query, context());
    expect(noBroker.lineage?.recordCount).toBe(0);

    const noListingBroker = broker(async () => ({ data: { results: [] }, costCents: 0 }));
    const noListing = await new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: noListingBroker,
    }).discoverCompanies(query, context());
    expect(noListing.lineage?.recordCount).toBe(0);

    const listingBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? {
          data: { results: [{
            url: 'https://directory.test/members',
            title: 'Members directory',
          }] },
          costCents: 0,
        }
      : { data: { text: 'Directory member companies '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockResolvedValueOnce({
      data: {
        is_directory: true,
        companies: [{ name: 'No website company' }],
        has_next_page: false,
      },
      provider: 'gateway',
      model: 'model',
      runtimeExecution: {},
    });
    const missing = await new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: listingBroker,
    }).discoverCompanies(query, context());
    expect(missing.records).toHaveLength(1);
    expect(missing).not.toHaveProperty('lineage');
  });

  it('directory propagates malformed company callback lineage', async () => {
    const listingBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? {
          data: { results: [{
            url: 'https://directory.test/members',
            title: 'Members directory',
          }] },
          costCents: 0,
        }
      : { data: { text: 'Directory member companies '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockImplementationOnce(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_B);
        ctx.onDurableReceipt?.(input.task, MODEL_B);
        throw new Error('unreachable');
      },
    );
    await expect(new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: listingBroker,
    }).discoverCompanies(query, context()))
      .rejects.toThrow('DISCOVERY_COMPANY_LINEAGE_INVALID');
  });

  it('all three providers rethrow the exact parent forwarding failure without returning records', async () => {
    const parentFailure = new Error('parent unavailable');
    const parent = vi.fn(() => {
      throw parentFailure;
    });

    const fairBroker = broker(async (toolId, _input, ctx) => {
      ctx.onDurableReceipt?.(toolId, FAIR_RECEIPT);
      return {
        data: { exhibitors: [{
          externalId: 'preserved-fair',
          companyName: 'Preserved Fair GmbH',
          website: 'https://preserved-fair.test',
        }] },
        costCents: 0,
      };
    });
    await expect(new TradeFairDiscoveryProvider({ broker: fairBroker })
      .discoverCompanies(query, context(parent))).rejects.toBe(parentFailure);

    const publicBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? { data: { results: [{ url: 'https://preserved-web.test/', title: 'Preserved' }] }, costCents: 0 }
      : { data: { text: 'Preserved industrial company '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockImplementationOnce(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_A);
        return {
          data: { is_company_site: true, name: 'Preserved Web GmbH' },
          provider: 'gateway',
          model: 'model',
          runtimeExecution: {},
        };
      },
    );
    await expect(new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: publicBroker,
    }).discoverCompanies(query, context(parent))).rejects.toBe(parentFailure);

    const directoryBroker = broker(async (toolId) => toolId === 'searxng.search'
      ? {
          data: { results: [{
            url: 'https://preserved-directory.test/members',
            title: 'Members directory',
          }] },
          costCents: 0,
        }
      : { data: { text: 'Preserved directory companies '.repeat(20) }, costCents: 0 });
    mocks.executeStructuredTaskWithRuntime.mockImplementationOnce(
      async (_gateway, input, ctx) => {
        ctx.onDurableReceipt?.(input.task, MODEL_B);
        return {
          data: {
            is_directory: true,
            companies: [{ name: 'Preserved Directory GmbH', website: 'https://preserved.test' }],
            has_next_page: false,
          },
          provider: 'gateway',
          model: 'model',
          runtimeExecution: {},
        };
      },
    );
    await expect(new DirectoryDiscoveryProvider({
      gateway: {} as never,
      broker: directoryBroker,
    }).discoverCompanies(query, context(parent))).rejects.toBe(parentFailure);

    expect(parent).toHaveBeenCalledTimes(3);
  });
});
