/**
 * 健康阈值（章节 §6.3.6.6，与 Airbyte 的 20/4、30/7 对齐）：
 *   - consecutive_failures ≥ 20 且 ≥4 天无成功 → WARNING（可静音级别：warning）
 *   - consecutive_failures ≥ 30 且 ≥7 天无成功 → AUTO_DISABLED(reason=AUTO_STREAK)（不可静音）
 * 与「连续 3 坏轮」的失败率规则并存：失败率管「一轮烂」，streak 管「一直烂」。
 * 从未成功过的渠道用 fallbackSince（创建时间）作参照，防止永远不触发。
 */

export const CHANNEL_WARNING_FAILURE_COUNT = 20;
export const CHANNEL_WARNING_WINDOW_DAYS = 4;
export const CHANNEL_AUTO_DISABLE_FAILURE_COUNT = 30;
export const CHANNEL_AUTO_DISABLE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

export interface ChannelHealthInput {
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  /** lastSuccessAt 为 null 时的参照点（通常是渠道 createdAt）。 */
  readonly fallbackSince: Date | null;
  readonly now: Date;
}

export type ChannelHealthAction = 'NONE' | 'WARNING' | 'AUTO_DISABLE';

export interface ChannelHealthVerdict {
  readonly action: ChannelHealthAction;
  readonly reason: 'NONE' | 'WARNING_20_4D' | 'AUTO_DISABLED_30_7D';
  readonly sinceSuccessMs: number | null;
}

export function evaluateChannelHealth(input: ChannelHealthInput): ChannelHealthVerdict {
  const reference = input.lastSuccessAt ?? input.fallbackSince;
  if (reference === null || input.consecutiveFailures <= 0) {
    return { action: 'NONE', reason: 'NONE', sinceSuccessMs: null };
  }
  const sinceSuccessMs = Math.max(0, input.now.getTime() - reference.getTime());
  if (
    input.consecutiveFailures >= CHANNEL_AUTO_DISABLE_FAILURE_COUNT &&
    sinceSuccessMs >= CHANNEL_AUTO_DISABLE_WINDOW_DAYS * DAY_MS
  ) {
    return { action: 'AUTO_DISABLE', reason: 'AUTO_DISABLED_30_7D', sinceSuccessMs };
  }
  if (
    input.consecutiveFailures >= CHANNEL_WARNING_FAILURE_COUNT &&
    sinceSuccessMs >= CHANNEL_WARNING_WINDOW_DAYS * DAY_MS
  ) {
    return { action: 'WARNING', reason: 'WARNING_20_4D', sinceSuccessMs };
  }
  return { action: 'NONE', reason: 'NONE', sinceSuccessMs };
}
