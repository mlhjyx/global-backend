export class TestBudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    readonly accountKey: string,
    readonly neededMicrousd: bigint,
    readonly remainingMicrousd: bigint,
  ) {
    super(`budget exceeded for account ${accountKey}`);
    this.name = 'BudgetExceededError';
  }
}

interface Account {
  capCents: number;
  reservedCents: number;
  settledCents: number;
  refs: number;
}

/** Explicit unit-test ledger. It is not exported by any product package. */
export class BudgetLedger {
  private readonly accounts = new Map<string, Account>();
  private readonly exhausted = new Set<string>();

  open(accountKey: string, capCents: number): void {
    const current = this.accounts.get(accountKey);
    if (current) {
      current.capCents = Math.max(current.capCents, capCents);
      current.refs += 1;
    } else {
      this.accounts.set(accountKey, {
        capCents,
        reservedCents: 0,
        settledCents: 0,
        refs: 1,
      });
    }
  }

  reserve(accountKey: string, estimatedCents: number): number {
    const account = this.accounts.get(accountKey);
    if (!account) return estimatedCents;
    const remaining = account.capCents-account.reservedCents-account.settledCents;
    if (estimatedCents > remaining) {
      this.exhausted.add(accountKey);
      throw new TestBudgetExceededError(
        accountKey,
        BigInt(estimatedCents)*10_000n,
        BigInt(remaining)*10_000n,
      );
    }
    account.reservedCents += estimatedCents;
    return estimatedCents;
  }

  settle(accountKey: string, reservedCents: number, actualCents: number): void {
    const account = this.accounts.get(accountKey);
    if (!account) return;
    account.reservedCents = Math.max(0, account.reservedCents-reservedCents);
    account.settledCents += actualCents;
  }

  remainingCents(accountKey: string): number {
    const account = this.accounts.get(accountKey);
    return account
      ? account.capCents-account.reservedCents-account.settledCents
      : Number.POSITIVE_INFINITY;
  }

  wasExhausted(accountKey: string): boolean {
    return this.exhausted.has(accountKey);
  }

  close(accountKey: string, options: boolean | { force?: boolean } = false): void {
    const account = this.accounts.get(accountKey);
    if (!account) return;
    account.refs -= 1;
    const force = typeof options === 'boolean' ? options : options.force === true;
    if (force || account.refs <= 0) {
      this.accounts.delete(accountKey);
      this.exhausted.delete(accountKey);
    }
  }
}

function cents(value: bigint): number {
  if (value % 10_000n !== 0n) throw new TypeError('test ledger requires whole cents');
  const result = Number(value/10_000n);
  if (!Number.isSafeInteger(result)) throw new RangeError('test ledger overflow');
  return result;
}

/** Structural BudgetStore adapter for isolated unit tests only. */
export class InMemoryBudgetStoreAdapter {
  constructor(readonly ledger = new BudgetLedger()) {}

  async open(): Promise<never> { throw new Error('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'); }
  async admitPlatformRun(): Promise<never> { throw new Error('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'); }
  async attestAuthorized(): Promise<never> { throw new Error('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'); }

  async reserve(input: {
    workspaceId: string;
    accountKey: string;
    operationKey: string;
    estimatedMicrousd: bigint;
  }) {
    const reservedCents = this.ledger.reserve(
      input.accountKey,
      cents(input.estimatedMicrousd),
    );
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: input.operationKey,
      estimatedMicrousd: BigInt(reservedCents)*10_000n,
      replay: false,
    };
  }

  async settle(reservation: {
    accountKey: string;
    estimatedMicrousd: bigint;
  }, observedMicrousd: bigint) {
    this.ledger.settle(
      reservation.accountKey,
      cents(reservation.estimatedMicrousd),
      cents(observedMicrousd),
    );
    return {
      chargedMicrousd: observedMicrousd,
      observedMicrousd,
      capVariance: observedMicrousd > reservation.estimatedMicrousd,
      replay: false,
    };
  }

  async release(reservation: { accountKey: string; estimatedMicrousd: bigint }) {
    this.ledger.settle(
      reservation.accountKey,
      cents(reservation.estimatedMicrousd),
      0,
    );
    return {
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      capVariance: false,
      replay: false,
    };
  }

  async status(input: { accountKey: string }) {
    const remaining = this.ledger.remainingCents(input.accountKey);
    return {
      remainingMicrousd: Number.isFinite(remaining) ? BigInt(remaining)*10_000n : 0n,
      exhausted: this.ledger.wasExhausted(input.accountKey),
      open: Number.isFinite(remaining),
    };
  }

  async close(input: { accountKey: string; force?: boolean }): Promise<void> {
    this.ledger.close(input.accountKey, input.force);
  }

  async markResultUnknown(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
  async loadResultUnknownArtifact(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
  async settleArtifactManifest(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
}
