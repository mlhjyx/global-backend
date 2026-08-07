import { createHash } from 'node:crypto';

export type AcquisitionBudgetTargetKind = 'SOURCE' | 'MODEL' | 'TOOL';
export type AcquisitionBudgetAccountStatus = 'ACTIVE' | 'EXHAUSTED' | 'FROZEN' | 'EXPIRED';
export type AcquisitionBudgetSettlementOutcome = 'SETTLED' | 'RELEASED' | 'UNKNOWN';

/** Every acquisition limit is an integer count in its named minimum unit. */
export interface BudgetAmount {
  requestCount: bigint;
  callCount: bigint;
  recordCount: bigint;
  modelCallCount: bigint;
  costMinor: bigint;
}

export const ZERO_BUDGET_AMOUNT: Readonly<BudgetAmount> = Object.freeze({
  requestCount: 0n,
  callCount: 0n,
  recordCount: 0n,
  modelCallCount: 0n,
  costMinor: 0n,
});

export interface AcquisitionBudgetAuthorization {
  accountId: string;
  workspaceId: string;
  runId: string;
  purpose: string;
  targetKind: AcquisitionBudgetTargetKind;
  targetId: string;
  currency: string;
  billingUnit: string;
  limits: BudgetAmount;
  expiresAt: Date;
}

export interface AcquisitionBudgetReservationInput {
  accountId: string;
  workspaceId: string;
  runId: string;
  purpose: string;
  targetKind: AcquisitionBudgetTargetKind;
  targetId: string;
  executionId: string;
  attempt: number;
  /** SHA-256 of the target-specific request. Payload drift on replay is a conflict. */
  requestFingerprint: string;
  /** Worst-case usage reserved before any client or provider call. */
  maximum: BudgetAmount;
}

export interface AcquisitionBudgetReservation extends AcquisitionBudgetReservationInput {
  kind: 'reserved' | 'replay';
  reservationId: string;
}

export interface AcquisitionBudgetSettlementInput {
  reservation: AcquisitionBudgetReservation;
  outcome: AcquisitionBudgetSettlementOutcome;
  actual?: BudgetAmount;
}

export interface AcquisitionBudgetSettlement {
  kind: 'settled' | 'released' | 'unknown' | 'replay';
  charged: BudgetAmount;
  accountStatus: AcquisitionBudgetAccountStatus;
}

export interface AcquisitionBudgetAccountInspection {
  status: AcquisitionBudgetAccountStatus;
  remaining: BudgetAmount;
}

export interface AcquisitionBudgetLedgerPort {
  openAccount(
    authorization: AcquisitionBudgetAuthorization,
  ): Promise<{ kind: 'opened' | 'replay' }>;
  reserve(input: AcquisitionBudgetReservationInput): Promise<AcquisitionBudgetReservation>;
  settle(input: AcquisitionBudgetSettlementInput): Promise<AcquisitionBudgetSettlement>;
}

export type AcquisitionBudgetErrorCode =
  | 'INVALID_AUTHORIZATION'
  | 'INVALID_RESERVATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_EXPIRED'
  | 'ACCOUNT_FROZEN'
  | 'ACCOUNT_EXHAUSTED'
  | 'IDENTITY_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESERVATION_NOT_FOUND';

export class AcquisitionBudgetError extends Error {
  constructor(
    public readonly code: AcquisitionBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AcquisitionBudgetError';
  }
}

const AMOUNT_KEYS = [
  'requestCount',
  'callCount',
  'recordCount',
  'modelCallCount',
  'costMinor',
] as const;
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function cloneAmount(value: BudgetAmount): BudgetAmount {
  return {
    requestCount: value.requestCount,
    callCount: value.callCount,
    recordCount: value.recordCount,
    modelCallCount: value.modelCallCount,
    costMinor: value.costMinor,
  };
}

function amountMap(
  left: BudgetAmount,
  right: BudgetAmount,
  operation: (a: bigint, b: bigint) => bigint,
): BudgetAmount {
  return {
    requestCount: operation(left.requestCount, right.requestCount),
    callCount: operation(left.callCount, right.callCount),
    recordCount: operation(left.recordCount, right.recordCount),
    modelCallCount: operation(left.modelCallCount, right.modelCallCount),
    costMinor: operation(left.costMinor, right.costMinor),
  };
}

function isZero(value: BudgetAmount): boolean {
  return AMOUNT_KEYS.every((key) => value[key] === 0n);
}

function isWithin(actual: BudgetAmount, maximum: BudgetAmount): boolean {
  return AMOUNT_KEYS.every((key) => actual[key] <= maximum[key]);
}

function isNonNegativeIntegerAmount(value: BudgetAmount): boolean {
  return AMOUNT_KEYS.every(
    (key) =>
      typeof value[key] === 'bigint' &&
      value[key] >= 0n &&
      value[key] <= POSTGRES_BIGINT_MAX,
  );
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function acquisitionBudgetDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireIdentity(value: {
  accountId: string;
  workspaceId: string;
  runId: string;
  purpose: string;
  targetKind: AcquisitionBudgetTargetKind;
  targetId: string;
}): void {
  const boundedStrings = [
    [value.accountId, 80],
    [value.runId, 200],
    [value.purpose, 80],
    [value.targetId, 200],
  ] as const;
  if (
    boundedStrings.some(
      ([item, maximum]) =>
        typeof item !== 'string' || item.trim().length === 0 || item.length > maximum,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.workspaceId,
    ) ||
    !(['SOURCE', 'MODEL', 'TOOL'] as const).includes(value.targetKind)
  ) {
    throw new AcquisitionBudgetError(
      'INVALID_AUTHORIZATION',
      'acquisition budget identity must be complete and target-exact',
    );
  }
}

export function validateAcquisitionBudgetAuthorization(
  authorization: AcquisitionBudgetAuthorization,
  now: Date,
): void {
  requireIdentity(authorization);
  if (
    !isNonNegativeIntegerAmount(authorization.limits) ||
    isZero(authorization.limits) ||
    !(authorization.expiresAt instanceof Date) ||
    !Number.isFinite(authorization.expiresAt.getTime()) ||
    authorization.expiresAt.getTime() <= now.getTime() ||
    !/^[A-Z]{3}$/.test(authorization.currency) ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(authorization.billingUnit)
  ) {
    throw new AcquisitionBudgetError(
      'INVALID_AUTHORIZATION',
      'acquisition budget authorization must be finite, non-empty, and unexpired',
    );
  }
}

export function acquisitionBudgetReservationIdentity(
  input: AcquisitionBudgetReservationInput,
): string {
  return acquisitionBudgetDigest({
    workspaceId: input.workspaceId,
    runId: input.runId,
    accountId: input.accountId,
    purpose: input.purpose,
    targetKind: input.targetKind,
    targetId: input.targetId,
    executionId: input.executionId,
    attempt: input.attempt,
  });
}

export function acquisitionBudgetReservationPayloadDigest(
  input: AcquisitionBudgetReservationInput,
): string {
  return acquisitionBudgetDigest({
    identity: acquisitionBudgetReservationIdentity(input),
    requestFingerprint: input.requestFingerprint,
    maximum: input.maximum,
  });
}

export function acquisitionBudgetSettlementPayloadDigest(
  input: AcquisitionBudgetSettlementInput,
): string {
  return acquisitionBudgetDigest({
    reservationId: input.reservation.reservationId,
    outcome: input.outcome,
    actual: input.actual ?? null,
  });
}

export function validateAcquisitionBudgetReservation(
  input: AcquisitionBudgetReservationInput,
): void {
  try {
    requireIdentity(input);
  } catch (error) {
    if (error instanceof AcquisitionBudgetError) {
      throw new AcquisitionBudgetError('INVALID_RESERVATION', error.message);
    }
    throw error;
  }
  if (
    typeof input.executionId !== 'string' ||
    input.executionId.trim().length === 0 ||
    input.executionId.length > 240 ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > POSTGRES_INTEGER_MAX ||
    !/^[0-9a-f]{64}$/.test(input.requestFingerprint) ||
    !isNonNegativeIntegerAmount(input.maximum) ||
    isZero(input.maximum)
  ) {
    throw new AcquisitionBudgetError(
      'INVALID_RESERVATION',
      'reservation requires execution, attempt, request hash, and finite maximums',
    );
  }
}

export function validateAcquisitionBudgetSettlement(
  input: AcquisitionBudgetSettlementInput,
): BudgetAmount {
  validateAcquisitionBudgetReservation(input.reservation);
  if (!(['SETTLED', 'RELEASED', 'UNKNOWN'] as const).includes(input.outcome)) {
    throw new AcquisitionBudgetError('INVALID_RESERVATION', 'settlement outcome is not recognized');
  }
  const actual = input.actual ?? cloneAmount(ZERO_BUDGET_AMOUNT);
  if (!isNonNegativeIntegerAmount(actual) || (input.outcome === 'RELEASED' && !isZero(actual))) {
    throw new AcquisitionBudgetError(
      'INVALID_RESERVATION',
      'settlement usage must be non-negative and released usage must be zero',
    );
  }
  return actual;
}

interface MemoryAccount {
  authorization: AcquisitionBudgetAuthorization;
  authorizationDigest: string;
  status: AcquisitionBudgetAccountStatus;
  reserved: BudgetAmount;
  settled: BudgetAmount;
}

interface MemoryReservation {
  reservation: AcquisitionBudgetReservation;
  payloadDigest: string;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED' | 'UNKNOWN';
  settlementDigest?: string;
  charged?: BudgetAmount;
}

/** Deterministic test adapter with the same fail-closed contract as the DB port. */
export class InMemoryAcquisitionBudgetLedger implements AcquisitionBudgetLedgerPort {
  private readonly accounts = new Map<string, MemoryAccount>();
  private readonly reservationsByIdentity = new Map<string, MemoryReservation>();
  private readonly reservationsById = new Map<string, MemoryReservation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async openAccount(
    authorization: AcquisitionBudgetAuthorization,
  ): Promise<{ kind: 'opened' | 'replay' }> {
    validateAcquisitionBudgetAuthorization(authorization, this.now());
    const digest = acquisitionBudgetDigest(authorization);
    const existing = this.accounts.get(authorization.accountId);
    if (existing) {
      if (existing.authorizationDigest !== digest) {
        throw new AcquisitionBudgetError(
          'IDEMPOTENCY_CONFLICT',
          `budget account ${authorization.accountId} authorization differs`,
        );
      }
      return { kind: 'replay' };
    }
    this.accounts.set(authorization.accountId, {
      authorization: {
        ...authorization,
        limits: cloneAmount(authorization.limits),
        expiresAt: new Date(authorization.expiresAt),
      },
      authorizationDigest: digest,
      status: 'ACTIVE',
      reserved: cloneAmount(ZERO_BUDGET_AMOUNT),
      settled: cloneAmount(ZERO_BUDGET_AMOUNT),
    });
    return { kind: 'opened' };
  }

  async reserve(input: AcquisitionBudgetReservationInput): Promise<AcquisitionBudgetReservation> {
    validateAcquisitionBudgetReservation(input);
    const account = this.accounts.get(input.accountId);
    if (!account) {
      throw new AcquisitionBudgetError(
        'ACCOUNT_NOT_FOUND',
        `budget account ${input.accountId} has not been authorized`,
      );
    }
    this.assertAccountIdentity(account, input);

    const identity = acquisitionBudgetReservationIdentity(input);
    const payloadDigest = acquisitionBudgetReservationPayloadDigest(input);
    const existing = this.reservationsByIdentity.get(identity);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) {
        throw new AcquisitionBudgetError(
          'IDEMPOTENCY_CONFLICT',
          'reservation identity replayed with a different payload',
        );
      }
      return { ...existing.reservation, kind: 'replay' };
    }

    this.refreshExpiry(account);
    this.assertAccountConsumable(account);

    const remaining = this.remaining(account);
    if (!isWithin(input.maximum, remaining)) {
      account.status = 'EXHAUSTED';
      throw new AcquisitionBudgetError(
        'ACCOUNT_EXHAUSTED',
        `budget account ${input.accountId} cannot satisfy the maximum reservation`,
      );
    }
    account.reserved = amountMap(account.reserved, input.maximum, (a, b) => a + b);
    const reservation: AcquisitionBudgetReservation = {
      ...input,
      maximum: cloneAmount(input.maximum),
      kind: 'reserved',
      reservationId: `abr_${identity}`,
    };
    const state: MemoryReservation = {
      reservation,
      payloadDigest,
      status: 'RESERVED',
    };
    this.reservationsByIdentity.set(identity, state);
    this.reservationsById.set(reservation.reservationId, state);
    return reservation;
  }

  async settle(input: AcquisitionBudgetSettlementInput): Promise<AcquisitionBudgetSettlement> {
    const actual = validateAcquisitionBudgetSettlement(input);
    const state = this.reservationsById.get(input.reservation.reservationId);
    if (!state) {
      throw new AcquisitionBudgetError(
        'RESERVATION_NOT_FOUND',
        `reservation ${input.reservation.reservationId} does not exist`,
      );
    }
    if (
      state.payloadDigest !== acquisitionBudgetReservationPayloadDigest(input.reservation) ||
      state.reservation.accountId !== input.reservation.accountId
    ) {
      throw new AcquisitionBudgetError(
        'IDENTITY_MISMATCH',
        'settlement reservation identity does not match the durable reservation',
      );
    }
    const settlementDigest = acquisitionBudgetSettlementPayloadDigest(input);
    const account = this.accounts.get(state.reservation.accountId);
    if (!account) {
      throw new AcquisitionBudgetError('ACCOUNT_NOT_FOUND', 'reservation account no longer exists');
    }
    if (state.status !== 'RESERVED') {
      if (state.settlementDigest !== settlementDigest) {
        throw new AcquisitionBudgetError(
          'IDEMPOTENCY_CONFLICT',
          'settlement replayed with a different outcome or actual usage',
        );
      }
      return {
        kind: 'replay',
        charged: cloneAmount(state.charged ?? ZERO_BUDGET_AMOUNT),
        accountStatus: account.status,
      };
    }

    let kind: AcquisitionBudgetSettlement['kind'];
    let charged: BudgetAmount;
    const overrun = input.outcome === 'SETTLED' && !isWithin(actual, state.reservation.maximum);
    if (input.outcome === 'UNKNOWN' || overrun) {
      kind = 'unknown';
      charged = cloneAmount(state.reservation.maximum);
      state.status = 'UNKNOWN';
      account.status = 'FROZEN';
    } else if (input.outcome === 'RELEASED') {
      kind = 'released';
      charged = cloneAmount(ZERO_BUDGET_AMOUNT);
      state.status = 'RELEASED';
    } else {
      kind = 'settled';
      charged = cloneAmount(actual);
      state.status = 'SETTLED';
    }

    account.reserved = amountMap(account.reserved, state.reservation.maximum, (a, b) => a - b);
    account.settled = amountMap(account.settled, charged, (a, b) => a + b);
    if (account.status === 'ACTIVE' && this.isFullyConsumed(account)) {
      account.status = 'EXHAUSTED';
    }
    state.settlementDigest = settlementDigest;
    state.charged = charged;
    return {
      kind,
      charged: cloneAmount(charged),
      accountStatus: account.status,
    };
  }

  async inspectAccount(accountId: string): Promise<AcquisitionBudgetAccountInspection | null> {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    this.refreshExpiry(account);
    return { status: account.status, remaining: this.remaining(account) };
  }

  private assertAccountIdentity(
    account: MemoryAccount,
    input: AcquisitionBudgetReservationInput,
  ): void {
    const expected = account.authorization;
    if (
      expected.workspaceId !== input.workspaceId ||
      expected.runId !== input.runId ||
      expected.purpose !== input.purpose ||
      expected.targetKind !== input.targetKind ||
      expected.targetId !== input.targetId
    ) {
      throw new AcquisitionBudgetError(
        'IDENTITY_MISMATCH',
        'reservation does not match the authorized workspace/run/purpose/target',
      );
    }
  }

  private refreshExpiry(account: MemoryAccount): void {
    if (
      account.status === 'ACTIVE' &&
      account.authorization.expiresAt.getTime() <= this.now().getTime()
    ) {
      account.status = 'EXPIRED';
    }
  }

  private assertAccountConsumable(account: MemoryAccount): void {
    if (account.status !== 'ACTIVE') {
      throw new AcquisitionBudgetError(
        `ACCOUNT_${account.status}` as AcquisitionBudgetErrorCode,
        `budget account is ${account.status.toLowerCase()}`,
      );
    }
  }

  private remaining(account: MemoryAccount): BudgetAmount {
    return amountMap(
      amountMap(account.authorization.limits, account.reserved, (a, b) => a - b),
      account.settled,
      (a, b) => a - b,
    );
  }

  private isFullyConsumed(account: MemoryAccount): boolean {
    const remaining = this.remaining(account);
    return AMOUNT_KEYS.some(
      (key) => account.authorization.limits[key] > 0n && remaining[key] === 0n,
    );
  }
}
