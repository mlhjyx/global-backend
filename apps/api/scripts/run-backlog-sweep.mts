/**
 * 手动触发一次存量对账 sweep 并等待结果（dev 实测/补账用；常规由 Schedule 周期驱动）。
 *   node --import tsx scripts/run-backlog-sweep.mts                       # 全部 ACTIVE ICP，默认批量
 *   node --import tsx scripts/run-backlog-sweep.mts --max-fit-rounds=30   # 提高资格门轮次上限（如首轮解锁全部存量）
 * worker 必须在线（pnpm --filter @global/api worker）。
 */
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { BACKLOG_SWEEP_WORKFLOW, UNDERSTANDING_TASK_QUEUE } from '../src/temporal/understanding.constants';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const argNum = (name: string): number | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : undefined;
};

const input = {
  maxFitRounds: argNum('max-fit-rounds'),
  maxEnrichRounds: argNum('max-enrich-rounds'),
  maxSignalRounds: argNum('max-signal-rounds'),
  maxWatchRounds: argNum('max-watch-rounds'),
  maxContactRounds: argNum('max-contact-rounds'),
  // 批大小（dev 有界样本用；缺省走 workflow 内的生产默认）
  fitBatch: argNum('fit-batch'),
  enrichBatch: argNum('enrich-batch'),
  signalBatch: argNum('signal-batch'),
  watchBatch: argNum('watch-batch'),
  contactBatch: argNum('contact-batch'),
};

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

const workflowId = `backlog-sweep-manual-${Date.now()}`;
const handle = await client.workflow.start(BACKLOG_SWEEP_WORKFLOW, {
  taskQueue: UNDERSTANDING_TASK_QUEUE,
  workflowId,
  args: [input],
});
console.log(`▶ started ${workflowId}，等待完成（资格门存量大时可达数十分钟）…`);
const result = await handle.result();
console.log(JSON.stringify(result, null, 2));
await connection.close();
