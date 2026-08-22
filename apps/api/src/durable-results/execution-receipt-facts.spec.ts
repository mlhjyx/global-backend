import { describe, expect, it } from 'vitest';
import {
  RECEIPT_FACT_MODEL_TASK_IDS,
  RECEIPT_FACT_TOOL_IDS,
  artifactExecutionReceiptFacts,
  modelExecutionReceiptFacts,
  toolExecutionReceiptFacts,
} from './execution-receipt-facts';

const toolResult = (data: unknown, costCents = 2) => ({ data, costCents });
const modelResult = (overrides: Record<string, unknown> = {}) => ({
  data: { ok: true },
  provider: 'test',
  model: 'test-model',
  ...overrides,
});

describe('execution receipt fact producers', () => {
  it('locks explicit fact producers to all 18 Tools and 10 Model tasks', () => {
    expect(RECEIPT_FACT_TOOL_IDS).toHaveLength(18);
    expect(RECEIPT_FACT_MODEL_TASK_IDS).toHaveLength(10);
    expect(new Set(RECEIPT_FACT_TOOL_IDS).size).toBe(18);
    expect(new Set(RECEIPT_FACT_MODEL_TASK_IDS).size).toBe(10);
  });

  it.each(RECEIPT_FACT_TOOL_IDS.filter((id) => id !== 'google_patents.search'))(
    'uses an explicit declared upper bound for %s without inferring cost from result cents',
    (toolId) => {
      expect(toolExecutionReceiptFacts({
        toolId,
        resultSchema: 'searxng-search/v1',
        result: toolResult({ ok: true }, 999),
        reservedMicrousd: 20_000n,
        chargedMicrousd: 999_0000n,
      })).toEqual({
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 1,
          upperBoundMicrousd: '20000',
        },
        costBasis: 'estimated_upper_bound',
      });
    },
  );

  it.each([
    {
      costFacts: {
        costBasis: 'not_incurred', maximumBytesBilled: '0',
        observedBytesBilled: null, maxRows: 0,
      },
      expected: {
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 0,
          chargedMicrousd: '0', upperBoundMicrousd: '0',
        },
        costBasis: 'not_incurred',
      },
    },
    {
      costFacts: {
        costBasis: 'provider_reported', maximumBytesBilled: '1000',
        observedBytesBilled: '512', maxRows: 50,
      },
      expected: {
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 1,
          bytesBilled: '512', maximumBytesBilled: '1000',
          chargedMicrousd: '12000', upperBoundMicrousd: '20000',
        },
        costBasis: 'provider_reported',
      },
    },
    {
      costFacts: {
        costBasis: 'estimated_upper_bound', maximumBytesBilled: '1000',
        observedBytesBilled: null, maxRows: 50,
      },
      expected: {
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 1,
          maximumBytesBilled: '1000', upperBoundMicrousd: '20000',
        },
        costBasis: 'estimated_upper_bound',
      },
    },
  ])('preserves canonical Patent $costFacts.costBasis facts', ({ costFacts, expected }) => {
    expect(toolExecutionReceiptFacts({
      toolId: 'google_patents.search',
      resultSchema: 'google-patents-search/v1',
      result: toolResult({ patents: [], costFacts }),
      reservedMicrousd: 20_000n,
      chargedMicrousd: 12_000n,
    })).toEqual(expected);
  });

  it.each([
    { costBasis: 'provider_reported', maximumBytesBilled: '100', observedBytesBilled: null, maxRows: 50 },
    { costBasis: 'estimated_upper_bound', maximumBytesBilled: '100', observedBytesBilled: '1', maxRows: 50 },
    { costBasis: 'not_incurred', maximumBytesBilled: '1', observedBytesBilled: null, maxRows: 0 },
    { costBasis: 'provider_reported', maximumBytesBilled: '100', observedBytesBilled: '101', maxRows: 50 },
  ])('rejects contradictory Patent cost facts %#', (costFacts) => {
    expect(() => toolExecutionReceiptFacts({
      toolId: 'google_patents.search',
      resultSchema: 'google-patents-search/v1',
      result: toolResult({ patents: [], costFacts }),
      reservedMicrousd: 20_000n,
      chargedMicrousd: 12_000n,
    })).toThrow('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  });

  it('uses explicit Model tokens when present and a declared upper bound when absent', () => {
    expect(modelExecutionReceiptFacts({
      taskId: 'taxonomy.normalize',
      resultSchema: 'taxonomy-code/v1',
      result: modelResult({ usage: { outputTokens: 3 }, callCount: 1 }),
      reservedMicrousd: 40_000n,
      chargedMicrousd: 10_000n,
    })).toEqual({
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 1,
        outputTokens: 3, chargedMicrousd: '10000',
        upperBoundMicrousd: '40000',
      },
      costBasis: 'token_pricing',
    });
    expect(modelExecutionReceiptFacts({
      taskId: 'taxonomy.normalize',
      resultSchema: 'taxonomy-code/v1',
      result: modelResult({ callCount: 2 }),
      reservedMicrousd: 40_000n,
      chargedMicrousd: 20_000n,
    })).toEqual({
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 2,
        upperBoundMicrousd: '40000',
      },
      costBasis: 'estimated_upper_bound',
    });
  });

  it('produces artifact-reference upper-bound facts without payload data', () => {
    expect(artifactExecutionReceiptFacts({
      resultSchema: 'http-get/v1',
      reservedMicrousd: 30_000n,
    })).toEqual({
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 1,
        upperBoundMicrousd: '30000',
      },
      costBasis: 'estimated_upper_bound',
    });
  });
});
