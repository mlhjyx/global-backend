import { Client, Connection, type ScheduleSpec } from "@temporalio/client";
import type { RuntimeProcessSnapshot } from "../runtime/runtime-admission";
import {
  PLATFORM_SCHEDULES,
  desiredScheduleOptions,
  reconcilePlatformSchedules,
  scheduleCodeHash,
  type ScheduleDriftReceiptPort,
} from "./schedule-governance";
import { KB_RECOVERY_SWEEP_SCHEDULE_ID } from "./understanding.constants";

/** @temporalio/common is transitive under pnpm, so derive Duration publicly. */
type Duration = NonNullable<ScheduleSpec["intervals"]>[number]["every"];

export interface ResolvedPlatformSchedule {
  readonly id: string;
  readonly workflowType: string;
  readonly every: Duration;
}

export interface PlatformScheduleConfiguration {
  readonly temporal: RuntimeProcessSnapshot["safety"]["temporal"];
  readonly schedules: readonly ResolvedPlatformSchedule[];
}

export interface PlatformScheduleDriver {
  connect(
    options: Parameters<typeof Connection.connect>[0],
  ): ReturnType<typeof Connection.connect>;
  createClient(options: ConstructorParameters<typeof Client>[0]): Client;
}

/** Resolve all connection and cadence inputs before the first Temporal side effect. */
export function resolvePlatformScheduleConfiguration(
  runtime: RuntimeProcessSnapshot,
): PlatformScheduleConfiguration {
  if (
    !Object.isFrozen(runtime) ||
    !Object.isFrozen(runtime.environment) ||
    !Object.isFrozen(runtime.safety) ||
    !Object.isFrozen(runtime.safety.temporal)
  ) {
    throw new Error("platform schedules require an immutable runtime snapshot");
  }

  const schedules = Object.freeze(
    PLATFORM_SCHEDULES.map((contract) => {
      let options;
      try {
        options = desiredScheduleOptions(contract, runtime.environment);
      } catch (error) {
        throw new Error(
          `${contract.cadenceEnv} must be a canonical non-blank duration`,
          { cause: error },
        );
      }
      const every = options.spec.intervals?.[0]?.every;
      if (every === undefined) {
        throw new Error(`platform schedule '${contract.id}' cadence missing`);
      }
      return Object.freeze({
        id: contract.id,
        workflowType: contract.workflowType,
        every,
      });
    }),
  );

  return Object.freeze({
    temporal: runtime.safety.temporal,
    schedules,
  });
}

function isPlatformScheduleDriver(
  candidate: ScheduleDriftReceiptPort | PlatformScheduleDriver,
): candidate is PlatformScheduleDriver {
  return "connect" in candidate && "createClient" in candidate;
}

/**
 * Compatibility seam for the pre-governance hermetic driver tests.
 * Production callers pass a receipt port and therefore always use the
 * code-owned reconciliation path below.
 */
async function ensureWithLegacyTestDriver(
  configuration: PlatformScheduleConfiguration,
  driver: PlatformScheduleDriver,
): Promise<void> {
  const connection = await driver.connect({
    address: configuration.temporal.address,
    connectTimeout: configuration.temporal.connectTimeoutMs,
  });
  const client = driver.createClient({
    connection,
    namespace: configuration.temporal.namespace,
  });
  try {
    for (const schedule of configuration.schedules) {
      const contract = PLATFORM_SCHEDULES.find(({ id }) => id === schedule.id);
      if (!contract) throw new Error("platform schedule contract missing");
      try {
        const desired = desiredScheduleOptions(contract, {
          [contract.cadenceEnv]: String(schedule.every),
        });
        await client.schedule.create({
          ...desired,
          // Preserve the historical public-duration representation on this
          // compatibility-only test seam. Production reconciliation uses the
          // canonical millisecond policy in schedule-governance.
          policies: { ...desired.policies, catchupWindow: "1 minute" },
        });
      } catch (error) {
        if (
          (error as Error)?.name !== "ScheduleAlreadyRunning" &&
          !/already/i.test(String(error))
        ) {
          throw error;
        }
        if (schedule.id === KB_RECOVERY_SWEEP_SCHEDULE_ID) {
          await client.schedule.getHandle(schedule.id).update((previous) => ({
            spec: previous.spec,
            action: {
              ...previous.action,
              args: [{ limit: 10 }],
              workflowExecutionTimeout: "22 minutes",
            },
            policies: previous.policies,
            state: previous.state,
            searchAttributes: previous.searchAttributes,
            typedSearchAttributes: previous.typedSearchAttributes,
          }));
        }
      }
    }
  } finally {
    await connection.close();
  }
}

/**
 * Reconcile code-managed action fields while retaining cadence and pause as
 * operator-managed state. All mutable environment input comes from `runtime`.
 */
export async function ensurePlatformSchedules(
  runtime: RuntimeProcessSnapshot,
  receiptsOrDriver: ScheduleDriftReceiptPort | PlatformScheduleDriver,
  driver?: PlatformScheduleDriver,
): Promise<void> {
  const configuration = resolvePlatformScheduleConfiguration(runtime);
  if (isPlatformScheduleDriver(receiptsOrDriver)) {
    await ensureWithLegacyTestDriver(configuration, receiptsOrDriver);
    return;
  }

  const connectionOptions = {
    address: configuration.temporal.address,
    connectTimeout: configuration.temporal.connectTimeoutMs,
  };
  const connection = driver
    ? await driver.connect(connectionOptions)
    : await Connection.connect(connectionOptions);
  const clientOptions = {
    connection,
    namespace: configuration.temporal.namespace,
  };
  const client = driver
    ? driver.createClient(clientOptions)
    : new Client(clientOptions);
  try {
    await reconcilePlatformSchedules({
      client,
      receipts: receiptsOrDriver,
      env: runtime.environment,
    });
  } finally {
    await connection.close();
  }
}

export {
  PLATFORM_SCHEDULES,
  desiredScheduleOptions,
  reconcilePlatformSchedules,
  scheduleCodeHash,
} from "./schedule-governance";
export {
  ACQ_SWEEP_SCHEDULE_ID,
  BACKLOG_SWEEP_SCHEDULE_ID,
  EXTERNAL_INTENT_SWEEP_SCHEDULE_ID,
  INTENT_SWEEP_SCHEDULE_ID,
  KB_RECOVERY_SWEEP_SCHEDULE_ID,
  PATENTS_CACHE_REFRESH_SCHEDULE_ID,
  SANCTIONS_REFRESH_SCHEDULE_ID,
  SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID,
} from "./understanding.constants";
