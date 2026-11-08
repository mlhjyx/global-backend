/**
 * R7-A（2026-11-04，设计 §6.4）：客户侧周期 sweep 的 API 内调度器。
 *
 * 平台迁移（2026-10-31）后，客户侧周期任务全部停摆：`ensurePlatformSchedules` 在 src 里没有
 * 调用方，且 `temporal-customer-client` 机器身份在平台集群上没有 ScheduleService 权限。
 * 这个调度器只用**被允许的 StartWorkflowExecution**：
 *   - 每个 sweep 按周期分桶，workflowId = `<scheduleId>-<period>`，REJECT_DUPLICATE 天然去重/防叠跑；
 *   - 启动时先补跑一次（catch-up），之后每 `SWEEP_SCHEDULER_TICK`（默认 1m）检查一次；
 *   - `SWEEP_SCHEDULER_ENABLED=off` 可整体关闭。
 *
 * 只调客户侧 6 个 sweep；4 个平台 schedule（acq/intent/patents/sanctions）仍以 paused 注册在
 * platform-automation，恢复运行是产品负责人的单独决定，不在此处。
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { TemporalClient } from './temporal.client';
import {
  BACKLOG_SWEEP_SCHEDULE_ID,
  BACKLOG_SWEEP_WORKFLOW,
  EXTERNAL_INTENT_SWEEP_SCHEDULE_ID,
  EXTERNAL_INTENT_SWEEP_WORKFLOW,
  KB_RECOVERY_SWEEP_SCHEDULE_ID,
  KB_RECOVERY_SWEEP_WORKFLOW,
  RAW_RETENTION_SWEEP_SCHEDULE_ID,
  RAW_RETENTION_SWEEP_WORKFLOW,
  SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID,
  SITE_BUILD_COST_RECONCILIATION_SWEEP_WORKFLOW,
  SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID,
  SITE_RELEASE_MAINTENANCE_SWEEP_WORKFLOW,
  UNDERSTANDING_TASK_QUEUE,
  DISCOVERY_STALE_RUN_SWEEP_SCHEDULE_ID,
  DISCOVERY_STALE_RUN_SWEEP_WORKFLOW,
} from './understanding.constants';

interface SweepDefinition {
  scheduleId: string;
  workflowType: string;
  everyEnv: string;
  everyDefault: string;
  args: unknown[];
  workflowExecutionTimeout?: string;
}

export const CUSTOMER_SWEEPS: readonly SweepDefinition[] = Object.freeze([
  { scheduleId: BACKLOG_SWEEP_SCHEDULE_ID, workflowType: BACKLOG_SWEEP_WORKFLOW, everyEnv: 'BACKLOG_SWEEP_EVERY', everyDefault: '24h', args: [{}] },
  { scheduleId: EXTERNAL_INTENT_SWEEP_SCHEDULE_ID, workflowType: EXTERNAL_INTENT_SWEEP_WORKFLOW, everyEnv: 'EXTERNAL_INTENT_SWEEP_EVERY', everyDefault: '6h', args: [{}] },
  { scheduleId: RAW_RETENTION_SWEEP_SCHEDULE_ID, workflowType: RAW_RETENTION_SWEEP_WORKFLOW, everyEnv: 'RAW_RETENTION_SWEEP_EVERY', everyDefault: '24h', args: [{}] },
  { scheduleId: SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID, workflowType: SITE_RELEASE_MAINTENANCE_SWEEP_WORKFLOW, everyEnv: 'SITE_RELEASE_MAINTENANCE_SWEEP_EVERY', everyDefault: '24h', args: [{}] },
  { scheduleId: KB_RECOVERY_SWEEP_SCHEDULE_ID, workflowType: KB_RECOVERY_SWEEP_WORKFLOW, everyEnv: 'KB_RECOVERY_SWEEP_EVERY', everyDefault: '5m', args: [{ limit: 10 }], workflowExecutionTimeout: '22 minutes' },
  // B3（审计 F2）：stale-run 看门狗——租约+余量（215m）仍 RUNNING 的 run 自动收尾 FAILED。
  { scheduleId: DISCOVERY_STALE_RUN_SWEEP_SCHEDULE_ID, workflowType: DISCOVERY_STALE_RUN_SWEEP_WORKFLOW, everyEnv: 'DISCOVERY_STALE_RUN_SWEEP_EVERY', everyDefault: '10m', args: [{}], workflowExecutionTimeout: '30 minutes' },
  { scheduleId: SITE_BUILD_COST_RECONCILIATION_SWEEP_SCHEDULE_ID, workflowType: SITE_BUILD_COST_RECONCILIATION_SWEEP_WORKFLOW, everyEnv: 'SITE_BUILD_COST_RECONCILIATION_EVERY', everyDefault: '1m', args: [{ limit: 50 }], workflowExecutionTimeout: '3 minutes' },
]);

const DURATION = /^(\d+)\s*(ms|s|m|h|d)$/i;

export function parseSweepDuration(text: string | undefined): number | null {
  if (!text) return null;
  const match = DURATION.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor =
    unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value > 0 ? value * factor : null;
}

function schedulerEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test((process.env.SWEEP_SCHEDULER_ENABLED ?? 'true').trim());
}

@Injectable()
export class SweepSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly temporal: TemporalClient) {}

  async onModuleInit(): Promise<void> {
    if (!schedulerEnabled()) {
      console.log('[sweep-scheduler] disabled by SWEEP_SCHEDULER_ENABLED');
      return;
    }
    // 启动补跑：错过周期桶的 sweep 立刻补一次（workflowId 去重保证不会与在跑实例叠跑）。
    await this.tick();
    const tickMs = Math.max(parseSweepDuration(process.env.SWEEP_SCHEDULER_TICK) ?? 60_000, 5_000);
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
    console.log(`[sweep-scheduler] started (tick ${tickMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 检查并补起所有到期的 sweep；测试直接调用并注入时间。 */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const sweep of CUSTOMER_SWEEPS) {
        await this.startPeriodBucket(sweep, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async startPeriodBucket(sweep: SweepDefinition, now: Date): Promise<void> {
    const everyMs = parseSweepDuration(process.env[sweep.everyEnv]) ?? parseSweepDuration(sweep.everyDefault);
    if (!everyMs) return;
    const period = Math.floor(now.getTime() / everyMs);
    const workflowId = `${sweep.scheduleId}-${period}`;
    try {
      // 以工作流类型名字符串启动（与 relay 的 startWorkflowIdempotent 同一 API）；sweep 的
      // 输入/超时是按调度定义的动态值，SDK 的静态泛型在这里收窄不了，故按契约形状传入。
      await this.temporal.client.workflow.start(sweep.workflowType, {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        args: sweep.args,
        ...(sweep.workflowExecutionTimeout
          ? { workflowExecutionTimeout: sweep.workflowExecutionTimeout }
          : {}),
      } as never);
    } catch (error) {
      // 同一周期的实例已在跑/已结束（REJECT_DUPLICATE）：下一轮自然跳过，不告警。
      if (/already|AlreadyStarted|WorkflowExecutionAlreadyStarted/i.test(String(error))) return;
      console.warn(
        `[sweep-scheduler] ${sweep.scheduleId} could not start (${workflowId}): ${
          error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        }`,
      );
    }
  }
}
