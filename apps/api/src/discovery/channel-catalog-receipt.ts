/**
 * `channel_catalog.query` 的 local_query 血缘回执（Batch 1.4-B）：
 *
 * 与 `registry/local-query-receipt.ts` 完全同构：本地查询平台表 `source_channel_record`
 * （仅已审核 APPROVED 且渠道 ENABLED 的记录）零出网、零成本，但血缘治理要求逐记录
 * durable 回执。本模块构造确定性的 typed_projection 回执，供 `ChannelCatalogDiscoveryProvider`
 * 经 `ctx.onDurableReceipt` 上报。
 */
import { createHash } from 'node:crypto';
import type { ProviderCompanyRecord } from './provider-contract';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from './company-discovery-lineage';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

export const CHANNEL_CATALOG_QUERY_PRODUCER_ID = 'channel_catalog.query' as const;
export const CHANNEL_CATALOG_QUERY_RESULT_SCHEMA = 'channel-catalog-query/v1' as const;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function deterministicUuid(hex: string): string {
  const bytes = Buffer.from(hex, 'hex').subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export function channelCatalogQueryDigest(input: {
  filters: unknown;
  keywords: readonly string[];
  limit: number;
}): string {
  return sha256Hex(
    canonicalJson({
      filters: input.filters ?? {},
      keywords: [...input.keywords],
      limit: input.limit,
    }),
  );
}

export function buildChannelCatalogLocalQueryReceipt(input: {
  workspaceId: string;
  authorityId: string;
  accountId: string;
  runId: string;
  queryDigest: string;
  records: readonly ProviderCompanyRecord[];
}): DurableExecutionReceipt {
  const operationKey = `channel_catalog.query:${input.runId}:${input.queryDigest}`;
  if (operationKey.length > 200) {
    throw new Error('channel_catalog local query operationKey exceeds 200 chars');
  }
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1' as const,
    scopeKey: input.workspaceId,
    authorityId: input.authorityId,
    accountId: input.accountId,
    operationId: deterministicUuid(sha256Hex(`channel_catalog\u0000${input.runId}\u0000${input.queryDigest}`)),
    operationKey,
    resultStrategy: 'typed_projection' as const,
    resultSchema: CHANNEL_CATALOG_QUERY_RESULT_SCHEMA,
    resultDigest: sha256Hex(canonicalJson(input.records)),
    artifactId: null,
    usage: Object.freeze({
      currency: 'USD' as const,
      unit: 'microusd' as const,
      callCount: 0,
      chargedMicrousd: '0',
    }),
    costBasis: 'not_incurred' as const,
    status: 'SETTLED' as const,
  });
}

export function buildChannelCatalogQueryLineage(
  receipt: DurableExecutionReceipt,
  recordCount: number,
): DiscoveryCompanyResultLineageV1 {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new Error(`invalid channel_catalog lineage recordCount: ${recordCount}`);
  }
  return Object.freeze({
    schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    recordCount,
    attemptReceipts: Object.freeze([]),
    receiptCoverage:
      recordCount === 0
        ? Object.freeze([])
        : Object.freeze([
            Object.freeze({
              producerId: CHANNEL_CATALOG_QUERY_PRODUCER_ID,
              receipt,
              recordIndexes: Object.freeze(Array.from({ length: recordCount }, (_, index) => index)),
            }),
          ]),
  });
}
