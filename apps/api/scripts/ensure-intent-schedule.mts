/**
 * 幂等创建/查看网站变更 intent sweep 的 Temporal Schedule。ops 跑一次即可；worker 需在线执行工作流。
 *   node --import tsx scripts/ensure-intent-schedule.mts            # 确保存在
 *   node --import tsx scripts/ensure-intent-schedule.mts --describe # 查看下次触发
 * 频率用 env INTENT_SWEEP_EVERY（默认 1h；页级监控日级足够，各源 cadence 决定到期）。overlap=SKIP 防重叠。
 */
import { readFileSync } from 'node:fs';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import { INTENT_SWEEP_SCHEDULE_ID, INTENT_SWEEP_WORKFLOW, UNDERSTANDING_TASK_QUEUE } from '../src/temporal/understanding.constants';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const EVERY = process.env.INTENT_SWEEP_EVERY ?? '1h';
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

if (process.argv.includes('--describe')) {
  const handle = client.schedule.getHandle(INTENT_SWEEP_SCHEDULE_ID);
  const d = await handle.describe();
  console.log(`schedule '${INTENT_SWEEP_SCHEDULE_ID}':`, {
    paused: d.state.paused,
    spec: d.spec.intervals,
    recentActions: d.info.recentActions.length,
    nextActions: d.info.nextActionTimes.slice(0, 3).map((t) => t.toISOString()),
  });
} else {
  try {
    await client.schedule.create({
      scheduleId: INTENT_SWEEP_SCHEDULE_ID,
      spec: { intervals: [{ every: EVERY }] },
      action: {
        type: 'startWorkflow',
        workflowType: INTENT_SWEEP_WORKFLOW,
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 minute' },
    });
    console.log(`✓ schedule '${INTENT_SWEEP_SCHEDULE_ID}' created — every ${EVERY}, overlap=SKIP`);
  } catch (e) {
    if (e?.name === 'ScheduleAlreadyRunning' || /already/i.test(String(e))) {
      console.log(`schedule '${INTENT_SWEEP_SCHEDULE_ID}' already exists — leaving as is`);
    } else throw e;
  }
}
await connection.close();
