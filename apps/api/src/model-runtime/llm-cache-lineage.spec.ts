import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
} from '../discovery/company-discovery-lineage';

/**
 * 2026-11-08 二次 run 失败回归：LLM 缓存命中曾在 bridge 内短路返回、不产生 durable
 * 收据；lineage 收集器把「invoked 但无收据」判为未知结果 → 整条 lineage 作废 →
 * DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH。缓存命中经网关注入
 * settleCachedStructured 后产出 not_incurred（callCount=0）收据，必须与真实调用一样
 * 让 lineage 成立。
 */
const CACHE_HIT_RECEIPT = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: '11111111-1111-4111-8111-111111111111',
  authorityId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
  operationKey: 'model-cache-op',
  resultStrategy: 'typed_projection',
  resultSchema: 'discovery-extract-list/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD',
    unit: 'microusd',
    callCount: 0,
    chargedMicrousd: '0',
    upperBoundMicrousd: '0',
  },
  costBasis: 'not_incurred',
  status: 'SETTLED',
});

describe('discovery lineage over LLM cache hits', () => {
  it('stays valid when the directory extraction was settled from cache (zero-call receipt)', () => {
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
    });
    collector.markExpectedInvocation();
    collector.onDurableReceipt('discovery.extract_list', CACHE_HIT_RECEIPT);
    const observation = collector.finish([0]);

    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'directory',
      recordCount: 1,
      observations: [observation],
    });

    expect(lineage).toBeDefined();
    expect(lineage!.receiptCoverage).toHaveLength(1);
    expect(lineage!.receiptCoverage[0]!.receipt.operationId).toBe(
      CACHE_HIT_RECEIPT.operationId,
    );
    expect(lineage!.receiptCoverage[0]!.recordIndexes).toEqual([0]);
  });

  it('still voids the lineage for an invoked call with no receipt (the control we must never hit)', () => {
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
    });
    collector.markExpectedInvocation();
    const observation = collector.finish([0]);

    expect(
      buildDiscoveryCompanyResultLineage({
        providerKey: 'directory',
        recordCount: 1,
        observations: [observation],
      }),
    ).toBeUndefined();
  });
});
