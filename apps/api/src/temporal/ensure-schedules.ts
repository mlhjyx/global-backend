import {
  Client,
  Connection,
  ScheduleOverlapPolicy,
  type ScheduleSpec,
} from '@temporalio/client';
import type { RuntimeProcessSnapshot } from '../runtime/runtime-admission';

/** @temporalio/common 非直接依赖（pnpm 严格解析），从 client 的公开类型间接取 Duration。 */
type Duration = NonNullable<ScheduleSpec['intervals']>[number]['every'];
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
  UNDERSTANDING_TASK_QUEUE,
} from './understanding.constants';

/**
 * 幂等保障平台三个周期 Schedule 存在（采集 sweep / intent sweep / 存量对账 sweep）。
 * 由 **worker 启动时调用**——dev 的 Temporal server（start-dev + SQLite）一重置 Schedule 就全丢，
 * 此前只能靠人记得手跑 ensure-*.mts 脚本，忘了 = 定时管线无声停摆。worker 是执行这些 workflow
 * 的进程，由它自愈保障最合理。已存在则不动（保留 ops 手工改频率/暂停的状态）。
 */
const SPECS = [
  {
    id: ACQ_SWEEP_SCHEDULE_ID,
    workflowType: ACQUISITION_SWEEP_WORKFLOW,
    everyEnv: 'ACQ_SWEEP_EVERY',
    everyDefault: '10m',
  },
  {
    id: INTENT_SWEEP_SCHEDULE_ID,
    workflowType: INTENT_SWEEP_WORKFLOW,
    everyEnv: 'INTENT_SWEEP_EVERY',
    everyDefault: '1h',
  },
  // 存量对账日级足够：新公司靠 run 内前向路径即时处理，backlog 只兜投影进来的/漏判的
  {
    id: BACKLOG_SWEEP_SCHEDULE_ID,
    workflowType: BACKLOG_SWEEP_WORKFLOW,
    everyEnv: 'BACKLOG_SWEEP_EVERY',
    everyDefault: '24h',
  },
  // 外部源 intent（TED 招标 / openFDA 510k 清关）→ ACTIVE ICP 投影动 Intent 维；招标/清关日级信号，6h 足够
  {
    id: EXTERNAL_INTENT_SWEEP_SCHEDULE_ID,
    workflowType: EXTERNAL_INTENT_SWEEP_WORKFLOW,
    everyEnv: 'EXTERNAL_INTENT_SWEEP_EVERY',
    everyDefault: '6h',
  },
  // 专利发明人缓存刷新（scale-safe #89）：一次共享大扫 → postgres 缓存。周更（BQ 扫数十 GB → 节制，稳在 1TB/月内）。
  // 注：env 名沿用兄弟 Schedule 的 `*_EVERY` 时长串约定（设计文档暂拟 _MS，实际机制用 Duration 串如 '7d'，故用 _EVERY）。
  {
    id: PATENTS_CACHE_REFRESH_SCHEDULE_ID,
    workflowType: PATENTS_CACHE_REFRESH_WORKFLOW,
    everyEnv: 'PATENT_CACHE_REFRESH_EVERY',
    everyDefault: '7d',
  },
  // 制裁名单刷新（Qualify 第五门）：OFAC 日更 → 每日足够；DISABLED 源零动作（refreshAll 只取 ENABLED）。
  {
    id: SANCTIONS_REFRESH_SCHEDULE_ID,
    workflowType: SANCTIONS_REFRESH_WORKFLOW,
    everyEnv: 'SANCTIONS_REFRESH_EVERY',
    everyDefault: '24h',
  },
  // KB 启动丢失 / due retry / 过期 processing lease 的兜底；每轮活动内部有界处理。
  {
    id: KB_RECOVERY_SWEEP_SCHEDULE_ID,
    workflowType: KB_RECOVERY_SWEEP_WORKFLOW,
    everyEnv: 'KB_RECOVERY_SWEEP_EVERY',
    everyDefault: '5m',
  },
  // R1 Release 对账与回收；workflow 始终可调度，但 activity 默认 no-op，须 ops 显式开启删除。
  {
    id: SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID,
    workflowType: SITE_RELEASE_MAINTENANCE_SWEEP_WORKFLOW,
    everyEnv: 'SITE_RELEASE_MAINTENANCE_SWEEP_EVERY',
    everyDefault: '24h',
  },
] as const;

export interface ResolvedPlatformSchedule {
  readonly id: (typeof SPECS)[number]['id'];
  readonly workflowType: (typeof SPECS)[number]['workflowType'];
  readonly every: Duration;
}

export interface PlatformScheduleConfiguration {
  readonly temporal: RuntimeProcessSnapshot['safety']['temporal'];
  readonly schedules: readonly ResolvedPlatformSchedule[];
}

export interface PlatformScheduleDriver {
  connect(
    options: Parameters<typeof Connection.connect>[0],
  ): ReturnType<typeof Connection.connect>;
  createClient(options: ConstructorParameters<typeof Client>[0]): Client;
}

function scheduleCadence(
  runtime: RuntimeProcessSnapshot,
  environmentName: (typeof SPECS)[number]['everyEnv'],
  fallback: string,
): Duration {
  const configured = runtime.environment[environmentName];
  if (configured === undefined) return fallback as Duration;
  if (configured === '' || configured.trim() !== configured) {
    throw new Error(
      `${environmentName} must be a canonical non-blank duration`,
    );
  }
  return configured as Duration;
}

/** Resolve every code-owned schedule input from the pre-side-effect frozen snapshot. */
export function resolvePlatformScheduleConfiguration(
  runtime: RuntimeProcessSnapshot,
): PlatformScheduleConfiguration {
  if (
    !Object.isFrozen(runtime) ||
    !Object.isFrozen(runtime.environment) ||
    !Object.isFrozen(runtime.safety) ||
    !Object.isFrozen(runtime.safety.temporal)
  ) {
    throw new Error('platform schedules require an immutable runtime snapshot');
  }
  const schedules = Object.freeze(
    SPECS.map((spec) =>
      Object.freeze({
        id: spec.id,
        workflowType: spec.workflowType,
        every: scheduleCadence(runtime, spec.everyEnv, spec.everyDefault),
      }),
    ),
  );
  return Object.freeze({
    temporal: runtime.safety.temporal,
    schedules,
  });
}

export async function ensurePlatformSchedules(
  runtime: RuntimeProcessSnapshot,
  driver?: PlatformScheduleDriver,
): Promise<void> {
  const configuration = resolvePlatformScheduleConfiguration(runtime);
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
    for (const schedule of configuration.schedules) {
      try {
        const isKbRecovery = schedule.id === KB_RECOVERY_SWEEP_SCHEDULE_ID;
        await client.schedule.create({
          scheduleId: schedule.id,
          spec: { intervals: [{ every: schedule.every }] },
          action: {
            type: 'startWorkflow',
            workflowType: schedule.workflowType,
            taskQueue: UNDERSTANDING_TASK_QUEUE,
            args: isKbRecovery ? [{ limit: 10 }] : [{}],
            // KB workflow 自身也只有两轮 10m activity；Schedule 再加顶层硬截止，防异常 history 长占 SKIP 锁。
            ...(isKbRecovery ? { workflowExecutionTimeout: '22 minutes' } : {}),
          },
          policies: {
            overlap: ScheduleOverlapPolicy.SKIP,
            catchupWindow: '1 minute',
          },
        });
        console.log(
          `[worker] schedule '${schedule.id}' created (every ${String(schedule.every)}, overlap=SKIP)`,
        );
      } catch (e) {
        if (
          (e as Error)?.name === 'ScheduleAlreadyRunning' ||
          /already/i.test(String(e))
        ) {
          if (schedule.id === KB_RECOVERY_SWEEP_SCHEDULE_ID) {
            // R2-A2 的有界执行参数属于正确性门，不能让已存在的开发/生产 Schedule 永久沿用旧 action。
            // 只更新 action；频率、overlap、暂停状态与 ops note 全部保留。
            await client.schedule.getHandle(schedule.id).update((previous) => ({
              spec: previous.spec,
              action: {
                ...previous.action,
                args: [{ limit: 10 }],
                workflowExecutionTimeout: '22 minutes',
              },
              policies: previous.policies,
              state: previous.state,
              searchAttributes: previous.searchAttributes,
              typedSearchAttributes: previous.typedSearchAttributes,
            }));
            console.log(
              `[worker] schedule '${schedule.id}' action reconciled; cadence/pause preserved`,
            );
          }
          continue;
        }
        throw e;
      }
    }
  } finally {
    await connection.close();
  }
}
