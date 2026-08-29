import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import {
  DISCOVERY_COMPANY_LINEAGE_INVALID,
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  parseDiscoveryCompanyResultLineage,
} from './company-discovery-lineage';

const AUTHORITY_ID = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const ACCOUNT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';

function receipt(
  operationId: string,
  resultSchema = 'discovery-extract-company/v1',
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
    resultDigest: operationId.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
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

const OPERATION_A = 'f9c22f2a-3578-4ed2-ac8b-0819e9147c40';
const OPERATION_B = '2e09726e-16de-42c5-875c-92d02cf58df0';

describe('company discovery receipt lineage', () => {
  it('builds and parses one deeply frozen exact-coverage lineage', () => {
    const first = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    const second = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    first.markExpectedInvocation();
    first.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_A),
    );
    second.markExpectedInvocation();
    second.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_B),
    );

    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'public_web',
      recordCount: 2,
      observations: [first.finish([0, 1]), second.finish([])],
    });

    expect(lineage).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 2,
      attemptReceipts: [
        { producerId: 'discovery.extract_company', receipt: receipt(OPERATION_B) },
      ],
      receiptCoverage: [
        {
          producerId: 'discovery.extract_company',
          receipt: receipt(OPERATION_A),
          recordIndexes: [0, 1],
        },
      ],
    });
    const parsed = parseDiscoveryCompanyResultLineage(lineage, 'public_web');
    expect(parsed).not.toBe(lineage);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.attemptReceipts)).toBe(true);
    expect(Object.isFrozen(parsed.receiptCoverage)).toBe(true);
    expect(Object.isFrozen(parsed.receiptCoverage[0])).toBe(true);
    expect(Object.isFrozen(parsed.receiptCoverage[0]!.recordIndexes)).toBe(true);
    expect(Object.isFrozen(parsed.receiptCoverage[0]!.receipt.usage)).toBe(true);
  });

  it('forwards the exact receipt once and classifies settled zero output as an attempt', () => {
    const parent = vi.fn();
    const settled = receipt(OPERATION_A, 'tradefair-algolia/v1');
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'trade_fair',
      producerId: 'tradefair.algolia',
      parentOnDurableReceipt: parent,
    });
    collector.markExpectedInvocation();
    collector.onDurableReceipt('tradefair.algolia', settled);

    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'trade_fair',
      recordCount: 0,
      observations: [collector.finish([])],
    });

    expect(parent).toHaveBeenCalledOnce();
    expect(parent).toHaveBeenCalledWith('tradefair.algolia', settled);
    expect(lineage?.attemptReceipts).toHaveLength(1);
    expect(lineage?.receiptCoverage).toEqual([]);
  });

  it('returns an empty lineage for non-invoked early exits but omits all lineage after an invoked call has no receipt', () => {
    const notInvoked = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
    });
    expect(buildDiscoveryCompanyResultLineage({
      providerKey: 'directory',
      recordCount: 0,
      observations: [notInvoked.finish([])],
    })).toEqual({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    });

    const missing = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
    });
    missing.markExpectedInvocation();
    expect(buildDiscoveryCompanyResultLineage({
      providerKey: 'directory',
      recordCount: 0,
      observations: [missing.finish([])],
    })).toBeUndefined();
  });

  it.each([
    ['trade_fair', 'discovery.extract_company'],
    ['public_web', 'tradefair.algolia'],
    ['directory', 'discovery.extract_company'],
  ] as const)('rejects unsupported provider/producer pair %s <- %s', (providerKey, producerId) => {
    expect(() => createDiscoveryCompanyReceiptCollector({
      providerKey,
      producerId,
    })).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });

  it('rejects duplicate or mismatched callbacks before exposing partial lineage', () => {
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    expect(() => collector.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_A),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    collector.markExpectedInvocation();
    expect(() => collector.onDurableReceipt(
      'tradefair.algolia',
      receipt(OPERATION_A),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const duplicate = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    duplicate.markExpectedInvocation();
    duplicate.onDurableReceipt('discovery.extract_company', receipt(OPERATION_A));
    expect(() => duplicate.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_B),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });

  it.each([
    {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [],
      receiptCoverage: [],
    },
    {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [],
      receiptCoverage: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A),
        recordIndexes: [0, 0],
      }],
    },
    {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A),
      }],
      receiptCoverage: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A),
        recordIndexes: [0],
      }],
    },
    {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
      extra: true,
    },
  ])('rejects incomplete, duplicate-operation, duplicate-index or open payloads', (value) => {
    expect(() => parseDiscoveryCompanyResultLineage(value, 'public_web')).toThrow(
      DISCOVERY_COMPANY_LINEAGE_INVALID,
    );
  });

  it('rejects Proxy, symbol and accessor payloads without invoking getters', () => {
    const valid = {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    };
    expect(() => parseDiscoveryCompanyResultLineage(new Proxy(valid, {}), 'public_web'))
      .toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...valid, [Symbol('hidden')]: true },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    let getterCalls = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, 'recordCount', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 0;
      },
    });
    expect(() => parseDiscoveryCompanyResultLineage(accessor, 'public_web'))
      .toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(getterCalls).toBe(0);
  });
});
