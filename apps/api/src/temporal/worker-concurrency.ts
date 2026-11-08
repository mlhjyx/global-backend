/**
 * ch08 §3.1.6 阶段 1：worker 显式并发。
 *
 * Temporal 默认允许 100 个并发活动任务；xin 是 2 vCPU 共用主机（Prisma 连接池按 CPU 推导约 5，
 * 下游 crawl4ai 全局桶 6），混合负载下默认值会打满 CPU/连接池 → 活动超时与 worker 排空。
 * 默认 12/8/4 是压测前的保守配置；部署后按失败率 <15%、CPU p95 <85% 校准，环境变量可调。
 */

export interface WorkerConcurrencyOptions {
  readonly maxConcurrentActivityTaskExecutions: number;
  readonly maxConcurrentWorkflowTaskExecutions: number;
  readonly maxConcurrentLocalActivityExecutions: number;
}

export const WORKER_CONCURRENCY_DEFAULTS = Object.freeze({
  activity: 12,
  workflow: 8,
  local: 4,
});

export function workerConcurrencyValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    // 启动即失败（同 worker 的其它启动不变量）：静默回退会掩盖配置错误。
    throw new Error(`WORKER_CONCURRENCY_INVALID:${name}`);
  }
  return value;
}

export function workerConcurrencyOptions(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConcurrencyOptions {
  return {
    maxConcurrentActivityTaskExecutions: workerConcurrencyValue(
      env,
      'WORKER_MAX_CONCURRENT_ACTIVITY',
      WORKER_CONCURRENCY_DEFAULTS.activity,
    ),
    maxConcurrentWorkflowTaskExecutions: workerConcurrencyValue(
      env,
      'WORKER_MAX_CONCURRENT_WORKFLOW',
      WORKER_CONCURRENCY_DEFAULTS.workflow,
    ),
    maxConcurrentLocalActivityExecutions: workerConcurrencyValue(
      env,
      'WORKER_MAX_CONCURRENT_LOCAL',
      WORKER_CONCURRENCY_DEFAULTS.local,
    ),
  };
}
