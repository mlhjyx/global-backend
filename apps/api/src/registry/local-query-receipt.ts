/**
 * `registry.query` 的 local_query 血缘回执（A 方案落地，设计见
 * docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md）。
 *
 * 本地注册库枚举没有物理调用，但血缘治理要求逐记录 durable 回执。本模块为
 * `registry_frame` 构造**确定性**的 typed_projection 回执：
 *  - `operationKey = registry.query:<runId>:<queryDigest>`，`operationId` 由
 *    (runId, queryDigest) 派生为确定性 UUID——重试/回放得到同一身份；
 *  - `resultDigest` = 归一候选集（canonical JSON，键排序）的 sha256——审计方可用同一
 *    snapshot + filters 从 `registry_entity` 重算并比对；
 *  - 成本恒 0：usage 全部为 0、costBasis=`not_incurred`（receipt 语义校验要求）；
 *  - 只有本模块（producer `registry.query`）能构造这种回执；domain-ack 绑定与
 *    PROVIDER_RECEIPT_CONTRACT 的封闭白名单在别处登记。
 */
import { createHash } from 'node:crypto';
import type { ProviderCompanyRecord } from '../discovery/provider-contract';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from '../discovery/company-discovery-lineage';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

export const REGISTRY_QUERY_PRODUCER_ID = 'registry.query' as const;
export const REGISTRY_QUERY_RESULT_SCHEMA = 'registry-query/v1' as const;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 键排序的稳定 JSON：同内容不同键序得到同一字符串（digest 可复算的前提）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** 计划查询的规范摘要（filters/keywords/limit 任一变化 → 新 operation）。 */
export function registryQueryDigest(input: {
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

/** sha256 hex → 确定性 UUID（RFC 4122 v5 形态；同输入同 id，供血缘/回执身份使用）。 */
export function deterministicUuid(hex: string): string {
  const bytes = Buffer.from(hex, 'hex').subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export interface RegistryLocalQueryReceiptInput {
  workspaceId: string;
  authorityId: string;
  accountId: string;
  runId: string;
  queryDigest: string;
  records: readonly ProviderCompanyRecord[];
}

/**
 * 构造本地查询回执。字段全部确定性；`authorityId/accountId` 来自 run 的执行预算绑定
 * （执行器经 ExecutionContext.durableBudgetAuthority 注入）。
 */
export function buildRegistryLocalQueryReceipt(
  input: RegistryLocalQueryReceiptInput,
): DurableExecutionReceipt {
  const operationKey = `registry.query:${input.runId}:${input.queryDigest}`;
  if (operationKey.length > 200) {
    throw new Error('registry local query operationKey exceeds 200 chars');
  }
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1' as const,
    scopeKey: input.workspaceId,
    authorityId: input.authorityId,
    accountId: input.accountId,
    operationId: deterministicUuid(sha256Hex(`${input.runId}\u0000${input.queryDigest}`)),
    operationKey,
    resultStrategy: 'typed_projection' as const,
    resultSchema: REGISTRY_QUERY_RESULT_SCHEMA,
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

/** 回执 → 公司结果血缘（单回执覆盖全部记录索引；空结果给空覆盖，合法）。 */
export function buildRegistryQueryLineage(
  receipt: DurableExecutionReceipt,
  recordCount: number,
): DiscoveryCompanyResultLineageV1 {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new Error(`invalid registry lineage recordCount: ${recordCount}`);
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
              producerId: REGISTRY_QUERY_PRODUCER_ID,
              receipt,
              recordIndexes: Object.freeze(Array.from({ length: recordCount }, (_, index) => index)),
            }),
          ]),
  });
}
