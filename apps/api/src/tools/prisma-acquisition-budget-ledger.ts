import { Prisma } from '@prisma/client';
import {
  AcquisitionBudgetError,
  ZERO_BUDGET_AMOUNT,
  acquisitionBudgetDigest,
  acquisitionBudgetReservationIdentity,
  acquisitionBudgetReservationPayloadDigest,
  acquisitionBudgetSettlementPayloadDigest,
  validateAcquisitionBudgetAuthorization,
  validateAcquisitionBudgetReservation,
  validateAcquisitionBudgetSettlement,
  type AcquisitionBudgetAccountStatus,
  type AcquisitionBudgetAuthorization,
  type AcquisitionBudgetLedgerPort,
  type AcquisitionBudgetReservation,
  type AcquisitionBudgetReservationInput,
  type AcquisitionBudgetSettlement,
  type AcquisitionBudgetSettlementInput,
  type BudgetAmount,
} from './acquisition-budget-ledger';

interface RawQueryClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

export interface WorkspaceTransactionRunner {
  withWorkspace<T>(workspaceId: string, operation: (tx: RawQueryClient) => Promise<T>): Promise<T>;
}

interface DecisionRow {
  decision: string;
  reservation_id?: string | null;
  account_status?: string | null;
  reservation_status?: string | null;
}

function cloneAmount(value: BudgetAmount): BudgetAmount {
  return {
    requestCount: value.requestCount,
    callCount: value.callCount,
    recordCount: value.recordCount,
    modelCallCount: value.modelCallCount,
    costMinor: value.costMinor,
  };
}

function asAccountStatus(value: string | null | undefined): AcquisitionBudgetAccountStatus {
  if (value === 'EXHAUSTED' || value === 'FROZEN' || value === 'EXPIRED') {
    return value;
  }
  return 'ACTIVE';
}

function firstRow(rows: DecisionRow[], operation: string): DecisionRow {
  const row = rows[0];
  if (!row?.decision) {
    throw new AcquisitionBudgetError(
      'INVALID_RESERVATION',
      `${operation} returned no durable decision`,
    );
  }
  return row;
}

function throwDecision(decision: string): never {
  const map = {
    INVALID_AUTHORIZATION: 'INVALID_AUTHORIZATION',
    INVALID_RESERVATION: 'INVALID_RESERVATION',
    NOT_FOUND: 'ACCOUNT_NOT_FOUND',
    EXPIRED: 'ACCOUNT_EXPIRED',
    FROZEN: 'ACCOUNT_FROZEN',
    EXHAUSTED: 'ACCOUNT_EXHAUSTED',
    IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
    IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
    RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  } as const;
  const code = map[decision as keyof typeof map] ?? 'INVALID_RESERVATION';
  throw new AcquisitionBudgetError(code, `acquisition budget database decision: ${decision}`);
}

/**
 * PostgreSQL-backed acquisition ledger. All state transitions are one SQL
 * function call inside a tenant-scoped transaction; no read/modify/write split
 * exists in application code.
 */
export class PrismaAcquisitionBudgetLedger implements AcquisitionBudgetLedgerPort {
  constructor(
    private readonly prisma: WorkspaceTransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async openAccount(
    authorization: AcquisitionBudgetAuthorization,
  ): Promise<{ kind: 'opened' | 'replay' }> {
    validateAcquisitionBudgetAuthorization(authorization, this.now());
    const authorizationHash = acquisitionBudgetDigest(authorization);
    const rows = await this.prisma.withWorkspace(authorization.workspaceId, (tx) =>
      tx.$queryRaw<DecisionRow[]>(Prisma.sql`
          SELECT *
          FROM public.open_acquisition_budget_account(
            ${authorization.accountId},
            ${authorization.workspaceId},
            ${authorization.runId},
            ${authorization.purpose},
            ${authorization.targetKind},
            ${authorization.targetId},
            ${authorization.currency},
            ${authorization.billingUnit},
            ${authorization.limits.requestCount},
            ${authorization.limits.callCount},
            ${authorization.limits.recordCount},
            ${authorization.limits.modelCallCount},
            ${authorization.limits.costMinor},
            ${authorization.expiresAt},
            ${authorizationHash}
          )
        `),
    );
    const row = firstRow(rows, 'open acquisition budget account');
    if (row.decision === 'OPENED') return { kind: 'opened' };
    if (row.decision === 'REPLAY') return { kind: 'replay' };
    return throwDecision(row.decision);
  }

  async reserve(input: AcquisitionBudgetReservationInput): Promise<AcquisitionBudgetReservation> {
    validateAcquisitionBudgetReservation(input);
    const identityKey = acquisitionBudgetReservationIdentity(input);
    const payloadHash = acquisitionBudgetReservationPayloadDigest(input);
    const reservationId = `abr_${identityKey}`;
    const rows = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.$queryRaw<DecisionRow[]>(Prisma.sql`
        SELECT *
        FROM public.reserve_acquisition_budget(
          ${reservationId},
          ${input.accountId},
          ${input.workspaceId},
          ${input.runId},
          ${input.purpose},
          ${input.targetKind},
          ${input.targetId},
          ${input.executionId},
          ${input.attempt},
          ${identityKey},
          ${input.requestFingerprint},
          ${payloadHash},
          ${input.maximum.requestCount},
          ${input.maximum.callCount},
          ${input.maximum.recordCount},
          ${input.maximum.modelCallCount},
          ${input.maximum.costMinor}
        )
      `),
    );
    const row = firstRow(rows, 'reserve acquisition budget');
    if (row.decision !== 'RESERVED' && row.decision !== 'REPLAY') {
      return throwDecision(row.decision);
    }
    if (!row.reservation_id) {
      throw new AcquisitionBudgetError(
        'INVALID_RESERVATION',
        'database reserve decision omitted reservation id',
      );
    }
    return {
      ...input,
      maximum: cloneAmount(input.maximum),
      kind: row.decision === 'REPLAY' ? 'replay' : 'reserved',
      reservationId: row.reservation_id,
    };
  }

  async settle(input: AcquisitionBudgetSettlementInput): Promise<AcquisitionBudgetSettlement> {
    const actual = validateAcquisitionBudgetSettlement(input);
    const rows = await this.prisma.withWorkspace(input.reservation.workspaceId, (tx) =>
      tx.$queryRaw<DecisionRow[]>(Prisma.sql`
          SELECT *
          FROM public.settle_acquisition_budget(
            ${input.reservation.reservationId},
            ${input.reservation.accountId},
            ${input.reservation.workspaceId},
            ${input.reservation.runId},
            ${input.reservation.purpose},
            ${input.reservation.targetKind},
            ${input.reservation.targetId},
            ${input.reservation.executionId},
            ${input.reservation.attempt},
            ${input.outcome},
            ${actual.requestCount},
            ${actual.callCount},
            ${actual.recordCount},
            ${actual.modelCallCount},
            ${actual.costMinor},
            ${acquisitionBudgetSettlementPayloadDigest(input)}
          )
        `),
    );
    const row = firstRow(rows, 'settle acquisition budget');
    const accountStatus = asAccountStatus(row.account_status);
    if (row.decision === 'UNKNOWN' || row.decision === 'FROZEN_OVERRUN') {
      return {
        kind: 'unknown',
        charged: cloneAmount(input.reservation.maximum),
        accountStatus: 'FROZEN',
      };
    }
    if (row.decision === 'SETTLED') {
      return { kind: 'settled', charged: cloneAmount(actual), accountStatus };
    }
    if (row.decision === 'RELEASED') {
      return {
        kind: 'released',
        charged: cloneAmount(ZERO_BUDGET_AMOUNT),
        accountStatus,
      };
    }
    if (row.decision === 'REPLAY') {
      const charged =
        row.reservation_status === 'UNKNOWN'
          ? input.reservation.maximum
          : row.reservation_status === 'RELEASED'
            ? ZERO_BUDGET_AMOUNT
            : actual;
      return { kind: 'replay', charged: cloneAmount(charged), accountStatus };
    }
    return throwDecision(row.decision);
  }
}
