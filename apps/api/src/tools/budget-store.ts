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
import { BudgetExceededError, type BudgetLedger } from './budget';
import {
  parseGenericOperationProjection,
  type GenericOperationProjection,
} from './generic-operation-projection';
import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactUuid,
} from '../durable-results/artifact/artifact.types';
import { parseGenericOperationArtifactSnapshot } from '../durable-results/artifact/generic-operation-artifact.repository';
import {
  expectedFactsFromUnknownRow,
  parseBoundArtifactBudgetSnapshot,
  type GenericOperationArtifactSnapshot,
  type UnknownArtifactRow,
} from './artifact-budget-expected-facts';
import { assertMicrousd } from './microusd';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
  parseDurableExecutionReceiptFacts,
  type DurableExecutionReceiptFacts,
} from '../durable-results/durable-execution-receipt';
const MAX_KEY_LENGTH = 200;

export const TOOL_BUDGET_STORE = Symbol('TOOL_BUDGET_STORE');
export { BudgetExceededError } from './budget';

export interface BudgetReservationRequest {
  workspaceId: string;
  accountKey: string;
  operationKey: string;
  estimatedCents: number;
}

export interface BudgetReservation {
  workspaceId: string;
  accountKey: string;
  operationId: string;
  estimatedCents: number;
  replay: boolean;
  replayProjection?: GenericOperationProjection;
  receipt?: DurableExecutionReceipt;
}

export interface BudgetSettlement {
  chargedCents: number;
  observedCents: number;
  capVariance: boolean;
  replay: boolean;
  receipt?: DurableExecutionReceipt;
}

export interface BudgetResultUnknownTransition {
  reservedCents: number;
  replay: boolean;
}

export interface BudgetStatus {
  remainingCents: number;
  exhausted: boolean;
  open: boolean;
}

/** Additive Task 1 surface. No product caller uses this before Task 6. */
export interface BudgetMicrousdReservationRequest {
  workspaceId: string;
  accountKey: string;
  operationKey: string;
  estimatedMicrousd: bigint;
}

export interface BudgetMicrousdReservation {
  workspaceId: string;
  accountKey: string;
  operationId: string;
  estimatedMicrousd: bigint;
  replay: boolean;
  replayProjection?: GenericOperationProjection;
  receipt?: DurableExecutionReceipt;
}

export interface BudgetMicrousdSettlement {
  chargedMicrousd: bigint;
  observedMicrousd: bigint;
  capVariance: boolean;
  replay: boolean;
  receipt?: DurableExecutionReceipt;
}

export interface BudgetMicrousdStatus {
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
  open(input: { workspaceId: string; accountKey: string; capCents: number; replayScope?: boolean }): Promise<void>;
  openAuthorized(input: {
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
    actualCents: number,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement>;
  /** Physical execution started, but the result/object acknowledgement is unknown. */
  markResultUnknown(
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
  ): Promise<BudgetResultUnknownTransition>;
  /** Loads only facts atomically bound when the original physical result became unknown. */
  loadResultUnknownArtifact(
    reservation: BudgetReservation,
    authorityId: string,
  ): Promise<GenericOperationArtifactSnapshot | null>;
  /** Atomically appends the manifest and settles its exact closed reference. */
  settleArtifactManifest(
    reservation: BudgetReservation,
    actualCents: number,
    snapshot: GenericOperationArtifactSnapshot,
    receiptFacts: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement>;
  release(reservation: BudgetReservation): Promise<BudgetSettlement>;
  status(input: { workspaceId: string; accountKey: string }): Promise<BudgetStatus>;
  /**
   * Drops one holder, or all holder references when force=true. A durable store
   * must retain operations and forbid a new generation while any are unresolved.
   */
  close(input: { workspaceId: string; accountKey: string; force?: boolean }): Promise<void>;
  /** Additive native-unit API. Authority-bound accounts remain nonspendable until Task 6. */
  reserveMicrousd(
    input: BudgetMicrousdReservationRequest,
  ): Promise<BudgetMicrousdReservation>;
  settleMicrousd(
    reservation: BudgetMicrousdReservation,
    observedMicrousd: bigint,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetMicrousdSettlement>;
  releaseMicrousd(
    reservation: BudgetMicrousdReservation,
  ): Promise<BudgetMicrousdSettlement>;
  statusMicrousd(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<BudgetMicrousdStatus>;
  closeMicrousd(input: {
    workspaceId: string;
    accountKey: string;
    force?: boolean;
  }): Promise<void>;
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

export class BudgetMicrousdExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    public readonly accountKey: string,
    public readonly neededMicrousd: bigint,
    public readonly remainingMicrousd: bigint,
  ) {
    super(
      `budget exceeded for account ${accountKey}: need ${neededMicrousd} microusd, remaining ${remainingMicrousd} microusd`,
    );
    this.name = 'BudgetMicrousdExceededError';
  }
}

export class UnavailableBudgetStore implements BudgetStore {
  constructor(private readonly reason = 'authoritative budget store unavailable') {}

  private unavailable(): never {
    throw new BudgetStoreUnavailableError(this.reason);
  }

  async open(): Promise<void> {
    this.unavailable();
  }

  async openAuthorized(): Promise<BudgetAccountAuthorization> {
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

  async reserveMicrousd(): Promise<BudgetMicrousdReservation> {
    return this.unavailable();
  }

  async settleMicrousd(): Promise<BudgetMicrousdSettlement> {
    return this.unavailable();
  }

  async releaseMicrousd(): Promise<BudgetMicrousdSettlement> {
    return this.unavailable();
  }

  async statusMicrousd(): Promise<BudgetMicrousdStatus> {
    return this.unavailable();
  }

  async closeMicrousd(): Promise<void> {
    this.unavailable();
  }
}

/** Compatibility wrapper used only when tests explicitly inject a BudgetLedger. */
export class InMemoryBudgetStoreAdapter implements BudgetStore {
  constructor(private readonly ledger: BudgetLedger) {}

  async open(input: { workspaceId: string; accountKey: string; capCents: number; replayScope?: boolean }): Promise<void> {
    this.ledger.open(input.accountKey, input.capCents);
  }

  async openAuthorized(): Promise<BudgetAccountAuthorization> {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );
  }

  async admitPlatformRun(): Promise<PlatformBudgetRunAdmission> {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );
  }

  async attestAuthorized(): Promise<BudgetAccountAuthorization> {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );
  }

  async reserve(input: BudgetReservationRequest): Promise<BudgetReservation> {
    const handle = this.ledger.reserve(input.accountKey, input.estimatedCents);
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: input.operationKey,
      estimatedCents: handle.estCents,
      replay: false,
    };
  }

  async settle(reservation: BudgetReservation, actualCents: number): Promise<BudgetSettlement> {
    this.ledger.settle({ runId: reservation.accountKey, estCents: reservation.estimatedCents }, actualCents);
    return { chargedCents: actualCents, observedCents: actualCents, capVariance: false, replay: false };
  }

  async markResultUnknown(): Promise<BudgetResultUnknownTransition> {
    throw new BudgetStoreUnavailableError(
      'in-memory budget store cannot persist unknown artifact results',
    );
  }

  async loadResultUnknownArtifact(): Promise<GenericOperationArtifactSnapshot | null> {
    throw new BudgetStoreUnavailableError(
      'in-memory budget store cannot recover unknown artifact results',
    );
  }

  async settleArtifactManifest(): Promise<BudgetSettlement> {
    throw new BudgetStoreUnavailableError(
      'in-memory budget store cannot persist artifact references',
    );
  }

  async release(reservation: BudgetReservation): Promise<BudgetSettlement> {
    this.ledger.settle({ runId: reservation.accountKey, estCents: reservation.estimatedCents }, 0);
    return { chargedCents: 0, observedCents: 0, capVariance: false, replay: false };
  }

  async status(input: { workspaceId: string; accountKey: string }): Promise<BudgetStatus> {
    return {
      remainingCents: this.ledger.remainingCents(input.accountKey),
      exhausted: this.ledger.wasExhausted(input.accountKey),
      open: Number.isFinite(this.ledger.remainingCents(input.accountKey)),
    };
  }

  async close(input: { workspaceId: string; accountKey: string; force?: boolean }): Promise<void> {
    this.ledger.close(input.accountKey, { force: input.force });
  }

  private microusdUnavailable(): never {
    throw new BudgetStoreUnavailableError(
      'deprecated cents-only test adapter has no native microusd ledger',
    );
  }

  async reserveMicrousd(): Promise<BudgetMicrousdReservation> {
    return this.microusdUnavailable();
  }

  async settleMicrousd(): Promise<BudgetMicrousdSettlement> {
    return this.microusdUnavailable();
  }

  async releaseMicrousd(): Promise<BudgetMicrousdSettlement> {
    return this.microusdUnavailable();
  }

  async statusMicrousd(): Promise<BudgetMicrousdStatus> {
    return this.microusdUnavailable();
  }

  async closeMicrousd(): Promise<void> {
    this.microusdUnavailable();
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

type ReserveRow = {
  kind: 'EXECUTE' | 'REPLAY' | 'DENIED' | 'ACCOUNT_UNAVAILABLE';
  operation_id: string | null;
  reserved_cents: bigint;
  remaining_cents: bigint;
  status?: string;
  result_json?: unknown;
  operation_key?: string;
  account_id?: string;
  authority_id?: string | null;
  charged_cents?: bigint | null;
  observed_cents?: bigint | null;
  result_schema_version?: string | null;
  result_schema?: string | null;
  result_digest?: string | null;
  receipt_usage?: unknown;
  receipt_cost_basis?: string | null;
};

type SettleRow = {
  charged_cents: bigint;
  observed_cents: bigint;
  reserved_cents?: bigint;
  cap_variance: boolean;
  status: string;
  replay?: boolean;
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
  reserved_cents: bigint;
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

function assertCents(name: string, value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function toSafeNumber(name: string, value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the JavaScript safe integer range`);
  return result;
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
  });
}

function receiptFactsForSettlement(
  projection: GenericOperationProjection | null,
  receiptFacts: DurableExecutionReceiptFacts | undefined,
): DurableExecutionReceiptFacts | null {
  if (!projection) {
    if (receiptFacts) throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');
    return null;
  }
  if (!receiptFacts) {
    throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED');
  }
  return parseDurableExecutionReceiptFacts(receiptFacts, projection.schema);
}

function requiredReceipt(
  receipt: DurableExecutionReceipt | undefined,
): DurableExecutionReceipt {
  if (!receipt) throw new Error('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED');
  return receipt;
}

function isBudgetAccountUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('TOOL_BUDGET_ACCOUNT_UNAVAILABLE');
}

function isBudgetUnsettled(error: unknown): boolean {
  return error instanceof Error && error.message.includes('TOOL_BUDGET_UNSETTLED_OPERATIONS');
}

function isAuthorityLifecycleUnavailable(error: unknown): boolean {
  return isTrustedExecutionBudgetDatabaseMarker(
    error,
    'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
  );
}

function isTrustedArtifactDatabaseInvalid(error: unknown): boolean {
  return Boolean(
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    error.meta?.code === 'P0001' &&
    error.meta?.message === 'ERROR: GENERIC_OPERATION_ARTIFACT_INVALID',
  );
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
    /** Legacy platform/owner connection; authority-aware operations never use this fallback. */
    private readonly platformDb?: PrismaClient,
    /** Connection authenticated as the deployment-owned platform authority writer principal. */
    private readonly authorityPlatformWriter?: PrismaClient,
  ) {}

  private async inScope<T>(scopeKey: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (scopeKey === 'platform') {
      if (!this.platformDb) throw new BudgetStoreUnavailableError('platform budget store requires an owner connection');
      return this.platformDb.$transaction(fn);
    }
    return this.prisma.withWorkspace(scopeKey, fn);
  }

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

  async open(input: { workspaceId: string; accountKey: string; capCents: number; replayScope?: boolean }): Promise<void> {
    assertKey('accountKey', input.accountKey);
    assertCents('capCents', input.capCents);
    try {
      await this.inScope(input.workspaceId, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT * FROM open_tool_budget(${input.workspaceId}, ${input.accountKey}, ${BigInt(input.capCents)}, ${input.replayScope ?? false})`,
        );
      });
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isBudgetUnsettled(error)) throw new BudgetUnsettledOperationsError(input.accountKey);
      throw error;
    }
  }

  async openAuthorized(input: {
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
          Prisma.sql`SELECT * FROM open_authorized_tool_budget_v1(
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
    assertCents('estimatedCents', input.estimatedCents, true);
    let rows: ReserveRow[];
    try {
      rows = await this.inScope(input.workspaceId, (tx) =>
        tx.$queryRaw<ReserveRow[]>(
          Prisma.sql`SELECT * FROM reserve_tool_budget_with_receipt_v1(${input.workspaceId}, ${input.accountKey}, ${input.operationKey}, ${BigInt(input.estimatedCents)})`,
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
      throw new BudgetExceededError(input.accountKey, input.estimatedCents, toSafeNumber('remainingCents', row.remaining_cents));
    }
    if (!row.operation_id) throw new BudgetStoreUnavailableError('budget reserve returned no operation id');
    const replayProjection =
      row.kind === 'REPLAY' && row.result_json != null
        ? parseGenericOperationProjection(row.result_json)
        : undefined;
    const receipt = row.kind === 'REPLAY' ? durableReceiptFromLedgerRow({
      scopeKey: input.workspaceId,
      operationId: row.operation_id,
      operationKey: row.operation_key ?? input.operationKey,
      accountId: row.account_id,
      authorityId: row.authority_id,
      resultSchemaVersion: row.result_schema_version,
      resultSchema: row.result_schema,
      resultDigest: row.result_digest,
      resultJson: row.result_json,
      receiptUsage: row.receipt_usage,
      receiptCostBasis: row.receipt_cost_basis,
    }) : undefined;
    if (replayProjection) requiredReceipt(receipt);
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: row.operation_id,
      estimatedCents: toSafeNumber('reservedCents', row.reserved_cents),
      replay: row.kind === 'REPLAY',
      ...(replayProjection ? { replayProjection } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  async settle(
    reservation: BudgetReservation,
    actualCents: number,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement> {
    assertCents('actualCents', actualCents, true);
    const durable = projection
      ? parseGenericOperationProjection(projection)
      : null;
    const explicitFacts = receiptFactsForSettlement(durable, receiptFacts);
    let rows: SettleRow[];
    try {
      rows = await this.inScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<SettleRow[]>(
          Prisma.sql`SELECT * FROM settle_tool_budget_with_receipt_v1(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${BigInt(actualCents)}, ${durable?.schemaVersion ?? null},
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
    const receipt = durableReceiptFromLedgerRow({
      scopeKey: reservation.workspaceId,
      operationId: row.operation_id ?? reservation.operationId,
      operationKey: row.operation_key,
      accountId: row.account_id,
      authorityId: row.authority_id,
      resultSchemaVersion: row.result_schema_version ?? durable?.schemaVersion,
      resultSchema: row.result_schema ?? durable?.schema,
      resultDigest: row.result_digest ?? durable?.digest,
      resultJson: row.result_json ?? durable,
      receiptUsage: row.receipt_usage,
      receiptCostBasis: row.receipt_cost_basis,
    });
    if (durable) requiredReceipt(receipt);
    return {
      chargedCents: toSafeNumber('chargedCents', row.charged_cents),
      observedCents: toSafeNumber('observedCents', row.observed_cents),
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'SETTLED',
      ...(receipt ? { receipt } : {}),
    };
  }

  async markResultUnknown(
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
  ): Promise<BudgetResultUnknownTransition> {
    const bound = expected
      ? parseBoundArtifactBudgetSnapshot(expected, reservation)
      : null;
    const durable = bound?.snapshot ?? null;
    const facts = bound?.columns ?? null;
    let rows: ResultUnknownRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<ResultUnknownRow[]>(
          Prisma.sql`SELECT * FROM mark_tool_budget_result_unknown_v3(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${durable ? JSON.stringify(durable.manifest) : null}::jsonb,
            ${facts?.expectedHttpStatus ?? null},
            ${facts?.expectedHttpOk ?? null},
            ${facts?.expectedSanitizedUrl ?? null},
            ${facts?.expectedContentHash ?? null},
            ${facts?.expectedBlockedCode ?? null},
            ${facts?.expectedRobotsBlocked ?? null}
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
      typeof row.reserved_cents !== 'bigint' ||
      typeof row.replay !== 'boolean' ||
      typeof row.recoverable !== 'boolean' ||
      row.recoverable !== Boolean(durable)
    ) {
      throw new BudgetStoreUnavailableError(
        'budget unknown-result transition returned no result',
      );
    }
    const reservedCents = toSafeNumber('reservedCents', row.reserved_cents);
    if (reservedCents !== reservation.estimatedCents) {
      throw new BudgetStoreUnavailableError(
        'budget unknown-result transition changed the reservation',
      );
    }
    return { reservedCents, replay: row.replay };
  }

  async loadResultUnknownArtifact(
    reservation: BudgetReservation,
    authorityId: string,
  ): Promise<GenericOperationArtifactSnapshot | null> {
    if (
      !isCanonicalArtifactUuid(reservation.operationId) ||
      !isCanonicalArtifactUuid(authorityId) ||
      (reservation.workspaceId !== 'platform' &&
        !isCanonicalArtifactUuid(reservation.workspaceId))
    ) {
      return invalidGenericOperationArtifact();
    }
    let rows: UnknownArtifactRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<UnknownArtifactRow[]>(
          Prisma.sql`SELECT * FROM load_tool_budget_result_unknown_artifact_v3(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${authorityId}::uuid
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
    actualCents: number,
    snapshot: GenericOperationArtifactSnapshot,
    receiptFacts: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement> {
    assertCents('actualCents', actualCents, true);
    const { snapshot: durable, columns: facts } =
      parseBoundArtifactBudgetSnapshot(snapshot, reservation);
    const manifest = durable.manifest;
    const explicitFacts = parseDurableExecutionReceiptFacts(
      receiptFacts,
      manifest.resultSchema,
    );
    let rows: SettleRow[];
    try {
      rows = await this.inAuthorityScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<SettleRow[]>(
          Prisma.sql`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v1(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${BigInt(actualCents)}, ${JSON.stringify(manifest)}::jsonb,
            ${facts.expectedHttpStatus}, ${facts.expectedHttpOk},
            ${facts.expectedSanitizedUrl}, ${facts.expectedContentHash},
            ${facts.expectedBlockedCode}, ${facts.expectedRobotsBlocked},
            ${JSON.stringify(explicitFacts.usage)}::jsonb,
            ${explicitFacts.costBasis}
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
        'budget artifact settlement unavailable',
      );
    }
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.status !== 'SETTLED' ||
      typeof row.charged_cents !== 'bigint' ||
      typeof row.observed_cents !== 'bigint' ||
      typeof row.cap_variance !== 'boolean'
    ) {
      throw new BudgetStoreUnavailableError(
        'budget artifact settlement returned no result',
      );
    }
    const receipt = requiredReceipt(durableReceiptFromLedgerRow({
      scopeKey: reservation.workspaceId,
      operationId: row.operation_id ?? reservation.operationId,
      operationKey: row.operation_key,
      accountId: row.account_id,
      authorityId: row.authority_id,
      resultSchemaVersion: row.result_schema_version ?? 'generic-operation-artifact-ref/v1',
      resultSchema: row.result_schema ?? manifest.resultSchema,
      resultDigest: row.result_digest ?? manifest.sha256,
      resultJson: row.result_json ?? {
        schemaVersion: 'generic-operation-artifact-ref/v1',
        artifactId: manifest.artifactId,
      },
      receiptUsage: row.receipt_usage,
      receiptCostBasis: row.receipt_cost_basis,
    }));
    return {
      chargedCents: toSafeNumber('chargedCents', row.charged_cents),
      observedCents: toSafeNumber('observedCents', row.observed_cents),
      capVariance: row.cap_variance,
      replay: row.replay ?? false,
      receipt,
    };
  }

  async release(reservation: BudgetReservation): Promise<BudgetSettlement> {
    let rows: SettleRow[];
    try {
      rows = await this.inScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<SettleRow[]>(
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
      chargedCents: toSafeNumber('chargedCents', row.charged_cents),
      observedCents: toSafeNumber('observedCents', row.observed_cents),
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'RELEASED',
    };
  }

  async status(input: { workspaceId: string; accountKey: string }): Promise<BudgetStatus> {
    assertKey('accountKey', input.accountKey);
    let rows: Array<{
      remaining_cents: bigint;
      exhausted: boolean;
      ref_count: number;
    }>;
    try {
      rows = await this.inScope(input.workspaceId, (tx) =>
        tx.$queryRaw<
          Array<{
            remaining_cents: bigint;
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
          remainingCents: toSafeNumber('remainingCents', row.remaining_cents),
          exhausted: row.exhausted,
          open: row.ref_count > 0,
        }
      : { remainingCents: 0, exhausted: false, open: false };
  }

  async close(input: { workspaceId: string; accountKey: string; force?: boolean }): Promise<void> {
    assertKey('accountKey', input.accountKey);
    // `force` only drops stale holders. It never releases operations or permits
    // a new generation while PostgreSQL still has RESERVED work.
    try {
      await this.inScope(input.workspaceId, async (tx) => {
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

  async reserveMicrousd(
    input: BudgetMicrousdReservationRequest,
  ): Promise<BudgetMicrousdReservation> {
    assertKey('accountKey', input.accountKey);
    assertKey('operationKey', input.operationKey);
    assertMicrousd('estimatedMicrousd', input.estimatedMicrousd);
    let rows: MicrousdReserveRow[];
    try {
      rows = await this.inScope(input.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdReserveRow[]>(
          Prisma.sql`SELECT * FROM reserve_tool_budget_microusd_with_receipt_v1(
            ${input.workspaceId}, ${input.accountKey}, ${input.operationKey},
            ${input.estimatedMicrousd}
          )`,
        ),
      );
    } catch (error) {
      if (isAuthorityLifecycleUnavailable(error)) {
        throw authorityLifecycleUnavailable();
      }
      if (isBudgetAccountUnavailable(error)) {
        throw new BudgetAccountUnavailableError(input.accountKey);
      }
      throw error;
    }
    const row = rows[0];
    if (!row || row.kind === 'ACCOUNT_UNAVAILABLE') {
      throw new BudgetAccountUnavailableError(input.accountKey);
    }
    if (row.kind === 'DENIED') {
      throw new BudgetMicrousdExceededError(
        input.accountKey,
        input.estimatedMicrousd,
        row.remaining_microusd,
      );
    }
    if (!row.operation_id) {
      throw new BudgetStoreUnavailableError(
        'microusd budget reserve returned no operation id',
      );
    }
    const replayProjection =
      row.kind === 'REPLAY' && row.result_json != null
        ? parseGenericOperationProjection(row.result_json)
        : undefined;
    const receipt = row.kind === 'REPLAY' ? durableReceiptFromLedgerRow({
      scopeKey: input.workspaceId,
      operationId: row.operation_id,
      operationKey: row.operation_key ?? input.operationKey,
      accountId: row.account_id,
      authorityId: row.authority_id,
      resultSchemaVersion: row.result_schema_version,
      resultSchema: row.result_schema,
      resultDigest: row.result_digest,
      resultJson: row.result_json,
      receiptUsage: row.receipt_usage,
      receiptCostBasis: row.receipt_cost_basis,
    }) : undefined;
    if (replayProjection) requiredReceipt(receipt);
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: row.operation_id,
      estimatedMicrousd: row.reserved_microusd,
      replay: row.kind === 'REPLAY',
      ...(replayProjection ? { replayProjection } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  async settleMicrousd(
    reservation: BudgetMicrousdReservation,
    observedMicrousd: bigint,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetMicrousdSettlement> {
    assertMicrousd('observedMicrousd', observedMicrousd);
    const durable = projection
      ? parseGenericOperationProjection(projection)
      : null;
    const explicitFacts = receiptFactsForSettlement(durable, receiptFacts);
    let rows: MicrousdSettleRow[];
    try {
      rows = await this.inScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdSettleRow[]>(
          Prisma.sql`SELECT * FROM settle_tool_budget_microusd_with_receipt_v1(
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
    if (!row) {
      throw new BudgetStoreUnavailableError(
        'microusd budget settle returned no result',
      );
    }
    const receipt = durableReceiptFromLedgerRow({
      scopeKey: reservation.workspaceId,
      operationId: row.operation_id ?? reservation.operationId,
      operationKey: row.operation_key,
      accountId: row.account_id,
      authorityId: row.authority_id,
      resultSchemaVersion: row.result_schema_version ?? durable?.schemaVersion,
      resultSchema: row.result_schema ?? durable?.schema,
      resultDigest: row.result_digest ?? durable?.digest,
      resultJson: row.result_json ?? durable,
      receiptUsage: row.receipt_usage,
      receiptCostBasis: row.receipt_cost_basis,
    });
    if (durable) requiredReceipt(receipt);
    return {
      chargedMicrousd: row.charged_microusd,
      observedMicrousd: row.observed_microusd,
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'SETTLED',
      ...(receipt ? { receipt } : {}),
    };
  }

  async releaseMicrousd(
    reservation: BudgetMicrousdReservation,
  ): Promise<BudgetMicrousdSettlement> {
    let rows: MicrousdSettleRow[];
    try {
      rows = await this.inScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<MicrousdSettleRow[]>(
          Prisma.sql`SELECT * FROM release_tool_budget_microusd_v1(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid
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
    if (!row) {
      throw new BudgetStoreUnavailableError(
        'microusd budget release returned no result',
      );
    }
    return {
      chargedMicrousd: row.charged_microusd,
      observedMicrousd: row.observed_microusd,
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'RELEASED',
    };
  }

  async statusMicrousd(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<BudgetMicrousdStatus> {
    assertKey('accountKey', input.accountKey);
    let rows: Array<{
      remaining_microusd: bigint;
      exhausted: boolean;
      ref_count: number;
    }>;
    try {
      rows = await this.inScope(input.workspaceId, (tx) =>
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM tool_budget_status_microusd_v1(
            ${input.workspaceId}, ${input.accountKey}
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
    return row
      ? {
          remainingMicrousd: row.remaining_microusd,
          exhausted: row.exhausted,
          open: row.ref_count > 0,
        }
      : { remainingMicrousd: 0n, exhausted: false, open: false };
  }

  async closeMicrousd(input: {
    workspaceId: string;
    accountKey: string;
    force?: boolean;
  }): Promise<void> {
    assertKey('accountKey', input.accountKey);
    try {
      await this.inScope(input.workspaceId, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT close_tool_budget_microusd_v1(
            ${input.workspaceId}, ${input.accountKey}, ${input.force ?? false}
          )`,
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
