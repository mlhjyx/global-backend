import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import { ExecutionControlError } from '../../execution-budget/execution-control-error';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import { ModelDurableResultProjectionError } from '../../model-gateway/router-model-gateway';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import { DISCOVERY_COMPANY_RESULT_LINEAGE_V1 } from '../company-discovery-lineage';
import type { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';

const mocks = vi.hoisted(() => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: mocks.executeStructuredTaskWithRuntime,
}));

import { ModelWebSearchDiscoveryProvider } from './model-web-search.provider';

const AUTHORITY_ID = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const ACCOUNT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';

function receipt(operationId: string, resultSchema: string): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'discovery-run',
    authorityId: AUTHORITY_ID,
    accountId: ACCOUNT_ID,
    operationId,
    operationKey: `discovery:model_web_search:${operationId}`,
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

const SEARCH_RECEIPT = receipt('0267d7e1-89b5-4f37-8cdb-b7a6a05a9235', 'searxng-search/v1');
const MODEL_RECEIPT = receipt(
  'f9c22f2a-3578-4ed2-ac8b-0819e9147c40',
  'discovery-web-search-candidates/v1',
);

const query: CompanyDiscoveryQuery = {
  sourceClass: 'public_intelligence',
  filters: { industry: 'sheet metal working', country: 'DE' },
  keywords: ['laser cutting'],
  limit: 10,
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

/** First round asks for a search, second round answers with the candidate JSON. */
function chatGateway(answer: unknown): ModelGateway {
  let round = 0;
  return {
    generateChatWithTools: vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          data: {
            text: '',
            toolUses: [{ id: 'use-1', name: 'web_search', input: { query: 'laser cutting DE' } }],
            stopReason: 'tool_use' as const,
          },
          provider: 'stub',
          model: 'stub',
        };
      }
      return {
        data: { text: JSON.stringify(answer), toolUses: [], stopReason: 'end' as const },
        provider: 'stub',
        model: 'stub',
      };
    }),
  } as unknown as ModelGateway;
}

const hits = {
  data: {
    results: [
      { url: 'https://acme-maschinenbau.de/imprint', title: 'Acme Maschinenbau' },
      { url: 'https://acme-maschinenbau.de/laser', title: 'Laser cutting' },
    ],
  },
  costCents: 0,
  durableReceipt: SEARCH_RECEIPT,
};

const answer = {
  candidates: [
    {
      companyName: 'Acme Maschinenbau GmbH',
      domain: 'acme-maschinenbau.de',
      countryCode: 'DE',
      evidenceUrls: ['https://acme-maschinenbau.de/imprint'],
      query: 'laser cutting DE',
    },
    {
      companyName: 'Ghost Holding',
      domain: 'ghost-never-in-results.example',
      countryCode: 'DE',
      evidenceUrls: ['https://ghost-never-in-results.example/about'],
      query: 'laser cutting DE',
    },
  ],
};

describe('ModelWebSearchDiscoveryProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is off by default: returns a valid empty lineage without any call', async () => {
    const gateway = chatGateway(answer);
    const executionBroker = broker(async () => hits);
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway,
      broker: executionBroker,
      env: {},
    });

    const result = await provider.discoverCompanies(query, context());

    expect(provider.companyResultLineage).toBe(DISCOVERY_COMPANY_RESULT_LINEAGE_V1);
    expect(result.records).toEqual([]);
    expect(result.lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    });
    expect(gateway.generateChatWithTools).not.toHaveBeenCalled();
    expect(executionBroker.invoke).not.toHaveBeenCalled();
    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('fails safe without a gateway, still under a valid empty lineage', async () => {
    const provider = new ModelWebSearchDiscoveryProvider({ env: { MODEL_WEB_SEARCH_PROVIDER: 'on' } });

    const result = await provider.discoverCompanies(query, context());

    expect(result.records).toEqual([]);
    expect(result.lineage?.recordCount).toBe(0);
    expect(result.lineage?.attemptReceipts).toEqual([]);
  });

  it('keeps only candidates grounded in the actual search results and covers them with the confirm receipt', async () => {
    const parent = vi.fn();
    const executionBroker = broker(async (toolId, _input, ctx) => {
      expect(toolId).toBe('searxng.search');
      expect(ctx.taskContractId).toBe('discovery.web_search_candidates');
      ctx.onDurableReceipt?.('searxng.search', SEARCH_RECEIPT);
      return hits;
    });
    mocks.executeStructuredTaskWithRuntime.mockImplementation(
      async (
        _gateway: unknown,
        input: { task: string; prompt: string },
        ctx: { durableResultSchema?: string; onDurableReceipt?: (id: string, r: DurableExecutionReceipt) => void },
      ) => {
        expect(input.task).toBe('discovery.web_search_candidates');
        expect(input.prompt).toContain('acme-maschinenbau.de');
        expect(ctx.durableResultSchema).toBe('discovery-web-search-candidates/v1');
        ctx.onDurableReceipt?.('discovery.web_search_candidates', MODEL_RECEIPT);
        return { data: answer, provider: 'stub', model: 'stub' };
      },
    );
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway: chatGateway(answer),
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    const result = await provider.discoverCompanies(query, context(parent), {
      blockedDomains: [],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'model_web_search:acme-maschinenbau.de',
      name: 'Acme Maschinenbau GmbH',
      domain: 'acme-maschinenbau.de',
      country: 'DE',
    });
    expect(result.lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [],
      receiptCoverage: [
        expect.objectContaining({
          producerId: 'discovery.web_search_candidates',
          receipt: MODEL_RECEIPT,
          recordIndexes: [0],
        }),
      ],
    });
    // Both receipts reach the activity: the search one as auxiliary, the model one as the company lineage.
    expect(parent).toHaveBeenCalledWith('searxng.search', SEARCH_RECEIPT);
    expect(parent).toHaveBeenCalledWith('discovery.web_search_candidates', MODEL_RECEIPT);
  });

  it('never grounds a candidate on a bare-TLD host or a malformed domain', async () => {
    const tldOnlyHits = {
      data: { results: [{ url: 'https://de/landing', title: 'portal' }] },
      costCents: 0,
      durableReceipt: SEARCH_RECEIPT,
    };
    const executionBroker = broker(async () => tldOnlyHits);
    mocks.executeStructuredTaskWithRuntime.mockImplementation(
      async (
        _gateway: unknown,
        _input: unknown,
        ctx: { onDurableReceipt?: (id: string, r: DurableExecutionReceipt) => void },
      ) => {
        ctx.onDurableReceipt?.('discovery.web_search_candidates', MODEL_RECEIPT);
        return {
          data: {
            candidates: [
              {
                companyName: 'Acme Maschinenbau GmbH',
                domain: 'acme-maschinenbau.de',
                countryCode: 'DE',
                evidenceUrls: ['https://de/landing'],
                query: 'laser cutting DE',
              },
              {
                companyName: 'Bad Domain Inc',
                domain: 'not a domain',
                countryCode: null,
                evidenceUrls: ['https://de/landing'],
                query: 'laser cutting DE',
              },
            ],
          },
          provider: 'stub',
          model: 'stub',
        };
      },
    );
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway: chatGateway(answer),
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    const result = await provider.discoverCompanies(query, context());

    expect(result.records).toEqual([]);
    expect(result.lineage?.recordCount).toBe(0);
  });

  it('drops blocked domains', async () => {
    const executionBroker = broker(async () => hits);
    mocks.executeStructuredTaskWithRuntime.mockImplementation(
      async (
        _gateway: unknown,
        _input: unknown,
        ctx: { onDurableReceipt?: (id: string, r: DurableExecutionReceipt) => void },
      ) => {
        ctx.onDurableReceipt?.('discovery.web_search_candidates', MODEL_RECEIPT);
        return {
          data: { candidates: [answer.candidates[0]] },
          provider: 'stub',
          model: 'stub',
        };
      },
    );
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway: chatGateway({ candidates: [answer.candidates[0]] }),
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    const result = await provider.discoverCompanies(query, context(), {
      blockedDomains: ['acme-maschinenbau.de'],
    });

    expect(result.records).toEqual([]);
    expect(result.lineage?.recordCount).toBe(0);
  });

  it('a settled confirm failure becomes a zero-record lineage, never a void one', async () => {
    const executionBroker = broker(async () => hits);
    mocks.executeStructuredTaskWithRuntime.mockRejectedValue(
      new ModelDurableResultProjectionError('model-web-search:confirm'),
    );
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway: chatGateway(answer),
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    const result = await provider.discoverCompanies(query, context());

    expect(result.records).toEqual([]);
    expect(result.lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    });
  });

  it('lets execution control errors through', async () => {
    const executionBroker = broker(async () => hits);
    mocks.executeStructuredTaskWithRuntime.mockRejectedValue(
      new ExecutionControlError('EXECUTION_BUDGET_DENIED'),
    );
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway: chatGateway(answer),
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    await expect(provider.discoverCompanies(query, context())).rejects.toThrow(
      'EXECUTION_BUDGET_DENIED',
    );
  });

  it('explore failures leave the query a valid empty lineage', async () => {
    const executionBroker = broker(async () => hits);
    const gateway = {
      generateChatWithTools: vi.fn(async () => {
        throw new Error('upstream down');
      }),
    } as unknown as ModelGateway;
    const provider = new ModelWebSearchDiscoveryProvider({
      gateway,
      broker: executionBroker,
      env: { MODEL_WEB_SEARCH_PROVIDER: 'on' },
    });

    const result = await provider.discoverCompanies(query, context());

    expect(result.records).toEqual([]);
    expect(result.lineage?.recordCount).toBe(0);
    expect(mocks.executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });
});
