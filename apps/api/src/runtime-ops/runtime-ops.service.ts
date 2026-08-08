import { createHash } from 'node:crypto';
import type { ScheduleDriftReceiptInput } from '../temporal/schedule-governance';
import { WORKER_DOMAINS } from '../temporal/worker-topology';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MACHINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const MACHINE_STAGE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const MACHINE_FIELD = /^[a-z][a-zA-Z0-9_.:-]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STAT_KEY = /^[a-z][a-zA-Z0-9_]{0,47}$/;
const POSTGRES_INT_MAX = 2_147_483_647;
const TASK_QUEUES = new Set(WORKER_DOMAINS.map((domain) => domain.taskQueue));

export type WorkflowReceiptPhase = 'STARTED' | 'COMPLETED' | 'FAILED';

export interface WorkflowRunReceiptInput {
  workspaceId: string | null;
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string;
  phase: WorkflowReceiptPhase;
  stage: string;
  stats: Record<string, unknown>;
  errorCode: string | null;
  budgetTruncated: boolean;
  retryAttempt: number;
}

export interface WorkerHeartbeatInput {
  workerInstanceId: string;
  taskQueue: string;
  status: 'POLLING' | 'STOPPING';
  observedAt: Date;
  activityConcurrency: number;
  workflowConcurrency: number;
}

function assertNullableCounter(value: number | null): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INT_MAX)
  ) {
    invalidReceipt();
  }
}

interface RuntimeOpsDb {
  workflowRunReceipt: {
    create(input: { data: Record<string, unknown> }): Promise<unknown>;
  };
  workerHeartbeat: {
    upsert(input: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  scheduleDriftReceipt: {
    create(input: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface WorkerBuildIdentity {
  buildSha: string;
}

export function buildWorkerIdentityFromAttestation(
  deploymentStage: 'development' | 'pilot' | 'production',
  identity:
    | { readonly status: 'VERIFIED'; readonly buildSha: string }
    | { readonly status: 'UNVERIFIED'; readonly buildSha: string | null },
): WorkerBuildIdentity {
  if (identity.status === 'VERIFIED' && BUILD_SHA.test(identity.buildSha)) {
    return { buildSha: identity.buildSha };
  }
  if (deploymentStage === 'development') {
    return { buildSha: 'development-unattested' };
  }
  throw new Error('WORKER_BUILD_ATTESTATION_REQUIRED');
}

function invalidReceipt(): never {
  throw new Error('INVALID_RUNTIME_RECEIPT');
}

function assertMachineId(value: string): void {
  if (!MACHINE_ID.test(value) || value.includes('@')) invalidReceipt();
}

function assertPositiveBoundedInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) invalidReceipt();
}

export function sanitizeRuntimeStats(
  input: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error('INVALID_RUNTIME_STATS');
  const output: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (
      !STAT_KEY.test(key) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('INVALID_RUNTIME_STATS');
    }
    output[key] = value;
  }
  return output;
}

export function buildWorkerIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerBuildIdentity {
  const inferred = env.NODE_ENV === 'production' ? 'production' : 'development';
  const stage = env.DEPLOYMENT_STAGE ?? inferred;
  if (!['development', 'pilot', 'production'].includes(stage)) {
    throw new Error('WORKER_BUILD_IDENTITY_REQUIRED');
  }
  const sha = env.BUILD_SHA?.toLowerCase();
  if (sha && BUILD_SHA.test(sha)) return { buildSha: sha };
  if (stage === 'development') return { buildSha: 'development-unattested' };
  throw new Error('WORKER_BUILD_IDENTITY_REQUIRED');
}

function receiptKey(input: WorkflowRunReceiptInput): string {
  return createHash('sha256')
    .update(
      [input.runId, String(input.retryAttempt), input.phase, input.stage].join('|'),
    )
    .digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export class RuntimeOpsWriter {
  constructor(
    private readonly db: RuntimeOpsDb,
    private readonly identity: WorkerBuildIdentity,
  ) {
    if (
      this.identity.buildSha !== 'development-unattested' &&
      !BUILD_SHA.test(this.identity.buildSha)
    ) {
      throw new Error('WORKER_BUILD_IDENTITY_REQUIRED');
    }
  }

  async appendWorkflowReceipt(input: WorkflowRunReceiptInput): Promise<void> {
    if (input.workspaceId !== null && !UUID.test(input.workspaceId)) invalidReceipt();
    if (!UUID.test(input.runId)) invalidReceipt();
    assertMachineId(input.workflowId);
    assertMachineId(input.workflowType);
    if (!TASK_QUEUES.has(input.taskQueue)) invalidReceipt();
    if (!['STARTED', 'COMPLETED', 'FAILED'].includes(input.phase)) invalidReceipt();
    if (!MACHINE_STAGE.test(input.stage)) invalidReceipt();
    if (input.errorCode !== null && !ERROR_CODE.test(input.errorCode)) invalidReceipt();
    if (
      !Number.isSafeInteger(input.retryAttempt) ||
      input.retryAttempt < 1 ||
      input.retryAttempt > POSTGRES_INT_MAX
    ) {
      invalidReceipt();
    }
    const stats = sanitizeRuntimeStats(input.stats);
    try {
      await this.db.workflowRunReceipt.create({
        data: {
          receiptKey: receiptKey(input),
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          runId: input.runId,
          workflowType: input.workflowType,
          taskQueue: input.taskQueue,
          workerBuildSha: this.identity.buildSha,
          phase: input.phase,
          stage: input.stage,
          stats,
          errorCode: input.errorCode,
          budgetTruncated: input.budgetTruncated,
          retryAttempt: input.retryAttempt,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async recordWorkerHeartbeat(input: WorkerHeartbeatInput): Promise<void> {
    if (!UUID.test(input.workerInstanceId)) invalidReceipt();
    if (!TASK_QUEUES.has(input.taskQueue)) invalidReceipt();
    if (!['POLLING', 'STOPPING'].includes(input.status)) invalidReceipt();
    if (!(input.observedAt instanceof Date) || !Number.isFinite(input.observedAt.getTime())) {
      invalidReceipt();
    }
    assertPositiveBoundedInteger(input.activityConcurrency);
    assertPositiveBoundedInteger(input.workflowConcurrency);
    const identity = {
      workerInstanceId: input.workerInstanceId,
      taskQueue: input.taskQueue,
    };
    const state = {
      workerBuildSha: this.identity.buildSha,
      status: input.status,
      lastSeenAt: input.observedAt,
      activityConcurrency: input.activityConcurrency,
      workflowConcurrency: input.workflowConcurrency,
    };
    await this.db.workerHeartbeat.upsert({
      where: { workerInstanceId_taskQueue: identity },
      create: { ...identity, ...state },
      update: state,
    });
  }

  async appendScheduleDriftReceipt(input: ScheduleDriftReceiptInput): Promise<void> {
    assertMachineId(input.scheduleId);
    if (!['CREATED', 'IN_SYNC', 'RECONCILED', 'FAILED'].includes(input.disposition)) {
      invalidReceipt();
    }
    if (!/^[a-f0-9]{64}$/.test(input.desiredHash)) invalidReceipt();
    if (input.observedHash !== null && !/^[a-f0-9]{64}$/.test(input.observedHash)) {
      invalidReceipt();
    }
    if (input.changedFields.length > 8 || input.changedFields.some((field) => !MACHINE_FIELD.test(field))) {
      invalidReceipt();
    }
    if (input.errorCode !== null && !ERROR_CODE.test(input.errorCode)) invalidReceipt();
    if (input.paused !== null && typeof input.paused !== 'boolean') invalidReceipt();
    if (
      input.nextActionAt !== null &&
      (!(input.nextActionAt instanceof Date) ||
        !Number.isFinite(input.nextActionAt.getTime()))
    ) {
      invalidReceipt();
    }
    assertNullableCounter(input.missedCatchupCount);
    assertNullableCounter(input.skippedOverlapCount);
    await this.db.scheduleDriftReceipt.create({
      data: {
        scheduleId: input.scheduleId,
        disposition: input.disposition,
        desiredHash: input.desiredHash,
        observedHash: input.observedHash,
        changedFields: input.changedFields,
        errorCode: input.errorCode,
        paused: input.paused,
        nextActionAt: input.nextActionAt,
        missedCatchupCount: input.missedCatchupCount,
        skippedOverlapCount: input.skippedOverlapCount,
        workerBuildSha: this.identity.buildSha,
      },
    });
  }
}
