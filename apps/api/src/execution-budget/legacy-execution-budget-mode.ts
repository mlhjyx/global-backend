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
  PostgresBudgetStore,
  type BudgetAccountAuthorization,
  type BudgetReservation,
  type BudgetReservationRequest,
  type BudgetResultUnknownTransition,
  type BudgetSettlement,
  type BudgetStatus,
  type BudgetStore,
} from '../tools/budget-store';
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
    _reservation: BudgetReservation,
    observedMicrousd: bigint,
  ): Promise<BudgetSettlement> {
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
    return Object.freeze({
      reservedMicrousd: reservation.estimatedMicrousd,
      replay: false,
    });
  }

  async loadResultUnknownArtifact(): Promise<null> {
    return null;
  }

  async settleArtifactManifest(
    _reservation: BudgetReservation,
    observedMicrousd: bigint,
  ): Promise<BudgetSettlement> {
    assertMicrousd('observedMicrousd', observedMicrousd);
    return Object.freeze({
      chargedMicrousd: observedMicrousd,
      observedMicrousd,
      capVariance: false,
      replay: false,
    });
  }

  async release(): Promise<BudgetSettlement> {
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
    assertBoundedPrintable('accountKey', input.accountKey);
    this.operationCounts.delete(
      this.counterKey(input.workspaceId, input.accountKey),
    );
  }
}

/**
 * Selects the workspace `BudgetStore` according to `LEGACY_EXECUTION_BUDGET_MODE`:
 * - `enforce` (default): `PostgresBudgetStore` (full legacy ledger behavior)
 * - `bypass`: `StatelessTechnicalBudgetStore` (zero DB budget-table writes)
 */
export function createWorkspaceBudgetStore(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv = process.env,
): BudgetStore {
  return isLegacyExecutionBudgetBypass(env)
    ? new StatelessTechnicalBudgetStore()
    : new PostgresBudgetStore(prisma);
}
