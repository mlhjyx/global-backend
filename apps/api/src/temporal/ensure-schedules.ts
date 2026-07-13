import { Client, Connection, ScheduleOverlapPolicy, type ScheduleSpec } from '@temporalio/client';

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
  PATENTS_CACHE_REFRESH_SCHEDULE_ID,
  PATENTS_CACHE_REFRESH_WORKFLOW,
  UNDERSTANDING_TASK_QUEUE,
} from './understanding.constants';

/**
 * 幂等保障平台三个周期 Schedule 存在（采集 sweep / intent sweep / 存量对账 sweep）。
 * 由 **worker 启动时调用**——dev 的 Temporal server（start-dev + SQLite）一重置 Schedule 就全丢，
 * 此前只能靠人记得手跑 ensure-*.mts 脚本，忘了 = 定时管线无声停摆。worker 是执行这些 workflow
 * 的进程，由它自愈保障最合理。已存在则不动（保留 ops 手工改频率/暂停的状态）。
 */
const SPECS = [
  { id: ACQ_SWEEP_SCHEDULE_ID, workflowType: ACQUISITION_SWEEP_WORKFLOW, everyEnv: 'ACQ_SWEEP_EVERY', everyDefault: '10m' },
  { id: INTENT_SWEEP_SCHEDULE_ID, workflowType: INTENT_SWEEP_WORKFLOW, everyEnv: 'INTENT_SWEEP_EVERY', everyDefault: '1h' },
  // 存量对账日级足够：新公司靠 run 内前向路径即时处理，backlog 只兜投影进来的/漏判的
  { id: BACKLOG_SWEEP_SCHEDULE_ID, workflowType: BACKLOG_SWEEP_WORKFLOW, everyEnv: 'BACKLOG_SWEEP_EVERY', everyDefault: '24h' },
  // 外部源 intent（TED 招标 / openFDA 510k 清关）→ ACTIVE ICP 投影动 Intent 维；招标/清关日级信号，6h 足够
  { id: EXTERNAL_INTENT_SWEEP_SCHEDULE_ID, workflowType: EXTERNAL_INTENT_SWEEP_WORKFLOW, everyEnv: 'EXTERNAL_INTENT_SWEEP_EVERY', everyDefault: '6h' },
  // 专利发明人缓存刷新（scale-safe #89）：一次共享大扫 → postgres 缓存。周更（BQ 扫数十 GB → 节制，稳在 1TB/月内）。
  // 注：env 名沿用兄弟 Schedule 的 `*_EVERY` 时长串约定（设计文档暂拟 _MS，实际机制用 Duration 串如 '7d'，故用 _EVERY）。
  { id: PATENTS_CACHE_REFRESH_SCHEDULE_ID, workflowType: PATENTS_CACHE_REFRESH_WORKFLOW, everyEnv: 'PATENT_CACHE_REFRESH_EVERY', everyDefault: '7d' },
];

export async function ensurePlatformSchedules(): Promise<void> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  try {
    for (const s of SPECS) {
      try {
        await client.schedule.create({
          scheduleId: s.id,
          spec: { intervals: [{ every: (process.env[s.everyEnv] ?? s.everyDefault) as Duration }] },
          action: {
            type: 'startWorkflow',
            workflowType: s.workflowType,
            taskQueue: UNDERSTANDING_TASK_QUEUE,
            args: [{}],
          },
          policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 minute' },
        });
        console.log(`[worker] schedule '${s.id}' created (every ${process.env[s.everyEnv] ?? s.everyDefault}, overlap=SKIP)`);
      } catch (e) {
        if ((e as Error)?.name === 'ScheduleAlreadyRunning' || /already/i.test(String(e))) continue; // 已存在则不动
        throw e;
      }
    }
  } finally {
    await connection.close();
  }
}
