// 工作流可调常量（审计 L01，2026-11-08 架构整顿 B1）。
//
// 为什么放在这里：Temporal 重放要求工作流按**记录的历史命令序列**重新调度。参与分支/循环的
// 数值常量如果留在 workflow 代码里，改一次常量就会让在飞历史重放出不同的命令序列（NDE）。
// 所以这些值随启动输入进入历史：relay 在**注入时**用 BOUNDS 夹取并把夹取后的最终值写进
// 启动输入；workflow 重放时只原样使用录制值（仅对不可能是 relay 产出的非物理值回退默认），
// 不再引用可变的 BOUNDS——否则日后放宽/收紧 BOUNDS 仍会让在飞历史重放出不同命令数。
//
// 重放契约（永远不要修改）：
//   - *_DEFAULT：历史里没有该字段的旧 run 重放时使用的冻结值；
//   - resolveDiscoveryWorkflowKnobs 里 `recordedInt(value, min)` 的 min 字面量。
// 非契约（可以改，只影响新 run）：*_BOUNDS——仅 relay 注入时使用。
// 回退约束：一旦用 env 覆盖过旋钮，回退到本改动之前的旧镜像前必须先把在飞 run 排空
// （旧镜像不读这些字段，会用常量值重放新历史 → NDE）。
// 文件不 import @temporalio/*，workflow 沙箱与普通 Node 进程（relay）都可安全引用。
import type { DiscoveryRunInput } from './discovery.activities';

export const DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT = 20;
export const DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT = 16;
export const DISCOVERY_QUERY_BATCH_SIZE_DEFAULT = 2;

/**
 * 重放契约（同 *_DEFAULT 一样永远不要修改）：录制值的最小物理边界。低于它的值只能是
 * relay 之前的手工历史，改动会让这些历史重放出不同的分支/循环次数（NDE）。
 */
export const DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_FLOOR = 0;
export const DISCOVERY_DEEP_COMPANY_CONCURRENCY_FLOOR = 1;
export const DISCOVERY_QUERY_BATCH_SIZE_FLOOR = 1;

export interface WorkflowKnobBounds {
  readonly min: number;
  readonly max: number;
}

/** relay 注入时的合法区间。不是重放契约：workflow 从不读它们。 */
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
 * 注入时夹取：非有限数回落冻结默认，越界夹到边界。**只允许 relay 调用**——
 * workflow 代码引用可变 BOUNDS 会把边界本身变成重放契约。
 */
export function boundedKnob(value: unknown, fallback: number, bounds: WorkflowKnobBounds): number {
  const candidate =
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(candidate, bounds.min), bounds.max);
}

/**
 * 录制值的重放读取：relay 注入的每个值都已夹取在合法区间内，这里只做「有限数 + 非物理值」
 * 守卫——`min` 是冻结字面量，这类越界值永远不会出现在真实历史里，改守卫不会改变任何已录制
 * 历史的调度结果。纯函数（无时间/随机/IO），重放确定。
 */
function recordedInt(value: unknown, min: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= min ? truncated : null;
}

/**
 * 一个 run 实际生效的旋钮值：只从录制输入读取（缺省/非物理值回落冻结默认）。
 * 新 run 的历史完整携带数值，重放与代码里的缺省值和 BOUNDS 都无关。
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
    run2PoolSearchFallbackThreshold:
      recordedInt(
        input.run2PoolSearchFallbackThreshold,
        DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_FLOOR,
      ) ?? DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
    deepCompanyConcurrency:
      recordedInt(input.deepCompanyConcurrency, DISCOVERY_DEEP_COMPANY_CONCURRENCY_FLOOR) ??
      DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
    discoveryQueryBatchSize:
      recordedInt(input.discoveryQueryBatchSize, DISCOVERY_QUERY_BATCH_SIZE_FLOOR) ??
      DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
  };
}

/** relay 注入用的 env 名（部署侧调参入口；值随 run 写入历史后不再受 env 变更影响）。 */
export const DISCOVERY_WORKFLOW_KNOB_ENV = Object.freeze({
  run2PoolSearchFallbackThreshold: 'DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD',
  deepCompanyConcurrency: 'DISCOVERY_DEEP_COMPANY_CONCURRENCY',
  discoveryQueryBatchSize: 'DISCOVERY_QUERY_BATCH_SIZE',
});
