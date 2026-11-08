// discovery run 的生命周期常量（B3，审计 F2/F12，2026-11-08）。
//
// 重放安全说明：本文件不是 workflow 文件，常量只作为**活动输入参数**使用（不参与任何
// workflow 分支/循环），改值不会改变已录制历史的命令序列。
//
// 三个数字来自同一份租约设计（ADR-024 落地：admission lease 180 分钟 +
// discovery-run-lease.ts 的 10 分钟 finalize 预留）：
//   - 执行时限 215m：租约 + finalize 预留 + 25m 缓冲。Temporal 超时会终止 workflow；
//     DB 行由看门狗收尾（terminate 不执行 workflow 的 catch，这是 F2 的核心缺口）。
//   - 看门狗阈值 215m：≥ 执行时限，因此「超过阈值仍 RUNNING」必然等价于「租约已过、
//     无活动租约」——过租约后所有阶段只允许收尾，不会误杀合法 run。
export const DISCOVERY_RUN_EXECUTION_TIMEOUT = '215 minutes';
export const DISCOVERY_RUN_STALE_AFTER_MS = 215 * 60_000;
/** 一轮看门狗最多收尾的 run 数（函数侧上限 200，双保险）。 */
export const STALE_RUN_SWEEP_LIMIT = 50;
