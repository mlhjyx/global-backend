import { DeletionStatus } from './deletion.types';

/**
 * 删除请求状态机（收口⑥ PR-B）：RECEIVED → FROZEN → ERASING → COMPLETED，任一步可 → FAILED。
 * COMPLETED/FAILED 为终态。纯函数，供 service/activity 守转移合法性 + 幂等再入判断。
 */

const TRANSITIONS: Record<DeletionStatus, readonly DeletionStatus[]> = {
  RECEIVED: ['FROZEN', 'FAILED'],
  FROZEN: ['ERASING', 'FAILED'],
  ERASING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

/** happy-path 线性次序（FAILED 不在序内，单独处理）。用于「已到达/越过某步 → 幂等跳过」。 */
const ORDER: Record<Exclude<DeletionStatus, 'FAILED'>, number> = {
  RECEIVED: 0,
  FROZEN: 1,
  ERASING: 2,
  COMPLETED: 3,
};

export function canTransition(from: DeletionStatus, to: DeletionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeletionStatus, to: DeletionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid deletion status transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: DeletionStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

/**
 * happy-path 上 `current` 是否已到达或越过 `target`（用于 Temporal 重试幂等：某步已做则跳过）。
 * FAILED 与线性序无关 → 恒 false（失败态不视为「已越过」任何 happy 步）。
 */
export function isAtOrPast(current: DeletionStatus, target: Exclude<DeletionStatus, 'FAILED'>): boolean {
  if (current === 'FAILED') return false;
  return ORDER[current] >= ORDER[target];
}
