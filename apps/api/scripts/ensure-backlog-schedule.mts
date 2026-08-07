/**
 * 幂等创建/查看存量对账 sweep 的 Temporal Schedule（worker 启动已自动 ensure，此脚本供 ops 手查/补建）。
 *   node --import tsx scripts/ensure-backlog-schedule.mts            # 确保存在
 *   node --import tsx scripts/ensure-backlog-schedule.mts --describe # 查看下次触发
 * 频率用 env BACKLOG_SWEEP_EVERY（默认 24h；新公司走 run 内前向路径即时处理，backlog 只兜存量）。
 */
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { BACKLOG_SWEEP_SCHEDULE_ID } from '../src/temporal/understanding.constants';
import { PLATFORM_SCHEDULES, desiredScheduleOptions } from '../src/temporal/schedule-governance';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const contract = PLATFORM_SCHEDULES.find((item) => item.id === BACKLOG_SWEEP_SCHEDULE_ID);
if (!contract) throw new Error('BACKLOG_SCHEDULE_CONTRACT_MISSING');
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

if (process.argv.includes('--describe')) {
  const handle = client.schedule.getHandle(BACKLOG_SWEEP_SCHEDULE_ID);
  const d = await handle.describe();
  console.log(`schedule '${BACKLOG_SWEEP_SCHEDULE_ID}':`, {
    paused: d.state.paused,
    spec: d.spec.intervals,
    recentActions: d.info.recentActions.length,
    nextActions: d.info.nextActionTimes.slice(0, 3).map((t) => t.toISOString()),
  });
} else {
  try {
    await client.schedule.create(desiredScheduleOptions(contract, process.env));
    console.log(`✓ schedule '${BACKLOG_SWEEP_SCHEDULE_ID}' created from the code-owned action contract`);
  } catch (e) {
    if (e?.name === 'ScheduleAlreadyRunning' || /already/i.test(String(e))) {
      console.log(`schedule '${BACKLOG_SWEEP_SCHEDULE_ID}' already exists — leaving as is`);
    } else throw e;
  }
}
await connection.close();
