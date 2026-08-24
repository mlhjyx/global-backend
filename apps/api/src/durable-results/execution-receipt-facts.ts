import type { ModelResult } from '../model-gateway/types';
import type { ToolResult } from '../tools/tool-contract';
import {
  parseDurableExecutionReceiptFacts,
  type DurableExecutionReceiptFacts,
} from './durable-execution-receipt';

export const RECEIPT_FACT_TOOL_IDS = Object.freeze([
  'searxng.search',
  'crawl4ai.fetch',
  'wikidata.sparql',
  'osm.overpass',
  'smtp.rcpt_probe',
  'crawl4ai.render',
  'http.get',
  'wikidata.entity',
  'gleif.fetch',
  'ted.search',
  'openfda.search',
  'companies_house.search',
  'inpi_rne.search',
  'google_patents.search',
  'tradefair.algolia',
  'mapyourshow.fetch',
  'samgov.search',
  'sanctions.download',
] as const);

export const RECEIPT_FACT_MODEL_TASK_IDS = Object.freeze([
  'company_understanding.extract_claims',
  'company_understanding.extract_profile',
  'company_understanding.extract_offerings',
  'icp.design',
  'discovery.query_plan',
  'taxonomy.normalize',
  'discovery.qualify_fit',
  'discovery.extract_company',
  'discovery.extract_list',
  'contact.find_decision_makers',
] as const);

type PatentCostBasis = 'not_incurred' | 'provider_reported' | 'estimated_upper_bound';

interface PatentCostFacts {
  readonly costBasis: PatentCostBasis;
  readonly maximumBytesBilled: string;
  readonly observedBytesBilled: string | null;
  readonly maxRows: number;
}

const DECIMAL = /^(0|[1-9][0-9]{0,39})$/u;

function microusd(value: bigint): string {
  if (value < 0n) throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  return value.toString();
}

function patentCostFacts(result: ToolResult<unknown>): PatentCostFacts {
  const data = result.data as { readonly costFacts?: unknown };
  const value = data?.costFacts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !==
    'costBasis,maxRows,maximumBytesBilled,observedBytesBilled') {
    throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  }
  const basis = record.costBasis;
  const maximum = record.maximumBytesBilled;
  const observed = record.observedBytesBilled;
  const maxRows = record.maxRows;
  if (
    !['not_incurred', 'provider_reported', 'estimated_upper_bound'].includes(String(basis)) ||
    typeof maximum !== 'string' || !DECIMAL.test(maximum) ||
    !(observed === null || typeof observed === 'string' && DECIMAL.test(observed)) ||
    !Number.isSafeInteger(maxRows) || (maxRows as number) < 0 || (maxRows as number) > 50 ||
    observed !== null && BigInt(observed) > BigInt(maximum)
  ) {
    throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  }
  if (
    basis === 'not_incurred' && (maximum !== '0' || observed !== null || maxRows !== 0) ||
    basis === 'provider_reported' && observed === null ||
    basis === 'estimated_upper_bound' && observed !== null
  ) {
    throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
  }
  return Object.freeze({
    costBasis: basis as PatentCostBasis,
    maximumBytesBilled: maximum,
    observedBytesBilled: observed,
    maxRows: maxRows as number,
  });
}

export function toolExecutionReceiptFacts(input: {
  readonly toolId: string;
  readonly resultSchema: string;
  readonly result: ToolResult<unknown>;
  readonly reservedMicrousd: bigint;
  readonly chargedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  if (input.toolId === 'google_patents.search') {
    const facts = patentCostFacts(input.result);
    if (facts.costBasis === 'not_incurred') {
      return parseDurableExecutionReceiptFacts({
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 0,
          chargedMicrousd: '0', upperBoundMicrousd: '0',
        },
        costBasis: 'not_incurred',
      }, input.resultSchema);
    }
    if (facts.costBasis === 'provider_reported') {
      return parseDurableExecutionReceiptFacts({
        usage: {
          currency: 'USD', unit: 'microusd', callCount: 1,
          bytesBilled: facts.observedBytesBilled,
          maximumBytesBilled: facts.maximumBytesBilled,
          chargedMicrousd: microusd(input.chargedMicrousd),
          upperBoundMicrousd: microusd(input.reservedMicrousd),
        },
        costBasis: 'provider_reported',
      }, input.resultSchema);
    }
    return parseDurableExecutionReceiptFacts({
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 1,
        maximumBytesBilled: facts.maximumBytesBilled,
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: 'estimated_upper_bound',
    }, input.resultSchema);
  }
  return parseDurableExecutionReceiptFacts({
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      upperBoundMicrousd: microusd(input.reservedMicrousd),
    },
    costBasis: 'estimated_upper_bound',
  }, input.resultSchema);
}

export function modelExecutionReceiptFacts(input: {
  readonly taskId: string;
  readonly resultSchema: string;
  readonly result: ModelResult<unknown>;
  readonly reservedMicrousd: bigint;
  readonly chargedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  const inputTokens = input.result.usage?.inputTokens;
  const outputTokens = input.result.usage?.outputTokens;
  const providerCostUsd = input.result.usage?.costUsd;
  const callCount = input.result.callCount ?? 1;
  const validInputTokens =
    inputTokens === undefined || Number.isSafeInteger(inputTokens) && inputTokens >= 0;
  const validOutputTokens =
    outputTokens === undefined || Number.isSafeInteger(outputTokens) && outputTokens >= 0;
  const tokenCountAvailable =
    validInputTokens && validOutputTokens &&
    (inputTokens ?? 0) + (outputTokens ?? 0) > 0;
  const providerCostAvailable =
    Number.isFinite(providerCostUsd) && (providerCostUsd as number) >= 0;
  if (providerCostAvailable) {
    return parseDurableExecutionReceiptFacts({
      usage: {
        currency: 'USD', unit: 'microusd', callCount,
        ...(inputTokens === undefined || !validInputTokens ? {} : { inputTokens }),
        ...(outputTokens === undefined || !validOutputTokens ? {} : { outputTokens }),
        chargedMicrousd: microusd(input.chargedMicrousd),
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: 'provider_reported',
    }, input.resultSchema);
  }
  if (tokenCountAvailable) {
    return parseDurableExecutionReceiptFacts({
      usage: {
        currency: 'USD', unit: 'microusd', callCount,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        chargedMicrousd: microusd(input.chargedMicrousd),
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: 'token_pricing',
    }, input.resultSchema);
  }
  return parseDurableExecutionReceiptFacts({
    usage: {
      currency: 'USD', unit: 'microusd', callCount,
      upperBoundMicrousd: microusd(input.reservedMicrousd),
    },
    costBasis: 'estimated_upper_bound',
  }, input.resultSchema);
}

export function artifactExecutionReceiptFacts(input: {
  readonly resultSchema: string;
  readonly reservedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  return parseDurableExecutionReceiptFacts({
    usage: {
      currency: 'USD', unit: 'microusd', callCount: 1,
      upperBoundMicrousd: microusd(input.reservedMicrousd),
    },
    costBasis: 'estimated_upper_bound',
  }, input.resultSchema);
}
