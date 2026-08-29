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

function artifactReceipt(
  operationId: string,
  resultSchema: string,
): DurableExecutionReceipt {
  return Object.freeze({
    ...receipt(operationId, resultSchema),
    resultStrategy: 'artifact_reference',
    artifactId: 'e9335aa2-c9ab-4db4-92bd-bd7c734b89e8',
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
      recordCount: 1,
      observations: [
        (() => {
          const complete = createDiscoveryCompanyReceiptCollector({
            providerKey: 'directory',
            producerId: 'discovery.extract_list',
          });
          complete.markExpectedInvocation();
          complete.onDurableReceipt(
            'discovery.extract_list',
            receipt(OPERATION_A, 'discovery-extract-list/v1'),
          );
          return complete.finish([0]);
        })(),
        missing.finish([]),
      ],
    })).toBeUndefined();
  });

  it('rejects accessor observations without invoking their getters', () => {
    let getterCalls = 0;
    const observation = Object.defineProperty({
      producerId: 'discovery.extract_company',
      receipt: null,
      recordIndexes: [],
    }, 'invoked', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return false;
      },
    });
    expect(() => buildDiscoveryCompanyResultLineage({
      providerKey: 'public_web',
      recordCount: 0,
      observations: [observation as never],
    })).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(getterCalls).toBe(0);
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
    const unmarked = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    expect(() => unmarked.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_A),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const mismatched = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    mismatched.markExpectedInvocation();
    expect(() => mismatched.onDurableReceipt(
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

  it('fails closed across malformed object, array, numeric and schema boundaries', () => {
    const empty = {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    };
    class LineagePayload {}
    expect(() => parseDiscoveryCompanyResultLineage(
      Object.assign(new LineagePayload(), empty),
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage(empty, 'unknown'))
      .toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...empty, schemaVersion: 'wrong/v1' },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...empty, recordCount: -1 },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...empty, attemptReceipts: new Proxy([], {}) },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const sparse = new Array(1);
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...empty, attemptReceipts: sparse },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    const accessorArray = [null];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => null,
    });
    expect(() => parseDiscoveryCompanyResultLineage(
      { ...empty, attemptReceipts: accessorArray },
      'public_web',
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    expect(() => parseDiscoveryCompanyResultLineage({
      ...empty,
      receiptCoverage: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A),
        recordIndexes: [],
      }],
    }, 'public_web')).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage({
      ...empty,
      recordCount: 1,
      receiptCoverage: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A),
        recordIndexes: [1],
      }],
    }, 'public_web')).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => parseDiscoveryCompanyResultLineage({
      ...empty,
      attemptReceipts: [{
        producerId: 'discovery.extract_company',
        receipt: { ...receipt(OPERATION_A), resultDigest: 'INVALID' },
      }],
    }, 'public_web')).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });

  it('rejects malformed collector configuration and invalid state transitions', () => {
    expect(() => createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
      parentOnDurableReceipt: 1 as never,
    })).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const markedTwice = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    markedTwice.markExpectedInvocation();
    expect(() => markedTwice.markExpectedInvocation())
      .toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => markedTwice.finish([])).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const invalidReceipt = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    invalidReceipt.markExpectedInvocation();
    expect(() => invalidReceipt.onDurableReceipt(
      'discovery.extract_company',
      { ...receipt(OPERATION_A), resultDigest: 'INVALID' },
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    const idle = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
    });
    expect(() => idle.finish([0])).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });

  it('terminalizes collectors after finish and never forwards a later callback', () => {
    const parent = vi.fn();
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
      parentOnDurableReceipt: parent,
    });
    collector.markExpectedInvocation();
    collector.onDurableReceipt('discovery.extract_company', receipt(OPERATION_A));
    expect(collector.finish([0]).recordIndexes).toEqual([0]);
    expect(() => collector.finish([0])).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => collector.onDurableReceipt(
      'discovery.extract_company',
      receipt(OPERATION_B),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(parent).toHaveBeenCalledOnce();
  });

  it('forwards a parent callback at most once when it throws and omits the entire lineage', () => {
    const parent = vi.fn(() => {
      throw new Error('parent unavailable');
    });
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
      parentOnDurableReceipt: parent,
    });
    collector.markExpectedInvocation();
    expect(() => collector.onDurableReceipt(
      'discovery.extract_list',
      receipt(OPERATION_A, 'discovery-extract-list/v1'),
    )).not.toThrow();
    expect(() => collector.onDurableReceipt(
      'discovery.extract_list',
      receipt(OPERATION_B, 'discovery-extract-list/v1'),
    )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(parent).toHaveBeenCalledOnce();
    const observation = collector.finish([0]);
    expect(observation).toMatchObject({ invoked: true, receipt: null, recordIndexes: [0] });
    expect(buildDiscoveryCompanyResultLineage({
      providerKey: 'directory',
      recordCount: 1,
      observations: [observation],
    })).toBeUndefined();
  });

  it.each([
    ['trade_fair', 'tradefair.algolia', 'tradefair-algolia/v1'],
    ['public_web', 'discovery.extract_company', 'discovery-extract-company/v1'],
    ['directory', 'discovery.extract_list', 'discovery-extract-list/v1'],
  ] as const)(
    'binds %s <- %s to its exact typed projection schema',
    (providerKey, producerId, resultSchema) => {
      const wrongSchema = createDiscoveryCompanyReceiptCollector({
        providerKey,
        producerId,
      });
      wrongSchema.markExpectedInvocation();
      expect(() => wrongSchema.onDurableReceipt(
        producerId,
        receipt(OPERATION_A, 'wrong-company-result/v1'),
      )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

      const wrongStrategy = createDiscoveryCompanyReceiptCollector({
        providerKey,
        producerId,
      });
      wrongStrategy.markExpectedInvocation();
      expect(() => wrongStrategy.onDurableReceipt(
        producerId,
        artifactReceipt(OPERATION_B, resultSchema),
      )).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    },
  );

  it('rejects wrong schema or artifact-reference receipts in parsed attempts and coverage', () => {
    expect(() => parseDiscoveryCompanyResultLineage({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [{
        producerId: 'discovery.extract_company',
        receipt: receipt(OPERATION_A, 'wrong-company-result/v1'),
      }],
      receiptCoverage: [],
    }, 'public_web')).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);

    expect(() => parseDiscoveryCompanyResultLineage({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 1,
      attemptReceipts: [],
      receiptCoverage: [{
        producerId: 'discovery.extract_company',
        receipt: artifactReceipt(OPERATION_A, 'discovery-extract-company/v1'),
        recordIndexes: [0],
      }],
    }, 'public_web')).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });

  it('rejects malformed observation semantics without exposing partial output', () => {
    expect(() => buildDiscoveryCompanyResultLineage({
      providerKey: 'public_web',
      recordCount: 0,
      observations: [{
        producerId: 'discovery.extract_company',
        invoked: 'yes',
        receipt: null,
        recordIndexes: [],
      } as never],
    })).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
    expect(() => buildDiscoveryCompanyResultLineage({
      providerKey: 'public_web',
      recordCount: 0,
      observations: [{
        producerId: 'discovery.extract_company',
        invoked: false,
        receipt: receipt(OPERATION_A),
        recordIndexes: [],
      }],
    })).toThrow(DISCOVERY_COMPANY_LINEAGE_INVALID);
  });
});
