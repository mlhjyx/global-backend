import { createHash } from 'node:crypto';
import {
  Client,
  Connection,
  ScheduleOverlapPolicy,
  type ScheduleDescription,
  type ScheduleOptions,
  type ScheduleSpec,
  type ScheduleUpdateOptions,
} from '@temporalio/client';
import {
  ACQ_SWEEP_SCHEDULE_ID,
  ACQUISITION_SWEEP_WORKFLOW,
  BACKLOG_SWEEP_SCHEDULE_ID,
  BACKLOG_SWEEP_WORKFLOW,
  EXTERNAL_INTENT_SWEEP_SCHEDULE_ID,
  EXTERNAL_INTENT_SWEEP_WORKFLOW,
  INTENT_SWEEP_SCHEDULE_ID,
  INTENT_SWEEP_WORKFLOW,
  KB_RECOVERY_SWEEP_SCHEDULE_ID,
  KB_RECOVERY_SWEEP_WORKFLOW,
  PATENTS_CACHE_REFRESH_SCHEDULE_ID,
  PATENTS_CACHE_REFRESH_WORKFLOW,
  SANCTIONS_REFRESH_SCHEDULE_ID,
  SANCTIONS_REFRESH_WORKFLOW,
  SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID,
  SITE_RELEASE_MAINTENANCE_SWEEP_WORKFLOW,
} from './understanding.constants';
import { taskQueueForWorkflow } from './worker-topology';

const SCHEDULE_SCHEMA_VERSION = 1;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Duration = NonNullable<ScheduleSpec['intervals']>[number]['every'];

export interface ScheduleCodeContract {
  id: string;
  workflowType: string;
  taskQueue: string;
  args: readonly [Readonly<Record<string, unknown>>];
  workflowExecutionTimeoutMs: number;
  schemaVersion: number;
  cadenceEnv: string;
  defaultCadence: string;
}

function schedule(
  id: string,
  workflowType: string,
  cadenceEnv: string,
  defaultCadence: string,
  workflowExecutionTimeoutMs: number,
  args: Record<string, unknown> = {},
): ScheduleCodeContract {
  return Object.freeze({
    id,
    workflowType,
    taskQueue: taskQueueForWorkflow(workflowType),
    args: Object.freeze([
      Object.freeze({
        ...args,
        runtimeContract: Object.freeze({ scheduleSchemaVersion: SCHEDULE_SCHEMA_VERSION }),
      }),
    ]) as readonly [Readonly<Record<string, unknown>>],
    workflowExecutionTimeoutMs,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    cadenceEnv,
    defaultCadence,
  });
}

export const PLATFORM_SCHEDULES: readonly ScheduleCodeContract[] = Object.freeze([
  schedule(ACQ_SWEEP_SCHEDULE_ID, ACQUISITION_SWEEP_WORKFLOW, 'ACQ_SWEEP_EVERY', '10m', 30 * MINUTE),
  schedule(INTENT_SWEEP_SCHEDULE_ID, INTENT_SWEEP_WORKFLOW, 'INTENT_SWEEP_EVERY', '1h', 2 * HOUR),
  schedule(BACKLOG_SWEEP_SCHEDULE_ID, BACKLOG_SWEEP_WORKFLOW, 'BACKLOG_SWEEP_EVERY', '24h', 4 * HOUR),
  schedule(
    EXTERNAL_INTENT_SWEEP_SCHEDULE_ID,
    EXTERNAL_INTENT_SWEEP_WORKFLOW,
    'EXTERNAL_INTENT_SWEEP_EVERY',
    '6h',
    2 * HOUR,
  ),
  schedule(
    PATENTS_CACHE_REFRESH_SCHEDULE_ID,
    PATENTS_CACHE_REFRESH_WORKFLOW,
    'PATENT_CACHE_REFRESH_EVERY',
    '7d',
    2 * HOUR,
  ),
  schedule(
    SANCTIONS_REFRESH_SCHEDULE_ID,
    SANCTIONS_REFRESH_WORKFLOW,
    'SANCTIONS_REFRESH_EVERY',
    '24h',
    HOUR,
  ),
  schedule(
    KB_RECOVERY_SWEEP_SCHEDULE_ID,
    KB_RECOVERY_SWEEP_WORKFLOW,
    'KB_RECOVERY_SWEEP_EVERY',
    '5m',
    22 * MINUTE,
    { limit: 10 },
  ),
  schedule(
    SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID,
    SITE_RELEASE_MAINTENANCE_SWEEP_WORKFLOW,
    'SITE_RELEASE_MAINTENANCE_SWEEP_EVERY',
    '24h',
    2 * HOUR,
  ),
]);

interface CodeShape {
  workflowType: string;
  taskQueue: string;
  args: readonly unknown[];
  workflowExecutionTimeoutMs: number | null;
  schemaVersion: number | null;
  overlapPolicy: ScheduleOverlapPolicy | null;
  catchupWindowMs: number | null;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function desiredCodeShape(contract: ScheduleCodeContract): CodeShape {
  return {
    workflowType: contract.workflowType,
    taskQueue: contract.taskQueue,
    args: contract.args,
    workflowExecutionTimeoutMs: contract.workflowExecutionTimeoutMs,
    schemaVersion: contract.schemaVersion,
    overlapPolicy: ScheduleOverlapPolicy.SKIP,
    catchupWindowMs: MINUTE,
  };
}

function observedSchemaVersion(args: readonly unknown[]): number | null {
  const first = args[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const runtimeContract = (first as Record<string, unknown>).runtimeContract;
  if (!runtimeContract || typeof runtimeContract !== 'object' || Array.isArray(runtimeContract)) {
    return null;
  }
  const version = (runtimeContract as Record<string, unknown>).scheduleSchemaVersion;
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
}

function observedCodeShape(description: ScheduleDescription): CodeShape {
  const args = description.action.args ?? [];
  return {
    workflowType: description.action.workflowType,
    taskQueue: description.action.taskQueue,
    args,
    workflowExecutionTimeoutMs:
      typeof description.action.workflowExecutionTimeout === 'number'
        ? description.action.workflowExecutionTimeout
        : null,
    schemaVersion: observedSchemaVersion(args),
    overlapPolicy: description.policies.overlap ?? null,
    catchupWindowMs:
      typeof description.policies.catchupWindow === 'number'
        ? description.policies.catchupWindow
        : null,
  };
}

export function scheduleCodeHash(contract: ScheduleCodeContract): string {
  return createHash('sha256').update(stableJson(desiredCodeShape(contract))).digest('hex');
}

function observedCodeHash(description: ScheduleDescription): string {
  return createHash('sha256').update(stableJson(observedCodeShape(description))).digest('hex');
}

type ChangedField =
  | 'workflowType'
  | 'taskQueue'
  | 'args'
  | 'workflowExecutionTimeout'
  | 'schemaVersion'
  | 'overlapPolicy'
  | 'catchupWindow';

function changedCodeFields(
  contract: ScheduleCodeContract,
  description: ScheduleDescription,
): ChangedField[] {
  const desired = desiredCodeShape(contract);
  const observed = observedCodeShape(description);
  const changed: ChangedField[] = [];
  if (desired.workflowType !== observed.workflowType) changed.push('workflowType');
  if (desired.taskQueue !== observed.taskQueue) changed.push('taskQueue');
  if (stableJson(desired.args) !== stableJson(observed.args)) changed.push('args');
  if (desired.workflowExecutionTimeoutMs !== observed.workflowExecutionTimeoutMs) {
    changed.push('workflowExecutionTimeout');
  }
  if (desired.schemaVersion !== observed.schemaVersion) changed.push('schemaVersion');
  if (desired.overlapPolicy !== observed.overlapPolicy) changed.push('overlapPolicy');
  if (desired.catchupWindowMs !== observed.catchupWindowMs) {
    changed.push('catchupWindow');
  }
  return changed;
}

export function desiredScheduleOptions(
  contract: ScheduleCodeContract,
  env: Readonly<Record<string, string | undefined>>,
): ScheduleOptions {
  const cadence = scheduleCadence(env[contract.cadenceEnv] ?? contract.defaultCadence);
  return {
    scheduleId: contract.id,
    spec: {
      intervals: [
        { every: cadence },
      ],
    },
    action: {
      type: 'startWorkflow',
      workflowType: contract.workflowType,
      taskQueue: contract.taskQueue,
      args: contract.args,
      workflowExecutionTimeout: contract.workflowExecutionTimeoutMs,
    },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: MINUTE },
  };
}

function scheduleCadence(raw: string): Duration {
  const match = raw.match(/^([1-9][0-9]{0,8})(ms|s|m|h|d)$/);
  if (!match) throw new Error('INVALID_SCHEDULE_CADENCE');
  const amount = Number(match[1]);
  const multiplier =
    match[2] === 'ms'
      ? 1
      : match[2] === 's'
        ? 1_000
        : match[2] === 'm'
          ? MINUTE
          : match[2] === 'h'
            ? HOUR
            : 24 * HOUR;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 365 * 24 * HOUR) {
    throw new Error('INVALID_SCHEDULE_CADENCE');
  }
  return raw as Duration;
}

export interface ScheduleDriftReceiptInput {
  scheduleId: string;
  disposition: 'CREATED' | 'IN_SYNC' | 'RECONCILED' | 'FAILED';
  desiredHash: string;
  observedHash: string | null;
  changedFields: string[];
  errorCode: string | null;
  paused: boolean | null;
  nextActionAt: Date | null;
  missedCatchupCount: number | null;
  skippedOverlapCount: number | null;
}

export interface ScheduleDriftReceiptPort {
  append(input: ScheduleDriftReceiptInput): Promise<void>;
}

interface ScheduleHandleLike {
  describe(): Promise<ScheduleDescription>;
  update(
    updateFn: (previous: ScheduleDescription) => ScheduleUpdateOptions,
  ): Promise<void>;
}

interface ScheduleClientLike {
  schedule: {
    getHandle(id: string): ScheduleHandleLike;
    create(options: ScheduleOptions): Promise<unknown>;
  };
}

function isScheduleMissing(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'ScheduleNotFoundError' || name === 'ScheduleNotFound';
}

function isScheduleAlreadyRunning(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'ScheduleAlreadyRunning' || name === 'ScheduleAlreadyRunningError';
}

async function appendFailed(
  receipts: ScheduleDriftReceiptPort,
  contract: ScheduleCodeContract,
  observedHash: string | null,
  changedFields: string[],
  errorCode = 'SCHEDULE_RECONCILE_FAILED',
  description?: ScheduleDescription,
): Promise<void> {
  await receipts.append({
    scheduleId: contract.id,
    disposition: 'FAILED',
    desiredHash: scheduleCodeHash(contract),
    observedHash,
    changedFields,
    errorCode,
    ...scheduleRuntimeObservation(description),
  });
}

function boundedCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function scheduleRuntimeObservation(
  description?: ScheduleDescription,
): Pick<
  ScheduleDriftReceiptInput,
  | 'paused'
  | 'nextActionAt'
  | 'missedCatchupCount'
  | 'skippedOverlapCount'
> {
  if (!description) {
    return {
      paused: null,
      nextActionAt: null,
      missedCatchupCount: null,
      skippedOverlapCount: null,
    };
  }
  const firstNextAction = description.info.nextActionTimes[0];
  return {
    paused: description.state.paused,
    nextActionAt:
      firstNextAction instanceof Date && Number.isFinite(firstNextAction.getTime())
        ? firstNextAction
        : null,
    missedCatchupCount: boundedCounter(
      description.info.numActionsMissedCatchupWindow,
    ),
    skippedOverlapCount: boundedCounter(
      description.info.numActionsSkippedOverlap,
    ),
  };
}

export async function reconcilePlatformSchedules(input: {
  client: ScheduleClientLike;
  receipts: ScheduleDriftReceiptPort;
  contracts?: readonly ScheduleCodeContract[];
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const contracts = input.contracts ?? PLATFORM_SCHEDULES;
  const env = input.env ?? process.env;
  for (const contract of contracts) {
    const desiredHash = scheduleCodeHash(contract);
    let description: ScheduleDescription;
    try {
      description = await input.client.schedule.getHandle(contract.id).describe();
    } catch (error) {
      if (!isScheduleMissing(error)) {
        await appendFailed(
          input.receipts,
          contract,
          null,
          ['describe'],
          'SCHEDULE_DESCRIBE_FAILED',
        );
        throw error;
      }
      let created = false;
      try {
        await input.client.schedule.create(desiredScheduleOptions(contract, env));
        created = true;
      } catch (createError) {
        if (!isScheduleAlreadyRunning(createError)) {
          await appendFailed(input.receipts, contract, null, ['missing']);
          throw createError;
        }
      }
      // Either this worker created the schedule or another worker won the
      // create race. In both cases observe the exact stored action before
      // emitting a success receipt.
      try {
        description = await input.client.schedule
          .getHandle(contract.id)
          .describe();
      } catch (describeError) {
        await appendFailed(
          input.receipts,
          contract,
          null,
          ['describe'],
          'SCHEDULE_DESCRIBE_FAILED',
        );
        throw describeError;
      }
      if (created) {
        const createdHash = observedCodeHash(description);
        const createdDrift = changedCodeFields(contract, description);
        if (createdDrift.length === 0 && createdHash === desiredHash) {
          await input.receipts.append({
            scheduleId: contract.id,
            disposition: 'CREATED',
            desiredHash,
            observedHash: createdHash,
            changedFields: ['missing'],
            errorCode: null,
            ...scheduleRuntimeObservation(description),
          });
          continue;
        }
        // Temporal may accept a create request yet persist a normalized or
        // otherwise drifting action. Treat the readback as the observed state
        // and pass it through the same reconcile-and-verify path as any other
        // existing schedule; a CREATED receipt must never certify drift.
      }
    }

    const observedHash = observedCodeHash(description);
    const changedFields = changedCodeFields(contract, description);
    if (changedFields.length === 0) {
      await input.receipts.append({
        scheduleId: contract.id,
        disposition: 'IN_SYNC',
        desiredHash,
        observedHash,
        changedFields: [],
        errorCode: null,
        ...scheduleRuntimeObservation(description),
      });
      continue;
    }

    try {
      await input.client.schedule.getHandle(contract.id).update((previous) => ({
        spec: previous.spec,
        action: desiredScheduleOptions(contract, env).action,
        policies: {
          ...previous.policies,
          overlap: ScheduleOverlapPolicy.SKIP,
          catchupWindow: MINUTE,
        },
        state: previous.state,
        searchAttributes: previous.searchAttributes,
        typedSearchAttributes: previous.typedSearchAttributes,
      }));
    } catch (error) {
      await appendFailed(
        input.receipts,
        contract,
        observedHash,
        changedFields,
        'SCHEDULE_RECONCILE_FAILED',
        description,
      );
      throw error;
    }
    let repaired: ScheduleDescription;
    try {
      repaired = await input.client.schedule.getHandle(contract.id).describe();
    } catch (error) {
      await appendFailed(
        input.receipts,
        contract,
        observedHash,
        changedFields,
        'SCHEDULE_POST_RECONCILE_DESCRIBE_FAILED',
        description,
      );
      throw error;
    }
    const repairedHash = observedCodeHash(repaired);
    const remainingDrift = changedCodeFields(contract, repaired);
    if (remainingDrift.length > 0 || repairedHash !== desiredHash) {
      await appendFailed(
        input.receipts,
        contract,
        repairedHash,
        remainingDrift,
        'SCHEDULE_POST_RECONCILE_DRIFT',
        repaired,
      );
      throw new Error('SCHEDULE_POST_RECONCILE_DRIFT');
    }
    await input.receipts.append({
      scheduleId: contract.id,
      disposition: 'RECONCILED',
      desiredHash,
      observedHash: repairedHash,
      changedFields,
      errorCode: null,
      ...scheduleRuntimeObservation(repaired),
    });
  }
}

export async function ensurePlatformSchedules(
  receipts: ScheduleDriftReceiptPort,
): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });
  try {
    await reconcilePlatformSchedules({ client, receipts });
  } finally {
    await connection.close();
  }
}
