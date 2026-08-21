import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
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
}

export interface BudgetSettlement {
  chargedCents: number;
  observedCents: number;
  capVariance: boolean;
  replay: boolean;
}

export interface BudgetStatus {
  remainingCents: number;
  exhausted: boolean;
  open: boolean;
}

export interface BudgetAccountAuthorization {
  readonly accountId: string;
  readonly authorityId: string;
  readonly authorizedCapMicrousd: bigint;
  readonly generation: number;
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
  reserve(input: BudgetReservationRequest): Promise<BudgetReservation>;
  settle(
    reservation: BudgetReservation,
    actualCents: number,
    projection?: GenericOperationProjection,
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

  async reserve(): Promise<BudgetReservation> {
    return this.unavailable();
  }

  async settle(): Promise<BudgetSettlement> {
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
}

type ReserveRow = {
  kind: 'EXECUTE' | 'REPLAY' | 'DENIED' | 'ACCOUNT_UNAVAILABLE';
  operation_id: string | null;
  reserved_cents: bigint;
  remaining_cents: bigint;
  status?: string;
  result_json?: unknown;
};

type SettleRow = {
  charged_cents: bigint;
  observed_cents: bigint;
  cap_variance: boolean;
  status: string;
  replay?: boolean;
};

type AuthorizedOpenRow = {
  account_id: string;
  generation: number;
  authority_id: string;
  authorized_cap_microusd: bigint;
};

function assertKey(name: string, value: string): void {
  if (!value || value.length > MAX_KEY_LENGTH || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new TypeError(`${name} must be 1-${MAX_KEY_LENGTH} printable characters`);
  }
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
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        !isExecutionBudgetUuid(row.account_id) ||
        !isExecutionBudgetUuid(row.authority_id) ||
        row.authority_id !== input.authorityId ||
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
          Prisma.sql`SELECT * FROM reserve_tool_budget(${input.workspaceId}, ${input.accountKey}, ${input.operationKey}, ${BigInt(input.estimatedCents)})`,
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
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: row.operation_id,
      estimatedCents: toSafeNumber('reservedCents', row.reserved_cents),
      replay: row.kind === 'REPLAY',
      ...(replayProjection ? { replayProjection } : {}),
    };
  }

  async settle(
    reservation: BudgetReservation,
    actualCents: number,
    projection?: GenericOperationProjection,
  ): Promise<BudgetSettlement> {
    assertCents('actualCents', actualCents, true);
    const durable = projection
      ? parseGenericOperationProjection(projection)
      : null;
    let rows: SettleRow[];
    try {
      rows = await this.inScope(reservation.workspaceId, (tx) =>
        tx.$queryRaw<SettleRow[]>(
          Prisma.sql`SELECT * FROM settle_tool_budget(
            ${reservation.workspaceId}, ${reservation.operationId}::uuid,
            ${BigInt(actualCents)}, ${durable?.schemaVersion ?? null},
            ${durable?.schema ?? null}, ${durable?.digest ?? null},
            ${durable ? JSON.stringify(durable) : null}::jsonb
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
    return {
      chargedCents: toSafeNumber('chargedCents', row.charged_cents),
      observedCents: toSafeNumber('observedCents', row.observed_cents),
      capVariance: row.cap_variance,
      replay: row.replay ?? row.status !== 'SETTLED',
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
}
