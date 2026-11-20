import type { Prisma } from '@prisma/client';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { assertExecutionBudgetAuthorityId, assertExecutionBudgetScopeKey, isExecutionBudgetUuid } from '../execution-budget/execution-budget-authority.repository';
import { isTypedProjectionSchema, type TypedProjectionSchema } from '../durable-results/durable-result-strategy';
import { parseDurableExecutionReceipt, type DurableExecutionReceipt, type DurableExecutionReceiptFacts } from '../durable-results/durable-execution-receipt';
import { parseGenericOperationProjection, type GenericOperationProjection } from './generic-operation-projection';

export interface BudgetOperationResultQuery {
  readonly scopeKey: string;
  readonly authorityId: string;
  readonly accountKey: string;
  readonly accountGeneration: number;
  readonly operationKey: string;
  readonly resultSchema: TypedProjectionSchema;
}
export type BudgetOperationResultReadback =
  | { readonly status: 'NOT_FOUND' | 'RESERVED' | 'RELEASED' | 'RESULT_UNKNOWN' | 'SETTLED_NO_RESULT' }
  | { readonly status: 'SETTLED'; readonly projection: GenericOperationProjection; readonly receipt: DurableExecutionReceipt };

function projectionResultStrategy(
  schemaVersion: string | null | undefined,
): DurableExecutionReceipt['resultStrategy'] | null {
  if (schemaVersion === 'generic-operation-projection/v1') return 'typed_projection';
  if (schemaVersion === 'generic-operation-artifact-ref/v1') return 'artifact_reference';
  return null;
}

function artifactIdFromResultJson(resultJson: unknown): string | null {
  if (!resultJson || typeof resultJson !== 'object' || Array.isArray(resultJson)) return null;
  const artifactId = (resultJson as Record<string, unknown>).artifactId;
  return typeof artifactId === 'string' ? artifactId : null;
}

export function durableReceiptFromLedgerRow(input: {
  readonly scopeKey: string;
  readonly operationId: string;
  readonly operationKey?: string;
  readonly accountId?: string;
  readonly authorityId?: string | null;
  readonly resultSchemaVersion?: string | null;
  readonly resultSchema?: string | null;
  readonly resultDigest?: string | null;
  readonly resultJson?: unknown;
  readonly receiptUsage?: unknown;
  readonly receiptCostBasis?: string | null;
}): DurableExecutionReceipt | undefined {
  const resultStrategy = projectionResultStrategy(input.resultSchemaVersion);
  if (
    !input.accountId ||
    !input.authorityId ||
    !input.operationKey ||
    !input.resultSchema ||
    !input.resultDigest ||
    !resultStrategy ||
    !input.receiptUsage ||
    !input.receiptCostBasis
  ) {
    return undefined;
  }
  return parseDurableExecutionReceipt({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: input.scopeKey,
    authorityId: input.authorityId,
    accountId: input.accountId,
    operationId: input.operationId,
    operationKey: input.operationKey,
    resultStrategy,
    resultSchema: input.resultSchema,
    resultDigest: input.resultDigest,
    artifactId: resultStrategy === 'artifact_reference'
      ? artifactIdFromResultJson(input.resultJson)
      : null,
    usage: input.receiptUsage,
    costBasis: input.receiptCostBasis,
    status: 'SETTLED',
  });
}

export function ledgerReceiptMismatch(): never {
  throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return ledgerReceiptMismatch();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

export function requireLedgerProjectionReceipt(input: {
  readonly scopeKey: string;
  readonly expectedOperationId: string;
  readonly operationId?: string | null;
  readonly operationKey?: string;
  readonly accountId?: string;
  readonly authorityId?: string | null;
  readonly resultSchemaVersion?: string | null;
  readonly resultSchema?: string | null;
  readonly resultDigest?: string | null;
  readonly resultJson?: unknown;
  readonly receiptUsage?: unknown;
  readonly receiptCostBasis?: string | null;
  readonly expectedProjection: GenericOperationProjection;
  readonly expectedFacts?: DurableExecutionReceiptFacts;
}): DurableExecutionReceipt {
  try {
    if (
      !input.operationId ||
      input.operationId !== input.expectedOperationId ||
      input.resultSchemaVersion !== input.expectedProjection.schemaVersion ||
      input.resultSchema !== input.expectedProjection.schema ||
      input.resultDigest !== input.expectedProjection.digest
    ) {
      return ledgerReceiptMismatch();
    }
    const lockedProjection = parseGenericOperationProjection(input.resultJson);
    if (canonicalJson(lockedProjection) !== canonicalJson(input.expectedProjection)) {
      return ledgerReceiptMismatch();
    }
    const receipt = durableReceiptFromLedgerRow({
      scopeKey: input.scopeKey,
      operationId: input.operationId,
      operationKey: input.operationKey,
      accountId: input.accountId,
      authorityId: input.authorityId,
      resultSchemaVersion: input.resultSchemaVersion,
      resultSchema: input.resultSchema,
      resultDigest: input.resultDigest,
      resultJson: input.resultJson,
      receiptUsage: input.receiptUsage,
      receiptCostBasis: input.receiptCostBasis,
    });
    if (!receipt) return ledgerReceiptMismatch();
    if (
      input.expectedFacts &&
      (canonicalJson(receipt.usage) !== canonicalJson(input.expectedFacts.usage) ||
        receipt.costBasis !== input.expectedFacts.costBasis)
    ) {
      return ledgerReceiptMismatch();
    }
    return receipt;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH'
    ) {
      throw error;
    }
    return ledgerReceiptMismatch();
  }
}


interface ReadAccountRow {
  scope_key: string; account_key: string; account_id: string; authority_id: string; generation: number;
}
interface ReadOperationRow {
  scope_key: string; account_id: string; generation: number; operation_id: string; operation_key: string; status: string;
  result_schema_version: string | null; result_schema: string | null; result_digest: string | null;
  result_json: unknown; receipt_usage: unknown; receipt_cost_basis: string | null; settled_without_result: boolean;
}
function assertReadQuery(query: BudgetOperationResultQuery): void {
  assertExecutionBudgetScopeKey(query.scopeKey, { allowPlatform: false });
  assertExecutionBudgetAuthorityId(query.authorityId);
  if (!Number.isSafeInteger(query.accountGeneration) || query.accountGeneration < 1 || query.accountGeneration > 2_147_483_647 ||
      !isTypedProjectionSchema(query.resultSchema) ||
      [query.accountKey, query.operationKey].some(value => typeof value !== 'string' || value.length < 1 || value.length > 200 || [...value].some(c => c.charCodeAt(0) < 32))) {
    ledgerReceiptMismatch();
  }
}
function settledReadback(row: ReadOperationRow, account: ReadAccountRow, query: BudgetOperationResultQuery): BudgetOperationResultReadback {
  try {
    if (row.result_schema !== query.resultSchema || row.result_schema_version !== 'generic-operation-projection/v1') ledgerReceiptMismatch();
    const projection = parseGenericOperationProjection(row.result_json);
    const receipt = requireLedgerProjectionReceipt({
      scopeKey: query.scopeKey, expectedOperationId: row.operation_id, operationId: row.operation_id,
      operationKey: row.operation_key, accountId: row.account_id, authorityId: account.authority_id,
      resultSchemaVersion: row.result_schema_version, resultSchema: row.result_schema, resultDigest: row.result_digest,
      resultJson: row.result_json, receiptUsage: row.receipt_usage, receiptCostBasis: row.receipt_cost_basis,
      expectedProjection: projection,
    });
    return { status: 'SETTLED', projection, receipt };
  } catch (error) {
    if (error instanceof ExecutionControlError && error.code === 'DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH') throw error;
    return ledgerReceiptMismatch();
  }
}
/** No expiry/holder attestation: an admitted, closed or naturally expired account can still retain its original result. */
export async function readBudgetOperationResult(tx: Prisma.TransactionClient, query: BudgetOperationResultQuery): Promise<BudgetOperationResultReadback> {
  assertReadQuery(query);
  const accounts = await tx.$queryRaw<ReadAccountRow[]>`
    SELECT scope_key, account_key, id::text AS account_id, authority_id::text AS authority_id, generation
    FROM public.tool_budget_account WHERE scope_key=${query.scopeKey} AND account_key=${query.accountKey}`;
  if (accounts.length === 0) return { status: 'NOT_FOUND' };
  const account = accounts[0];
  if (accounts.length !== 1 || !account || !isExecutionBudgetUuid(account.account_id) || account.scope_key !== query.scopeKey ||
      account.account_key !== query.accountKey || account.authority_id !== query.authorityId || account.generation !== query.accountGeneration) ledgerReceiptMismatch();
  const operations = await tx.$queryRaw<ReadOperationRow[]>`
    SELECT scope_key, account_id::text AS account_id, generation, id::text AS operation_id, operation_key, status::text AS status,
      result_schema_version, result_schema, result_digest, result_json, receipt_usage, receipt_cost_basis,
      (result_schema_version IS NULL AND result_schema IS NULL AND result_digest IS NULL
        AND result_json IS NULL AND receipt_usage IS NULL AND receipt_cost_basis IS NULL) AS settled_without_result
    FROM public.tool_budget_operation WHERE scope_key=${query.scopeKey} AND account_id=${account.account_id}::uuid
      AND generation=${query.accountGeneration} AND operation_key=${query.operationKey}`;
  if (operations.length === 0) return { status: 'NOT_FOUND' };
  const operation = operations[0];
  if (operations.length !== 1 || !operation || !isExecutionBudgetUuid(operation.operation_id) || operation.scope_key !== query.scopeKey ||
      operation.account_id !== account.account_id || operation.generation !== query.accountGeneration || operation.operation_key !== query.operationKey) ledgerReceiptMismatch();
  if (operation.status === 'RESERVED' || operation.status === 'RELEASED' || operation.status === 'RESULT_UNKNOWN') return { status: operation.status };
  if (operation.status !== 'SETTLED') ledgerReceiptMismatch();
  if (operation.settled_without_result === true) {
    if ([operation.result_schema_version, operation.result_schema, operation.result_digest,
      operation.result_json, operation.receipt_usage, operation.receipt_cost_basis].some(value => value !== null)) ledgerReceiptMismatch();
    return { status: 'SETTLED_NO_RESULT' };
  }
  return settledReadback(operation, account, query);
}
