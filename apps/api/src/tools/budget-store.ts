import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EXECUTION_BUDGET_PLATFORM_PURPOSES,
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
} from '../execution-budget/execution-budget-authority.types';
import {
  attestExecutionBudgetPlatformWriterTransaction,
  assertExecutionBudgetAuthorityId,
  assertExecutionBudgetScopeKey,
  isExecutionBudgetUuid,
  isTrustedExecutionBudgetDatabaseMarker,
  mapExecutionBudgetPersistenceError,
} from '../execution-budget/execution-budget-authority.repository';
import {
  parseGenericOperationProjection,
  type GenericOperationProjection,
} from './generic-operation-projection';
import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactUuid,
  type GenericOperationArtifactReference,
} from '../durable-results/artifact/artifact.types';
import { parseArtifactReference } from '../durable-results/artifact/artifact-reference.schema';
import { parseGenericOperationArtifactSnapshot } from '../durable-results/artifact/generic-operation-artifact.repository';
import {
  expectedFactsFromUnknownRow,
  parseBoundArtifactBudgetSnapshot,
  type GenericOperationArtifactSnapshot,
  type UnknownArtifactRow,
} from './artifact-budget-expected-facts';
import {
  parseGenericOperationArtifactSubjectRef,
  type GenericOperationArtifactSubjectRef,
} from '../durable-results/artifact/generic-operation-artifact-subject.repository';
import { assertMicrousd } from './microusd';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
  parseDurableExecutionReceiptFacts,
  type DurableExecutionReceiptFacts,
} from '../durable-results/durable-execution-receipt';
import { applyDomainAckConsumerTransaction } from '../durable-results/domain-ack-consumer-bindings';
import {
  ExecutionControlError,
  isExecutionControlError,
} from '../execution-budget/execution-control-error';
const MAX_KEY_LENGTH = 200;

function bindExpectedArtifactSubject(
  snapshot: GenericOperationArtifactSnapshot | null,
  value: GenericOperationArtifactSubjectRef | undefined,
): GenericOperationArtifactSubjectRef | null {
  if (!snapshot) {
    return value === undefined ? null : invalidGenericOperationArtifact();
  }
  const personal = snapshot.manifest.privacyClass === 'PERSONAL_DATA';
  if (!personal) {
    return value === undefined ? null : invalidGenericOperationArtifact();
  }
  if (snapshot.manifest.scopeKind !== 'workspace' || value === undefined) {
    return invalidGenericOperationArtifact();
  }
  try {
    return parseGenericOperationArtifactSubjectRef(value);
  } catch {
    return invalidGenericOperationArtifact();
  }
}

function parseOptionalArtifactSubject(
  value: GenericOperationArtifactSubjectRef | undefined,
): GenericOperationArtifactSubjectRef | null {
  if (value === undefined) return null;
  try {
    return parseGenericOperationArtifactSubjectRef(value);
  } catch {
    return invalidGenericOperationArtifact();
  }
}

export const TOOL_BUDGET_STORE = Symbol('TOOL_BUDGET_STORE');
export type BudgetReplayResult =
  | Readonly<{
      resultStrategy: 'typed_projection';
      projection: GenericOperationProjection;
    }>
  | Readonly<{
      resultStrategy: 'artifact_reference';
      reference: GenericOperationArtifactReference;
    }>;

export interface BudgetDomainAckRequest {
  readonly producerId: string;
  readonly domainAckKey: string;
  readonly domainRevision: string;
}

export interface BudgetResultUnknownTransition {
  reservedMicrousd: bigint;
  replay: boolean;
}

export interface BudgetReservationRequest {
  workspaceId: string;
  accountKey: string;
  operationKey: string;
  estimatedMicrousd: bigint;
}

export interface BudgetReservation {
  workspaceId: string;
  accountKey: string;
  operationId: string;
  estimatedMicrousd: bigint;
  replay: boolean;
  replayResult?: BudgetReplayResult;
  receipt?: DurableExecutionReceipt;
}

export interface BudgetSettlement {
  chargedMicrousd: bigint;
  observedMicrousd: bigint;
  capVariance: boolean;
  replay: boolean;
  receipt?: DurableExecutionReceipt;
  domainAckStatus?: 'APPLIED' | 'REPLAYED';
}

export interface BudgetStatus {
  remainingMicrousd: bigint;
  exhausted: boolean;
  open: boolean;
}

export interface BudgetAccountAuthorization {
  readonly accountId: string;
  readonly authorityId: string;
  readonly authorizedCapMicrousd: bigint;
  readonly generation: number;
}

export interface PlatformBudgetRunAdmissionInput {
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: 'schedule';
  readonly subjectId: string;
  readonly scheduleId: string;
  readonly requestSha256: string;
  readonly workflowRunId: string;
  readonly accountKey: string;
}

export interface PlatformBudgetRunAdmission extends BudgetAccountAuthorization {
  readonly replay: boolean;
}

/** Authoritative budget surface. Product composition must use a shared durable implementation. */
export interface BudgetStore {
  open(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
    replayScope?: boolean;
  }): Promise<BudgetAccountAuthorization>;
  /** Atomically selects a fresh exact schedule authority and opens one run. */
  admitPlatformRun(
    input: PlatformBudgetRunAdmissionInput,
  ): Promise<PlatformBudgetRunAdmission>;
  /** Read-only verification of an account opened by HTTP/schedule admission. */
  attestAuthorized(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
  }): Promise<BudgetAccountAuthorization>;
  reserve(input: BudgetReservationRequest): Promise<BudgetReservation>;
  settle(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement>;
  /** Physical execution started, but the result/object acknowledgement is unknown. */
  markResultUnknown(
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<BudgetResultUnknownTransition>;
  /** Loads only facts atomically bound when the original physical result became unknown. */
  loadResultUnknownArtifact(
    reservation: BudgetReservation,
    authorityId: string,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<GenericOperationArtifactSnapshot | null>;
  /** Atomically appends the manifest and settles its exact closed reference. */
  settleArtifactManifest(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    snapshot: GenericOperationArtifactSnapshot,
    receiptFacts: DurableExecutionReceiptFacts,
    domainAck: BudgetDomainAckRequest,
    subjectRef?: GenericOperationArtifactSubjectRef,
    /** Internal exact object version; never enters manifest/reference/receipt. */
    objectVersionId?: string,
  ): Promise<BudgetSettlement>;
  release(reservation: BudgetReservation): Promise<BudgetSettlement>;
  status(input: { workspaceId: string; accountKey: string }): Promise<BudgetStatus>;
  /**
   * Drops one holder, or all holder references when force=true. A durable store
   * must retain operations and forbid a new generation while any are unresolved.
   */
  close(input: { workspaceId: string; accountKey: string; force?: boolean }): Promise<void>;
}

export class BudgetStoreUnavailableError extends Error {
  readonly code = 'BUDGET_STORE_UNAVAILABLE';

  constructor(reason = 'authoritative budget store unavailable') {
    super(reason);
    this.name = 'BudgetStoreUnavailableError';
  }
}
export class BudgetAccountUnavailableError extends Error {
  readonly code = 'BUDGET_ACCOUNT_UNAVAILABLE';

  constructor(public readonly accountKey: string) {
    super(`budget account unavailable: ${accountKey}`);
    this.name = 'BudgetAccountUnavailableError';
  }
}
/** A previous physical operation is still unresolved; reopening would permit an unsafe retry. */
export class BudgetUnsettledOperationsError extends Error {
  readonly code = 'BUDGET_UNSETTLED_OPERATIONS';

  constructor(public readonly accountKey: string) {
    super(`budget account has unresolved operations: ${accountKey}`);
    this.name = 'BudgetUnsettledOperationsError';
  }
}
export class BudgetOperationReplayError extends Error {
  readonly code = 'BUDGET_OPERATION_REPLAY_UNAVAILABLE';

  constructor(public readonly operationKey: string) {
    super(`budget operation already exists without a durable result: ${operationKey}`);
    this.name = 'BudgetOperationReplayError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    public readonly accountKey: string,
    public readonly neededMicrousd: bigint,
    public readonly remainingMicrousd: bigint,
  ) {
    super(
      `budget exceeded for account ${accountKey}: need ${neededMicrousd} microusd, remaining ${remainingMicrousd} microusd`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class UnavailableBudgetStore implements BudgetStore {
  constructor(private readonly reason = 'authoritative budget store unavailable') {}

  private unavailable(): never {
    throw new BudgetStoreUnavailableError(this.reason);
  }

  async open(): Promise<BudgetAccountAuthorization> {
    return this.unavailable();
  }

  async admitPlatformRun(): Promise<PlatformBudgetRunAdmission> {
    return this.unavailable();
  }

  async attestAuthorized(): Promise<BudgetAccountAuthorization> {
    return this.unavailable();
  }

  async reserve(): Promise<BudgetReservation> {
    return this.unavailable();
  }

  async settle(): Promise<BudgetSettlement> {
    return this.unavailable();
  }

  async markResultUnknown(): Promise<BudgetResultUnknownTransition> {
    return this.unavailable();
  }

  async loadResultUnknownArtifact(): Promise<GenericOperationArtifactSnapshot | null> {
    return this.unavailable();
  }

  async settleArtifactManifest(): Promise<BudgetSettlement> {
    return this.unavailable();
  }

  async release(): Promise<BudgetSettlement> {
    return this.unavailable();
  }

  async status(): Promise<BudgetStatus> {
    return this.unavailable();
  }

  async close(): Promise<void> {
    this.unavailable();
  }

}

type MicrousdReserveRow = {
  kind: 'EXECUTE' | 'REPLAY' | 'DENIED' | 'ACCOUNT_UNAVAILABLE';
  operation_id: string | null;
  reserved_microusd: bigint;
  remaining_microusd: bigint;
  status?: string;
  result_json?: unknown;
  operation_key?: string;
  account_id?: string;
  authority_id?: string | null;
  charged_microusd?: bigint | null;
  observed_microusd?: bigint | null;
  result_schema_version?: string | null;
  result_schema?: string | null;
  result_digest?: string | null;
  receipt_usage?: unknown;
  receipt_cost_basis?: string | null;
};

type MicrousdSettleRow = {
  charged_microusd: bigint;
  observed_microusd: bigint;
  cap_variance: boolean;
  status: string;
  replay?: boolean;
  reserved_microusd?: bigint;
  operation_id?: string;
  operation_key?: string;
  account_id?: string;
  authority_id?: string | null;
  result_schema_version?: string | null;
  result_schema?: string | null;
  result_digest?: string | null;
  result_json?: unknown;
  receipt_usage?: unknown;
  receipt_cost_basis?: string | null;
};

type ResultUnknownRow = {
  reserved_microusd: bigint;
  status: string;
  replay: boolean;
  recoverable: boolean;
};
type AuthorizedOpenRow = {
  account_id: string;
  generation: number;
  authority_id: string;
  authorized_cap_microusd: bigint;
};

type PlatformAdmissionRow = AuthorizedOpenRow & {
  campaign_cap_microusd: bigint;
  max_runs: bigint;
  replay: boolean;
};

function parseBudgetAccountAuthorization(
  rows: readonly AuthorizedOpenRow[],
  authorityId: string,
): BudgetAccountAuthorization {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !isExecutionBudgetUuid(row.account_id) ||
    !isExecutionBudgetUuid(row.authority_id) ||
    row.authority_id !== authorityId ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    typeof row.authorized_cap_microusd !== 'bigint' ||
    row.authorized_cap_microusd < 1n
  ) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );
  }
  return {
    accountId: row.account_id,
    authorityId: row.authority_id,
    authorizedCapMicrousd: row.authorized_cap_microusd,
    generation: row.generation,
  };
}

function parsePlatformBudgetRunAdmission(
  rows: readonly PlatformAdmissionRow[],
): PlatformBudgetRunAdmission {
  const row = rows[0];
  if (
    !row ||
    typeof row.replay !== 'boolean' ||
    typeof row.campaign_cap_microusd !== 'bigint' ||
    row.campaign_cap_microusd < 1n ||
    typeof row.max_runs !== 'bigint' ||
    row.max_runs < 1n
  ) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );
  }
  return {
    ...parseBudgetAccountAuthorization(rows, row.authority_id),
    replay: row.replay,
  };
}

function assertKey(name: string, value: string): void {
  if (!value || value.length > MAX_KEY_LENGTH || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new TypeError(`${name} must be 1-${MAX_KEY_LENGTH} printable characters`);
  }
}

function assertPlatformBudgetRunAdmission(
  input: PlatformBudgetRunAdmissionInput,
): void {
  if (
    !EXECUTION_BUDGET_PLATFORM_PURPOSES.includes(
      input.purpose as (typeof EXECUTION_BUDGET_PLATFORM_PURPOSES)[number],
    ) ||
    input.subjectType !== 'schedule' ||
    input.subjectId !== input.scheduleId ||
    !/^[0-9a-f]{64}$/.test(input.requestSha256) ||
    !input.workflowRunId ||
    input.workflowRunId.length > 100 ||
    [...input.workflowRunId].some((character) => character.charCodeAt(0) < 32) ||
    input.accountKey !==
      `platform:${input.requestSha256}:${input.workflowRunId}`
  ) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    );
  }
  assertKey('subjectId', input.subjectId);
  assertKey('scheduleId', input.scheduleId);
  assertKey('accountKey', input.accountKey);
}

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

function durableReceiptFromLedgerRow(input: {
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

function ledgerReceiptMismatch(): never {
  throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
}

function canonicalJson(value: unknown): string {
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

function requireLedgerProjectionReceipt(input: {
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

function requireLedgerArtifactReceipt(input: {
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
  readonly expectedReference: GenericOperationArtifactReference;
  readonly expectedFacts?: DurableExecutionReceiptFacts;
}): DurableExecutionReceipt {
  try {
    if (
      !input.operationId ||
      input.operationId !== input.expectedOperationId ||
      input.resultSchemaVersion !== input.expectedReference.schemaVersion ||
      input.resultSchema !== input.expectedReference.resultSchema ||
      input.resultDigest !== input.expectedReference.sha256
    ) {
      return ledgerReceiptMismatch();
    }
    const lockedReference = parseArtifactReference(input.resultJson);
    if (canonicalJson(lockedReference) !== canonicalJson(input.expectedReference)) {
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
    if (
      !receipt ||
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

function replayResultFromLedgerRow(row: {
  readonly result_schema_version?: string | null;
  readonly result_json?: unknown;
}): BudgetReplayResult | undefined {
  if (row.result_json == null) return undefined;
  if (row.result_schema_version === 'generic-operation-projection/v1') {
    return Object.freeze({
      resultStrategy: 'typed_projection' as const,
      projection: parseGenericOperationProjection(row.result_json),
    });
  }
  if (row.result_schema_version === 'generic-operation-artifact-ref/v1') {
    return Object.freeze({
      resultStrategy: 'artifact_reference' as const,
      reference: parseArtifactReference(row.result_json),
    });
  }
  return ledgerReceiptMismatch();
}

function receiptFactsForSettlement(
  projection: GenericOperationProjection | null,
  receiptFacts: DurableExecutionReceiptFacts | undefined,
): DurableExecutionReceiptFacts | null {
  if (!projection) {
    if (receiptFacts) throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
    return null;
  }
  if (!receiptFacts) {
    throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED');
  }
  return parseDurableExecutionReceiptFacts(receiptFacts, projection.schema);
}

function isBudgetAccountUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('TOOL_BUDGET_ACCOUNT_UNAVAILABLE');
}

function isAuthorityLifecycleUnavailable(error: unknown): boolean {
  return isTrustedExecutionBudgetDatabaseMarker(
    error,
    'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
  );
}

function isTrustedArtifactDatabaseInvalid(error: unknown): boolean {
  const markers = new Set([
    'ERROR: GENERIC_OPERATION_ARTIFACT_INVALID',
    'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
    'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
  ]);
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    const errorDescriptors = Object.getOwnPropertyDescriptors(error);
    const code = errorDescriptors.code;
    const meta = errorDescriptors.meta;
    if (
      !code || !('value' in code) || code.value !== 'P2010' ||
      !meta || !('value' in meta) ||
      !meta.value || typeof meta.value !== 'object'
    ) {
      return false;
    }
    const metaDescriptors = Object.getOwnPropertyDescriptors(meta.value);
    const sqlState = metaDescriptors.code;
    const message = metaDescriptors.message;
    return Boolean(
      sqlState && 'value' in sqlState && sqlState.value === 'P0001' &&
      message && 'value' in message &&
      typeof message.value === 'string' && markers.has(message.value),
    );
  } catch {
    return false;
  }
}

function isPrismaKnownRequestError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  try {
    return error instanceof Prisma.PrismaClientKnownRequestError;
  } catch {
    return false;
  }
}

function authorityLifecycleUnavailable(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError(
    'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
  );
}

/**
 * PostgreSQL implementation backed by narrow, row-locking functions installed by the DB migration.
 * Workspace calls enter PrismaService.withWorkspace, so FORCE RLS and each function's workspace
 * assertion agree on the same tenant. Platform authority calls require a separately injected,
 * deployment-owned writer connection. Static Prisma.sql templates keep all values parameterized.
 */
export class PostgresBudgetStore implements BudgetStore {
  constructor(
    private readonly prisma: PrismaService,
    /** Connection authenticated as the deployment-owned platform authority writer principal. */
    private readonly authorityPlatformWriter?: PrismaClient,
  ) {}

  private async inAuthorityScope<T>(
    scopeKey: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (scopeKey === 'platform') {
      if (!this.authorityPlatformWriter) {
        throw new ExecutionBudgetGrantError(
          'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
        );
      }
      return this.authorityPlatformWriter.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(
            'SET LOCAL statement_timeout = 2000',
          );
          await attestExecutionBudgetPlatformWriterTransaction(transaction);
          return fn(transaction);
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
    }
    return this.prisma.withWorkspace(scopeKey, fn);
  }

  async open(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
    replayScope?: boolean;
  }): Promise<BudgetAccountAuthorization> {
    assertExecutionBudgetScopeKey(input.scopeKey, { allowPlatform: true });
    assertExecutionBudgetAuthorityId(input.authorityId);
    assertKey('accountKey', input.accountKey);
    try {
      const rows = await this.inAuthorityScope(input.scopeKey, (tx) =>
        tx.$queryRaw<AuthorizedOpenRow[]>(
          Prisma.sql`SELECT * FROM open_tool_budget(
            ${input.scopeKey}, ${input.authorityId}::uuid, ${input.accountKey},
            ${input.replayScope ?? false}
          )`,
        ),
      );
      return parseBudgetAccountAuthorization(rows, input.authorityId);
    } catch (error) {
      if (
        isTrustedExecutionBudgetDatabaseMarker(
          error,
          'TOOL_BUDGET_UNSETTLED_OPERATIONS',
        )
      ) {
        throw new BudgetUnsettledOperationsError(input.accountKey);
      }
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async admitPlatformRun(
    input: PlatformBudgetRunAdmissionInput,
  ): Promise<PlatformBudgetRunAdmission> {
    assertPlatformBudgetRunAdmission(input);
    try {
      const rows = await this.inAuthorityScope('platform', (transaction) =>
        transaction.$queryRaw<PlatformAdmissionRow[]>(
          Prisma.sql`SELECT * FROM admit_platform_execution_budget_run_v1(
            ${input.purpose}::"execution_budget_purpose",
            ${input.subjectType}, ${input.subjectId}, ${input.scheduleId},
            ${input.requestSha256}, ${input.workflowRunId}, ${input.accountKey}
          )`,
        ),
      );
      return parsePlatformBudgetRunAdmission(rows);
    } catch (error) {
      if (
        isTrustedExecutionBudgetDatabaseMarker(
          error,
          'TOOL_BUDGET_UNSETTLED_OPERATIONS',
        )
      ) {
        throw new BudgetUnsettledOperationsError(input.accountKey);
      }
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async attestAuthorized(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
  }): Promise<BudgetAccountAuthorization> {
    assertExecutionBudgetScopeKey(input.scopeKey, { allowPlatform: true });
    assertExecutionBudgetAuthorityId(input.authorityId);
    assertKey('accountKey', input.accountKey);
    try {
      const rows = await this.inAuthorityScope(input.scopeKey, (tx) =>
        tx.$queryRaw<AuthorizedOpenRow[]>(
          Prisma.sql`SELECT * FROM attest_authorized_tool_budget_v1(
            ${input.scopeKey}, ${input.authorityId}::uuid, ${input.accountKey}
          )`,
        ),
      );
      return parseBudgetAccountAuthorization(rows, input.authorityId);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async reserve(input: BudgetReservationRequest): Promise<BudgetReservation> {
    assertKey('accountKey', input.accountKey);
    assertKey('operationKey', input.operationKey);
    // Zero-priced tools still reserve an operation row so distributed idempotency
    // cannot be bypassed merely because the configured price is zero.
    assertMicrousd('estimatedMicrousd', input.estimatedMicrousd);
    let rows: MicrousdReserveRow[];
    try {
      rows = await this.inAuthorityScope(input.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdReserveRow[]>(
          Prisma.sql`SELECT * FROM reserve_tool_budget(${input.workspaceId}, ${input.accountKey}, ${input.operationKey}, ${input.estimatedMicrousd})`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isBudgetAccountUnavailable(error)) throw new BudgetAccountUnavailableError(input.accountKey);
      throw error;
    }
    const row = rows[0];
    if (!row || row.kind === 'ACCOUNT_UNAVAILABLE') throw new BudgetAccountUnavailableError(input.accountKey);
    if (row.kind === 'DENIED') {
      throw new BudgetExceededError(input.accountKey, input.estimatedMicrousd, row.remaining_microusd);
    }
    if (!row.operation_id) throw new BudgetStoreUnavailableError('budget reserve returned no operation id');
    const replayResult = row.kind === 'REPLAY'
      ? replayResultFromLedgerRow(row)
      : undefined;
    const receipt = replayResult?.resultStrategy === 'typed_projection'
      ? requireLedgerProjectionReceipt({
          scopeKey: input.workspaceId,
          expectedOperationId: row.operation_id,
          operationId: row.operation_id,
          operationKey: row.operation_key,
          accountId: row.account_id,
          authorityId: row.authority_id,
          resultSchemaVersion: row.result_schema_version,
          resultSchema: row.result_schema,
          resultDigest: row.result_digest,
          resultJson: row.result_json,
          receiptUsage: row.receipt_usage,
          receiptCostBasis: row.receipt_cost_basis,
          expectedProjection: replayResult.projection,
        })
      : replayResult?.resultStrategy === 'artifact_reference'
        ? requireLedgerArtifactReceipt({
            scopeKey: input.workspaceId,
            expectedOperationId: row.operation_id,
            operationId: row.operation_id,
            operationKey: row.operation_key,
            accountId: row.account_id,
            authorityId: row.authority_id,
            resultSchemaVersion: row.result_schema_version,
            resultSchema: row.result_schema,
            resultDigest: row.result_digest,
            resultJson: row.result_json,
            receiptUsage: row.receipt_usage,
            receiptCostBasis: row.receipt_cost_basis,
            expectedReference: replayResult.reference,
          })
        : undefined;
    if (receipt && receipt.operationKey !== input.operationKey) {
      ledgerReceiptMismatch();
    }
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: row.operation_id,
      estimatedMicrousd: row.reserved_microusd,
      replay: row.kind === 'REPLAY',
      ...(replayResult ? { replayResult } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  async settle(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement> {
    assertMicrousd('observedMicrousd', observedMicrousd);
    const durable = projection
      ? parseGenericOperationProjection(projection)
      : null;
    const explicitFacts = receiptFactsForSettlement(durable, receiptFacts);
    let rows: MicrousdSettleRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdSettleRow[]>(
          Prisma.sql`SELECT * FROM settle_tool_budget(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${observedMicrousd}, ${durable?.schemaVersion ?? null},
            ${durable?.schema ?? null}, ${durable?.digest ?? null},
            ${durable ? JSON.stringify(durable) : null}::jsonb,
            ${explicitFacts ? JSON.stringify(explicitFacts.usage) : null}::jsonb,
            ${explicitFacts?.costBasis ?? null}
          )`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      throw error;
    }
    const row = rows[0];
    if (!row) throw new BudgetStoreUnavailableError('budget settle returned no result');
    const receipt = durable
      ? requireLedgerProjectionReceipt({
          scopeKey: reservation.workspaceId,
          expectedOperationId: reservation.operationId,
          operationId: row.operation_id,
          operationKey: row.operation_key,
          accountId: row.account_id,
          authorityId: row.authority_id,
          resultSchemaVersion: row.result_schema_version,
          resultSchema: row.result_schema,
          resultDigest: row.result_digest,
          resultJson: row.result_json,
          receiptUsage: row.receipt_usage,
          receiptCostBasis: row.receipt_cost_basis,
          expectedProjection: durable,
          expectedFacts: explicitFacts!,
        })
      : undefined;
    return {
      chargedMicrousd: row.charged_microusd,
      observedMicrousd: row.observed_microusd,
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'SETTLED',
      ...(receipt ? { receipt } : {}),
    };
  }

  async markResultUnknown(
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<BudgetResultUnknownTransition> {
    const bound = expected
      ? parseBoundArtifactBudgetSnapshot(expected, reservation)
      : null;
    const durable = bound?.snapshot ?? null;
    const facts = bound?.columns ?? null;
    const durableSubject = bindExpectedArtifactSubject(durable, subjectRef);
    let rows: ResultUnknownRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<ResultUnknownRow[]>(
          Prisma.sql`SELECT * FROM mark_tool_budget_result_unknown_v5(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${durable ? JSON.stringify(durable.manifest) : null}::jsonb,
            ${facts?.expectedHttpStatus ?? null},
            ${facts?.expectedHttpOk ?? null},
            ${facts?.expectedSanitizedUrl ?? null},
            ${facts?.expectedContentHash ?? null},
            ${facts?.expectedBlockedCode ?? null},
            ${facts?.expectedRobotsBlocked ?? null},
            ${durableSubject?.subjectType ?? null},
            ${durableSubject?.subjectId ?? null}::uuid
          )`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isTrustedArtifactDatabaseInvalid(error)) {
        return invalidGenericOperationArtifact();
      }
      if (
        error instanceof BudgetStoreUnavailableError ||
        error instanceof ExecutionBudgetGrantError
      ) {
        throw error;
      }
      throw new BudgetStoreUnavailableError(
        'budget unknown-result transition unavailable',
      );
    }
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.status !== 'RESULT_UNKNOWN' ||
      typeof row.reserved_microusd !== 'bigint' ||
      typeof row.replay !== 'boolean' ||
      typeof row.recoverable !== 'boolean' ||
      row.recoverable !== Boolean(durable)
    ) {
      throw new BudgetStoreUnavailableError(
        'budget unknown-result transition returned no result',
      );
    }
    const reservedMicrousd = row.reserved_microusd;
    if (reservedMicrousd !== reservation.estimatedMicrousd) {
      throw new BudgetStoreUnavailableError(
        'budget unknown-result transition changed the reservation',
      );
    }
    return { reservedMicrousd, replay: row.replay };
  }

  async loadResultUnknownArtifact(
    reservation: BudgetReservation,
    authorityId: string,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<GenericOperationArtifactSnapshot | null> {
    if (
      !isCanonicalArtifactUuid(reservation.operationId) ||
      !isCanonicalArtifactUuid(authorityId) ||
      (reservation.workspaceId !== 'platform' &&
        !isCanonicalArtifactUuid(reservation.workspaceId))
    ) {
      return invalidGenericOperationArtifact();
    }
    const durableSubject = parseOptionalArtifactSubject(subjectRef);
    let rows: UnknownArtifactRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<UnknownArtifactRow[]>(
          Prisma.sql`SELECT * FROM load_tool_budget_result_unknown_artifact_v5(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${authorityId}::uuid,
            ${durableSubject?.subjectType ?? null},
            ${durableSubject?.subjectId ?? null}::uuid
          )`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isTrustedArtifactDatabaseInvalid(error)) {
        return invalidGenericOperationArtifact();
      }
      if (
        error instanceof BudgetStoreUnavailableError ||
        error instanceof ExecutionBudgetGrantError
      ) {
        throw error;
      }
      throw new BudgetStoreUnavailableError(
        'budget unknown-result recovery unavailable',
      );
    }
    if (rows.length !== 1 || !rows[0]) {
      throw new BudgetStoreUnavailableError(
        'budget unknown-result recovery returned no result',
      );
    }
    const row = rows[0];
    const snapshot = parseGenericOperationArtifactSnapshot({
      manifest: row.expected_manifest,
      expectedFacts: expectedFactsFromUnknownRow(row),
    });
    const manifest = snapshot.manifest;
    if (
      manifest.authorityId !== authorityId ||
      manifest.operationId !== reservation.operationId ||
      (reservation.workspaceId === 'platform'
        ? manifest.scopeKind !== 'platform' || manifest.workspaceId !== null
        : manifest.scopeKind !== 'workspace' ||
          manifest.workspaceId !== reservation.workspaceId)
    ) {
      return invalidGenericOperationArtifact();
    }
    return snapshot;
  }

  async settleArtifactManifest(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    snapshot: GenericOperationArtifactSnapshot,
    receiptFacts: DurableExecutionReceiptFacts,
    domainAck: BudgetDomainAckRequest,
    subjectRef?: GenericOperationArtifactSubjectRef,
    objectVersionId?: string,
  ): Promise<BudgetSettlement> {
    assertMicrousd('observedMicrousd', observedMicrousd);
    const { snapshot: durable, columns: facts } =
      parseBoundArtifactBudgetSnapshot(snapshot, reservation);
    const manifest = durable.manifest;
    const durableSubject = bindExpectedArtifactSubject(durable, subjectRef);
    const explicitFacts = parseDurableExecutionReceiptFacts(
      receiptFacts,
      manifest.resultSchema,
    );
    try {
      return await this.inAuthorityScope(reservation.workspaceId, async (tx) => {
        const rows = await tx.$queryRaw<MicrousdSettleRow[]>(
          objectVersionId
            ? Prisma.sql`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v3(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${observedMicrousd}, ${JSON.stringify(manifest)}::jsonb,
            ${facts.expectedHttpStatus}, ${facts.expectedHttpOk},
            ${facts.expectedSanitizedUrl}, ${facts.expectedContentHash},
            ${facts.expectedBlockedCode}, ${facts.expectedRobotsBlocked},
            ${JSON.stringify(explicitFacts.usage)}::jsonb,
            ${explicitFacts.costBasis},
            ${durableSubject?.subjectType ?? null},
            ${durableSubject?.subjectId ?? null}::uuid,
            ${objectVersionId}
          )`
            : Prisma.sql`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v2(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${observedMicrousd}, ${JSON.stringify(manifest)}::jsonb,
            ${facts.expectedHttpStatus}, ${facts.expectedHttpOk},
            ${facts.expectedSanitizedUrl}, ${facts.expectedContentHash},
            ${facts.expectedBlockedCode}, ${facts.expectedRobotsBlocked},
            ${JSON.stringify(explicitFacts.usage)}::jsonb,
            ${explicitFacts.costBasis},
            ${durableSubject?.subjectType ?? null},
            ${durableSubject?.subjectId ?? null}::uuid
          )`,
        );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row ||
          row.status !== 'SETTLED' ||
          typeof row.charged_microusd !== 'bigint' ||
          typeof row.observed_microusd !== 'bigint' ||
          typeof row.cap_variance !== 'boolean'
        ) {
          throw new BudgetStoreUnavailableError(
            'budget artifact settlement returned no result',
          );
        }
        const expectedReference = Object.freeze({
          schemaVersion: 'generic-operation-artifact-ref/v1' as const,
          artifactId: manifest.artifactId,
          operationId: manifest.operationId,
          resultSchema: manifest.resultSchema,
          sha256: manifest.sha256,
          sizeBytes: manifest.sizeBytes,
          mediaType: manifest.mediaType,
          expiresAt: manifest.expiresAt,
        });
        const receipt = requireLedgerArtifactReceipt({
          scopeKey: reservation.workspaceId,
          expectedOperationId: reservation.operationId,
          operationId: row.operation_id,
          operationKey: row.operation_key,
          accountId: row.account_id,
          authorityId: row.authority_id,
          resultSchemaVersion: row.result_schema_version,
          resultSchema: row.result_schema,
          resultDigest: row.result_digest,
          resultJson: row.result_json,
          receiptUsage: row.receipt_usage,
          receiptCostBasis: row.receipt_cost_basis,
          expectedReference,
          expectedFacts: explicitFacts,
        });
        const acknowledgement = await applyDomainAckConsumerTransaction({
          transaction: tx,
          producerId: domainAck.producerId,
          receipt,
          domainAckKey: domainAck.domainAckKey,
          domainRevision: domainAck.domainRevision,
          apply: async () => undefined,
        });
        if (acknowledgement.status === 'UNRECEIPTED') {
          throw new ExecutionControlError('DOMAIN_ACK_RECEIPT_REQUIRED');
        }
        return {
          chargedMicrousd: row.charged_microusd,
          observedMicrousd: row.observed_microusd,
          capVariance: row.cap_variance,
          replay: row.replay ?? false,
          receipt,
          domainAckStatus: acknowledgement.status,
        };
      });
    } catch (error) {
      // A genuine Prisma P2010/P0001 marker is a bounded database contract,
      // not an arbitrary message-only control error. Map it before the shared
      // fail-closed classifier; the marker probe snapshots data descriptors
      // and never invokes caller-controlled accessors.
      if (isTrustedArtifactDatabaseInvalid(error)) {
        return invalidGenericOperationArtifact();
      }
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isPrismaKnownRequestError(error)) {
        throw new BudgetStoreUnavailableError(
          'budget artifact settlement unavailable',
        );
      }
      if (isExecutionControlError(error)) throw error;
      if (
        error instanceof BudgetStoreUnavailableError ||
        error instanceof ExecutionBudgetGrantError
      ) {
        throw error;
      }
      throw new BudgetStoreUnavailableError(
        'budget artifact settlement unavailable',
      );
    }
  }

  async release(reservation: BudgetReservation): Promise<BudgetSettlement> {
    let rows: MicrousdSettleRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdSettleRow[]>(
          Prisma.sql`SELECT * FROM release_tool_budget(${reservation.workspaceId}, ${reservation.operationId}::uuid)`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      throw error;
    }
    const row = rows[0];
    if (!row) throw new BudgetStoreUnavailableError('budget release returned no result');
    return {
      chargedMicrousd: row.charged_microusd,
      observedMicrousd: row.observed_microusd,
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'RELEASED',
    };
  }

  async status(input: { workspaceId: string; accountKey: string }): Promise<BudgetStatus> {
    assertKey('accountKey', input.accountKey);
    let rows: Array<{
      remaining_microusd: bigint;
      exhausted: boolean;
      ref_count: number;
    }>;
    try {
      rows = await this.inAuthorityScope(input.workspaceId, (tx) =>
        tx.$queryRaw<
          Array<{
            remaining_microusd: bigint;
            exhausted: boolean;
            ref_count: number;
          }>
        >(
          Prisma.sql`SELECT * FROM tool_budget_status(${input.workspaceId}, ${input.accountKey})`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      throw error;
    }
    const row = rows[0];
    return row
      ? {
          remainingMicrousd: row.remaining_microusd,
          exhausted: row.exhausted,
          open: row.ref_count > 0,
        }
      : { remainingMicrousd: 0n, exhausted: false, open: false };
  }

  async close(input: { workspaceId: string; accountKey: string; force?: boolean }): Promise<void> {
    assertKey('accountKey', input.accountKey);
    // `force` only drops stale holders. It never releases operations or permits
    // a new generation while PostgreSQL still has RESERVED work.
    try {
      await this.inAuthorityScope(input.workspaceId, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT close_tool_budget(${input.workspaceId}, ${input.accountKey}, ${input.force ?? false})`,
        );
      });
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      throw error;
    }
  }

}
