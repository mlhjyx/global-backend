import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B5（PERF-02）：活动时限必须大于网关的模型请求上限，且取消信号要传进模型调用。
 * 这些是「源码事实」，运行期测试看不见——用源文本断言钉住（同 worker 挂载断言的先例）。
 */
const dir = import.meta.dirname;

describe('understanding 活动的超时对齐与取消传播（B5）', () => {
  it('模型活动的 startToCloseTimeout（6 分钟）大于网关 300s 上限，且带心跳超时', () => {
    const source = readFileSync(join(dir, 'understanding.workflow.ts'), 'utf8');
    const modelActs = source.slice(source.indexOf('const modelActs'), source.indexOf('const dbActs'));
    expect(modelActs).toContain("startToCloseTimeout: '6 minutes'");
    expect(modelActs).toContain("heartbeatTimeout: '2 minutes'");
    const crawlActs = source.slice(source.indexOf('const crawlActs'), source.indexOf('const modelActs'));
    expect(crawlActs).toContain("startToCloseTimeout: '5 minutes'");
    expect(crawlActs).toContain("heartbeatTimeout: '2 minutes'");
    // 与网关上限的对照：300s 上限 + 余量 < 活动时限。
    expect(6 * 60).toBeGreaterThan(300);
  });

  it('两个抽取活动把活动取消信号传进模型网关调用', () => {
    const source = readFileSync(join(dir, 'understanding.activities.ts'), 'utf8');
    expect(source).toContain('function activityCancellationSignal()');
    expect(source).toContain('signal: activityCancellationSignal(),');
    // 两个抽取调用（claims/offerings）都要有。
    const occurrences = source.split('signal: activityCancellationSignal(),').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('长活动包了周期心跳', () => {
    const source = readFileSync(join(dir, 'understanding.activities.ts'), 'utf8');
    expect(source).toContain('function withActivityHeartbeat');
    expect(source.split('withActivityHeartbeat(30_000,').length - 1).toBeGreaterThanOrEqual(3);
  });
});
