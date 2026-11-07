// 工作流可调常量（审计 L01，2026-11-08 架构整顿 B1）。
//
// 为什么放在这里：Temporal 重放要求工作流按**记录的历史命令序列**重新调度。参与分支/循环的
// 数值常量如果留在 workflow 代码里，改一次常量就会让在飞历史重放出不同的命令序列（NDE）。
// 所以这些值随启动输入进入历史（relay 注入，见 outbox-relay.service.ts），本模块只是三件事：
// 缺省值、合法区间、以及给 relay 读 env 的默认值。
//
// 重放契约：*_DEFAULT 是「历史里没有该字段的旧 run」重放时用的冻结值——一经发布**永不修改**。
// 要换缺省值：让 relay 注入新的显式数值（新 run 的历史会带上它），不要动这里的常量。
// 文件不 import @temporalio/*，workflow 沙箱与普通 Node 进程（relay）都可安全引用。
import type { DiscoveryRunInput } from './discovery.activities';

export const DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT = 20;
export const DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT = 16;
export const DISCOVERY_QUERY_BATCH_SIZE_DEFAULT = 2;

export interface WorkflowKnobBounds {
  readonly min: number;
  readonly max: number;
}

export const DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS: WorkflowKnobBounds = Object.freeze({
  min: 0,
  max: 1000,
});
export const DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS: WorkflowKnobBounds = Object.freeze({
  min: 1,
  max: 64,
});
export const DISCOVERY_QUERY_BATCH_SIZE_BOUNDS: WorkflowKnobBounds = Object.freeze({
  min: 1,
  max: 8,
});

/**
 * 把历史输入里的数值旋钮收敛到合法区间：非有限数回落冻结默认，越界夹到边界。
 * 纯函数（无时间/随机/IO），重放确定。
 */
export function boundedKnob(value: unknown, fallback: number, bounds: WorkflowKnobBounds): number {
  const candidate =
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(candidate, bounds.min), bounds.max);
}

/**
 * 一个 run 实际生效的旋钮值。workflow 用它把输入收敛成确定值；relay 用它生成启动输入。
 * 字段始终显式存在——新历史因此完整携带数值，重放与代码里的缺省值无关。
 */
export interface DiscoveryWorkflowKnobs {
  run2PoolSearchFallbackThreshold: number;
  deepCompanyConcurrency: number;
  discoveryQueryBatchSize: number;
}

export function resolveDiscoveryWorkflowKnobs(
  input: Pick<
    DiscoveryRunInput,
    'run2PoolSearchFallbackThreshold' | 'deepCompanyConcurrency' | 'discoveryQueryBatchSize'
  >,
): DiscoveryWorkflowKnobs {
  return {
    run2PoolSearchFallbackThreshold: boundedKnob(
      input.run2PoolSearchFallbackThreshold,
      DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
      DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS,
    ),
    deepCompanyConcurrency: boundedKnob(
      input.deepCompanyConcurrency,
      DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
      DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS,
    ),
    discoveryQueryBatchSize: boundedKnob(
      input.discoveryQueryBatchSize,
      DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
      DISCOVERY_QUERY_BATCH_SIZE_BOUNDS,
    ),
  };
}

/** relay 注入用的 env 名（部署侧调参入口；值随 run 写入历史后不再受 env 变更影响）。 */
export const DISCOVERY_WORKFLOW_KNOB_ENV = Object.freeze({
  run2PoolSearchFallbackThreshold: 'DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD',
  deepCompanyConcurrency: 'DISCOVERY_DEEP_COMPANY_CONCURRENCY',
  discoveryQueryBatchSize: 'DISCOVERY_QUERY_BATCH_SIZE',
});
