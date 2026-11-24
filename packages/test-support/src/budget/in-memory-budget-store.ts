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
  capMicrousd: bigint;
  reservedMicrousd: bigint;
  settledMicrousd: bigint;
  refs: number;
}

const MICROUSD_PER_CENT = 10_000n;

function centsToMicro(centsValue: number): bigint {
  return BigInt(Math.round(centsValue * Number(MICROUSD_PER_CENT)));
}

/** Explicit unit-test ledger. It is not exported by any product package. */
export class BudgetLedger {
  private readonly accounts = new Map<string, Account>();
  private readonly exhausted = new Set<string>();

  open(accountKey: string, capCents: number): void {
    const capMicrousd = centsToMicro(capCents);
    const current = this.accounts.get(accountKey);
    if (current) {
      if (capMicrousd > current.capMicrousd) current.capMicrousd = capMicrousd;
      current.refs += 1;
    } else {
      this.accounts.set(accountKey, {
        capMicrousd,
        reservedMicrousd: 0n,
        settledMicrousd: 0n,
        refs: 1,
      });
    }
  }

  reserveMicrousd(accountKey: string, estimatedMicrousd: bigint): bigint {
    const account = this.accounts.get(accountKey);
    if (!account) return estimatedMicrousd;
    const remaining = account.capMicrousd - account.reservedMicrousd - account.settledMicrousd;
    if (estimatedMicrousd > remaining) {
      this.exhausted.add(accountKey);
      throw new TestBudgetExceededError(accountKey, estimatedMicrousd, remaining);
    }
    account.reservedMicrousd += estimatedMicrousd;
    return estimatedMicrousd;
  }

  reserve(accountKey: string, estimatedCents: number): number {
    this.reserveMicrousd(accountKey, centsToMicro(estimatedCents));
    return estimatedCents;
  }

  settleMicrousd(accountKey: string, reservedMicrousd: bigint, actualMicrousd: bigint): void {
    const account = this.accounts.get(accountKey);
    if (!account) return;
    account.reservedMicrousd =
      account.reservedMicrousd > reservedMicrousd
        ? account.reservedMicrousd - reservedMicrousd
        : 0n;
    account.settledMicrousd += actualMicrousd;
  }

  settle(accountKey: string, reservedCents: number, actualCents: number): void {
    this.settleMicrousd(accountKey, centsToMicro(reservedCents), centsToMicro(actualCents));
  }

  remainingMicrousd(accountKey: string): bigint | null {
    const account = this.accounts.get(accountKey);
    return account ? account.capMicrousd - account.reservedMicrousd - account.settledMicrousd : null;
  }

  remainingCents(accountKey: string): number {
    const remaining = this.remainingMicrousd(accountKey);
    return remaining !== null ? Number(remaining) / Number(MICROUSD_PER_CENT) : Number.POSITIVE_INFINITY;
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

/** Structural BudgetStore adapter for isolated unit tests only. */
export class InMemoryBudgetStoreAdapter {
  constructor(readonly ledger = new BudgetLedger()) {}

  async open(): Promise<never> { throw new Error('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'); }
  async attestAuthorized(): Promise<never> { throw new Error('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'); }

  async reserve(input: {
    workspaceId: string;
    accountKey: string;
    operationKey: string;
    estimatedMicrousd: bigint;
  }) {
    const reservedMicrousd = this.ledger.reserveMicrousd(
      input.accountKey,
      input.estimatedMicrousd,
    );
    return {
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: input.operationKey,
      estimatedMicrousd: reservedMicrousd,
      replay: false,
    };
  }

  async settle(reservation: {
    accountKey: string;
    estimatedMicrousd: bigint;
  }, observedMicrousd: bigint) {
    this.ledger.settleMicrousd(
      reservation.accountKey,
      reservation.estimatedMicrousd,
      observedMicrousd,
    );
    return {
      chargedMicrousd: observedMicrousd,
      observedMicrousd,
      capVariance: observedMicrousd > reservation.estimatedMicrousd,
      replay: false,
    };
  }

  async release(reservation: { accountKey: string; estimatedMicrousd: bigint }) {
    this.ledger.settleMicrousd(
      reservation.accountKey,
      reservation.estimatedMicrousd,
      0n,
    );
    return {
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      capVariance: false,
      replay: false,
    };
  }

  async status(input: { accountKey: string }) {
    const remaining = this.ledger.remainingMicrousd(input.accountKey);
    return {
      remainingMicrousd: remaining ?? 0n,
      exhausted: this.ledger.wasExhausted(input.accountKey),
      open: remaining !== null,
    };
  }

  async close(input: { accountKey: string; force?: boolean }): Promise<void> {
    this.ledger.close(input.accountKey, input.force);
  }

  async markResultUnknown(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
  async loadResultUnknownArtifact(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
  async settleArtifactManifest(): Promise<never> { throw new Error('BUDGET_STORE_UNAVAILABLE'); }
}
