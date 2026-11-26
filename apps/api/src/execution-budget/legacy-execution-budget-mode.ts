import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CAPPED_DISCOVERY_FIT_COMPANIES,
  MAX_CONTACT_DISCOVERY_COMPANIES,
  MAX_DISCOVERY_ENRICH_COMPANIES,
  MAX_DISCOVERY_PLAN_QUERIES,
  MAX_DISCOVERY_PROFILE_COMPANIES,
  MAX_EMAIL_GUESS_CONTACTS,
  MAX_ENRICH_CONTACTS_PER_REQUEST,
} from '../discovery/execution-envelope';
import {
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
} from './execution-budget-authority.types';
import {
  BudgetStoreUnavailableError,
  PostgresBudgetStore,
  type BudgetAccountAuthorization,
  type BudgetDomainAckRequest,
  type BudgetReservation,
  type BudgetReservationRequest,
  type BudgetResultUnknownTransition,
  type BudgetSettlement,
  type BudgetStatus,
  type BudgetStore,
} from '../tools/budget-store';
import type {
  BudgetOperationResultQuery,
  BudgetOperationResultReadback,
} from '../tools/budget-operation-result';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';
import type { DurableExecutionReceiptFacts } from '../durable-results/durable-execution-receipt';
import type { GenericOperationArtifactSnapshot } from '../tools/artifact-budget-expected-facts';
import type { GenericOperationArtifactSubjectRef } from '../durable-results/artifact/generic-operation-artifact-subject.repository';
import { assertMicrousd } from '../tools/microusd';

export const LEGACY_EXECUTION_BUDGET_MODE_ENV =
  'LEGACY_EXECUTION_BUDGET_MODE' as const;

export type LegacyExecutionBudgetMode = 'enforce' | 'bypass';

/**
 * Pure technical sentinel used in bypass mode only to satisfy structural
 * positive-cap checks in downstream callers (never a customer balance or price).
 */
export const BYPASS_TECHNICAL_CAP_MICROUSD = 10_000_000_000n;

/**
 * Pure technical cap matching `GENERATION_LOGICAL_CAP_MICROUSD` so market
 * candidate generation's fixed structural assertion stays satisfied in bypass mode.
 */
export const BYPASS_MARKET_GENERATION_CAP_MICROUSD = 800_000n;

/**
 * Pure stateless single-task technical hard limits enforced in bypass mode.
 * These protect upstream providers and host stability against runaway loops
 * without RS256 grant verification or legacy budget-ledger DB writes.
 */
export const STATELESS_TASK_HARD_LIMITS = Object.freeze({
  maxPlanQueries: MAX_DISCOVERY_PLAN_QUERIES,
  maxDiscoveryCompanies: CAPPED_DISCOVERY_FIT_COMPANIES,
  maxProfileCompanies: MAX_DISCOVERY_PROFILE_COMPANIES,
  maxEnrichCompanies: MAX_DISCOVERY_ENRICH_COMPANIES,
  maxContactsPerRequest: MAX_ENRICH_CONTACTS_PER_REQUEST,
  maxContactDiscoveryCompanies: MAX_CONTACT_DISCOVERY_COMPANIES,
  maxEmailGuessContacts: MAX_EMAIL_GUESS_CONTACTS,
  maxModelOutputTokens: 32_768,
  defaultModelTimeoutMs: 120_000,
  defaultToolTimeoutMs: 60_000,
  maxToolCallsPerTask: 2_000,
  maxModelCallsPerTask: 1_000,
  maxOperationsPerAccount: 3_000,
} as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 200;
const MAX_TRACKED_ACCOUNTS = 2_048;

export class TechnicalTaskLimitExceededError extends Error {
  readonly code = 'TECHNICAL_TASK_LIMIT_EXCEEDED' as const;

  constructor(
    public readonly limitName: string,
    public readonly observed: number,
    public readonly maximum: number,
  ) {
    super(
      `technical task limit exceeded (${limitName}): observed ${observed} > max ${maximum}`,
    );
    this.name = 'TechnicalTaskLimitExceededError';
  }
}

/**
 * Resolves `LEGACY_EXECUTION_BUDGET_MODE` (`enforce` | `bypass`).
 * Defaults to `enforce` and fails closed to `enforce` on any unrecognized value
 * so deployments without wallet cutover remain 100% compatible.
 */
export function resolveLegacyExecutionBudgetMode(
  env: NodeJS.ProcessEnv = process.env,
): LegacyExecutionBudgetMode {
  const raw = env[LEGACY_EXECUTION_BUDGET_MODE_ENV]?.trim().toLowerCase();
  return raw === 'bypass' ? 'bypass' : 'enforce';
}

export function isLegacyExecutionBudgetBypass(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveLegacyExecutionBudgetMode(env) === 'bypass';
}

export function bypassTechnicalCapMicrousdForPurpose(
  purpose: ExecutionBudgetPurpose,
): bigint {
  return purpose === 'market.candidates.generate'
    ? BYPASS_MARKET_GENERATION_CAP_MICROUSD
    : BYPASS_TECHNICAL_CAP_MICROUSD;
}

export function assertStatelessModelCallLimits(input: {
  readonly taskId: string;
  readonly maxTokens?: number;
  readonly taskMaxOutputTokens?: number;
}): void {
  const hardMaximum =
    input.taskMaxOutputTokens !== undefined &&
    Number.isSafeInteger(input.taskMaxOutputTokens) &&
    input.taskMaxOutputTokens > 0
      ? Math.min(
          input.taskMaxOutputTokens,
          STATELESS_TASK_HARD_LIMITS.maxModelOutputTokens,
        )
      : STATELESS_TASK_HARD_LIMITS.maxModelOutputTokens;
  if (
    input.maxTokens !== undefined &&
    (!Number.isSafeInteger(input.maxTokens) ||
      input.maxTokens < 1 ||
      input.maxTokens > hardMaximum)
  ) {
    throw new TechnicalTaskLimitExceededError(
      `model.maxTokens(${input.taskId})`,
      input.maxTokens,
      hardMaximum,
    );
  }
}

export function assertStatelessTaskCallBudget(
  kind: 'tool' | 'model',
  observedCount: number,
  maximum?: number,
): void {
  const limit =
    maximum ??
    (kind === 'tool'
      ? STATELESS_TASK_HARD_LIMITS.maxToolCallsPerTask
      : STATELESS_TASK_HARD_LIMITS.maxModelCallsPerTask);
  if (observedCount > limit) {
    throw new TechnicalTaskLimitExceededError(
      `${kind}.callsPerTask`,
      observedCount,
      limit,
    );
  }
}

function assertBoundedPrintable(name: string, value: string): void {
  if (
    !value ||
    value.length > MAX_KEY_LENGTH ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(
      `${name} must be 1-${MAX_KEY_LENGTH} printable characters`,
    );
  }
}

function assertWorkspaceScopeOnly(scopeKey: string): void {
  if (scopeKey === 'platform' || !UUID_PATTERN.test(scopeKey)) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  }
}

function assertAuthorityUuid(authorityId: string): void {
  if (!UUID_PATTERN.test(authorityId)) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }
}

/**
 * Stateless, zero-DB-write `BudgetStore` used only for workspace executions when
 * `LEGACY_EXECUTION_BUDGET_MODE=bypass`. Never writes to `ExecutionBudgetAuthority`,
 * `ToolBudgetAccount`, or `ToolBudgetOperation`, never emits `409 GRANT_REUSED`,
 * and refuses `platform` scope so platform schedules stay governed separately.
 */
export class StatelessTechnicalBudgetStore implements BudgetStore {
  private readonly operationCounts = new Map<string, number>();
  private readonly maxOperationsPerAccount: number;

  constructor(options?: { readonly maxOperationsPerAccount?: number }) {
    this.maxOperationsPerAccount =
      options?.maxOperationsPerAccount ??
      STATELESS_TASK_HARD_LIMITS.maxOperationsPerAccount;
  }

  private counterKey(workspaceId: string, accountKey: string): string {
    return `${workspaceId}\0${accountKey}`;
  }

  private incrementAccountOperations(
    workspaceId: string,
    accountKey: string,
  ): void {
    const key = this.counterKey(workspaceId, accountKey);
    const next = (this.operationCounts.get(key) ?? 0) + 1;
    if (next > this.maxOperationsPerAccount) {
      throw new TechnicalTaskLimitExceededError(
        'account.operationsPerTask',
        next,
        this.maxOperationsPerAccount,
      );
    }
    if (
      !this.operationCounts.has(key) &&
      this.operationCounts.size >= MAX_TRACKED_ACCOUNTS
    ) {
      const oldest = this.operationCounts.keys().next().value;
      if (oldest !== undefined) this.operationCounts.delete(oldest);
    }
    this.operationCounts.set(key, next);
  }

  async open(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
    replayScope?: boolean;
  }): Promise<BudgetAccountAuthorization> {
    assertWorkspaceScopeOnly(input.scopeKey);
    assertAuthorityUuid(input.authorityId);
    assertBoundedPrintable('accountKey', input.accountKey);
    return Object.freeze({
      accountId: randomUUID(),
      authorityId: input.authorityId,
      authorizedCapMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
      generation: 1,
    });
  }

  async attestAuthorized(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
  }): Promise<BudgetAccountAuthorization> {
    assertWorkspaceScopeOnly(input.scopeKey);
    assertAuthorityUuid(input.authorityId);
    assertBoundedPrintable('accountKey', input.accountKey);
    return Object.freeze({
      accountId: randomUUID(),
      authorityId: input.authorityId,
      authorizedCapMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
      generation: 1,
    });
  }

  async reserve(input: BudgetReservationRequest): Promise<BudgetReservation> {
    if (input.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    assertBoundedPrintable('accountKey', input.accountKey);
    assertBoundedPrintable('operationKey', input.operationKey);
    assertMicrousd('estimatedMicrousd', input.estimatedMicrousd);
    this.incrementAccountOperations(input.workspaceId, input.accountKey);
    return Object.freeze({
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: randomUUID(),
      estimatedMicrousd: input.estimatedMicrousd,
      replay: false,
    });
  }

  async settle(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
  ): Promise<BudgetSettlement> {
    if (reservation.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    assertMicrousd('observedMicrousd', observedMicrousd);
    return Object.freeze({
      chargedMicrousd: observedMicrousd,
      observedMicrousd,
      capVariance: false,
      replay: false,
    });
  }

  async markResultUnknown(
    reservation: BudgetReservation,
  ): Promise<BudgetResultUnknownTransition> {
    if (reservation.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    return Object.freeze({
      reservedMicrousd: reservation.estimatedMicrousd,
      replay: false,
    });
  }

  async loadResultUnknownArtifact(
    reservation: BudgetReservation,
  ): Promise<null> {
    if (reservation.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    return null;
  }

  async settleArtifactManifest(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
  ): Promise<BudgetSettlement> {
    if (reservation.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    assertMicrousd('observedMicrousd', observedMicrousd);
    return Object.freeze({
      chargedMicrousd: observedMicrousd,
      observedMicrousd,
      capVariance: false,
      replay: false,
    });
  }

  async release(reservation: BudgetReservation): Promise<BudgetSettlement> {
    if (reservation.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    return Object.freeze({
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      capVariance: false,
      replay: false,
    });
  }

  async status(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<BudgetStatus> {
    if (input.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    assertBoundedPrintable('accountKey', input.accountKey);
    return Object.freeze({
      remainingMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
      exhausted: false,
      open: true,
    });
  }

  async close(input: {
    workspaceId: string;
    accountKey: string;
    force?: boolean;
  }): Promise<void> {
    if (input.workspaceId === 'platform') {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    }
    assertBoundedPrintable('accountKey', input.accountKey);
    this.operationCounts.delete(
      this.counterKey(input.workspaceId, input.accountKey),
    );
  }
}

/**
 * Scope-routed composite `BudgetStore` used when `LEGACY_EXECUTION_BUDGET_MODE=bypass`:
 * - `platform` scope (`scopeKey === 'platform'` / `workspaceId === 'platform'`) delegates
 *   every lifecycle operation to the durable `platformStore` (`PostgresBudgetStore` or
 *   `UnavailableBudgetStore`), keeping platform schedules and egress fences intact.
 * - Tenant workspace scopes delegate to `StatelessTechnicalBudgetStore` with zero DB writes.
 */
export class ScopeRoutedBypassBudgetStore implements BudgetStore {
  constructor(
    private readonly platformStore: BudgetStore,
    private readonly workspaceStore: BudgetStore = new StatelessTechnicalBudgetStore(),
  ) {}

  private targetForScope(scopeKey: string): BudgetStore {
    return scopeKey === 'platform' ? this.platformStore : this.workspaceStore;
  }

  async readOperationResult(
    query: BudgetOperationResultQuery,
  ): Promise<BudgetOperationResultReadback> {
    if (!this.platformStore.readOperationResult) {
      throw new BudgetStoreUnavailableError(
        'ScopeRoutedBypassBudgetStore platform store does not expose readOperationResult',
      );
    }
    return this.platformStore.readOperationResult(query);
  }

  open(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
    replayScope?: boolean;
  }): Promise<BudgetAccountAuthorization> {
    return this.targetForScope(input.scopeKey).open(input);
  }

  attestAuthorized(input: {
    authorityId: string;
    scopeKey: string;
    accountKey: string;
  }): Promise<BudgetAccountAuthorization> {
    return this.targetForScope(input.scopeKey).attestAuthorized(input);
  }

  reserve(input: BudgetReservationRequest): Promise<BudgetReservation> {
    return this.targetForScope(input.workspaceId).reserve(input);
  }

  settle(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    projection?: GenericOperationProjection,
    receiptFacts?: DurableExecutionReceiptFacts,
  ): Promise<BudgetSettlement> {
    return this.targetForScope(reservation.workspaceId).settle(
      reservation,
      observedMicrousd,
      projection,
      receiptFacts,
    );
  }

  markResultUnknown(
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<BudgetResultUnknownTransition> {
    return this.targetForScope(reservation.workspaceId).markResultUnknown(
      reservation,
      expected,
      subjectRef,
    );
  }

  loadResultUnknownArtifact(
    reservation: BudgetReservation,
    authorityId: string,
    subjectRef?: GenericOperationArtifactSubjectRef,
  ): Promise<GenericOperationArtifactSnapshot | null> {
    return this.targetForScope(
      reservation.workspaceId,
    ).loadResultUnknownArtifact(reservation, authorityId, subjectRef);
  }

  settleArtifactManifest(
    reservation: BudgetReservation,
    observedMicrousd: bigint,
    snapshot: GenericOperationArtifactSnapshot,
    receiptFacts: DurableExecutionReceiptFacts,
    domainAck: BudgetDomainAckRequest,
    subjectRef?: GenericOperationArtifactSubjectRef,
    objectVersionId?: string,
  ): Promise<BudgetSettlement> {
    return this.targetForScope(reservation.workspaceId).settleArtifactManifest(
      reservation,
      observedMicrousd,
      snapshot,
      receiptFacts,
      domainAck,
      subjectRef,
      objectVersionId,
    );
  }

  release(reservation: BudgetReservation): Promise<BudgetSettlement> {
    return this.targetForScope(reservation.workspaceId).release(reservation);
  }

  status(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<BudgetStatus> {
    return this.targetForScope(input.workspaceId).status(input);
  }

  close(input: {
    workspaceId: string;
    accountKey: string;
    force?: boolean;
  }): Promise<void> {
    return this.targetForScope(input.workspaceId).close(input);
  }
}

/**
 * Selects the workspace `BudgetStore` according to `LEGACY_EXECUTION_BUDGET_MODE`:
 * - `enforce` (default): `PostgresBudgetStore` (full legacy ledger behavior)
 * - `bypass`: `ScopeRoutedBypassBudgetStore` (`platform` -> `PostgresBudgetStore`,
 *   tenant workspace UUIDs -> `StatelessTechnicalBudgetStore` with zero DB writes)
 */
export function createWorkspaceBudgetStore(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv = process.env,
): BudgetStore {
  const durableStore = new PostgresBudgetStore(prisma);
  return isLegacyExecutionBudgetBypass(env)
    ? new ScopeRoutedBypassBudgetStore(durableStore)
    : durableStore;
}
