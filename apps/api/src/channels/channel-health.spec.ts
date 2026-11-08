import { describe, expect, it } from 'vitest';
import {
  CHANNEL_AUTO_DISABLE_FAILURE_COUNT,
  CHANNEL_AUTO_DISABLE_WINDOW_DAYS,
  CHANNEL_WARNING_FAILURE_COUNT,
  CHANNEL_WARNING_WINDOW_DAYS,
  evaluateChannelHealth,
} from './channel-health';

const NOW = new Date('2026-11-09T00:00:00Z');
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

describe('健康阈值（20 次/4 天预警、30 次/7 天自动停用）', () => {
  it('常量与章节一致', () => {
    expect(CHANNEL_WARNING_FAILURE_COUNT).toBe(20);
    expect(CHANNEL_WARNING_WINDOW_DAYS).toBe(4);
    expect(CHANNEL_AUTO_DISABLE_FAILURE_COUNT).toBe(30);
    expect(CHANNEL_AUTO_DISABLE_WINDOW_DAYS).toBe(7);
  });

  it('低于阈值不动作', () => {
    expect(evaluateChannelHealth({ consecutiveFailures: 19, lastSuccessAt: daysAgo(10), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({ action: 'NONE' });
    expect(evaluateChannelHealth({ consecutiveFailures: 0, lastSuccessAt: null, fallbackSince: daysAgo(30), now: NOW })).toMatchObject({ action: 'NONE' });
  });

  it('20 次且 4 天无成功 → WARNING（边界含等号）', () => {
    expect(evaluateChannelHealth({ consecutiveFailures: 20, lastSuccessAt: daysAgo(4), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({
      action: 'WARNING',
      reason: 'WARNING_20_4D',
    });
    expect(evaluateChannelHealth({ consecutiveFailures: 20, lastSuccessAt: daysAgo(3.9), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({ action: 'NONE' });
    expect(evaluateChannelHealth({ consecutiveFailures: 19, lastSuccessAt: daysAgo(5), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({ action: 'NONE' });
  });

  it('30 次且 7 天无成功 → AUTO_DISABLE（优先于 WARNING，边界含等号）', () => {
    expect(evaluateChannelHealth({ consecutiveFailures: 30, lastSuccessAt: daysAgo(7), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({
      action: 'AUTO_DISABLE',
      reason: 'AUTO_DISABLED_30_7D',
    });
    expect(evaluateChannelHealth({ consecutiveFailures: 30, lastSuccessAt: daysAgo(6.9), fallbackSince: daysAgo(30), now: NOW })).toMatchObject({
      action: 'WARNING',
    });
  });

  it('从未成功过：用 fallbackSince（渠道创建时间）作参照，防止永远不触发', () => {
    expect(evaluateChannelHealth({ consecutiveFailures: 30, lastSuccessAt: null, fallbackSince: daysAgo(8), now: NOW })).toMatchObject({
      action: 'AUTO_DISABLE',
    });
    expect(evaluateChannelHealth({ consecutiveFailures: 30, lastSuccessAt: null, fallbackSince: daysAgo(5), now: NOW })).toMatchObject({
      action: 'WARNING',
    });
    expect(evaluateChannelHealth({ consecutiveFailures: 30, lastSuccessAt: null, fallbackSince: daysAgo(2), now: NOW })).toMatchObject({
      action: 'NONE',
    });
  });
});
