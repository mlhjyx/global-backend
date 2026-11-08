import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B5（PERF-02）：活动时限必须覆盖网关的**最坏**线上路径（一次结构化回答可能串
 * 初答 + 一次 schema 修复两条 provider 调用），且取消信号要传进模型调用、长活动要
 * 有心跳。这些是「源码事实」，运行期测试看不见——用源文本断言钉住。
 * 数值不写死：从网关边界文件解析上限，防御阈值被上调而断言仍绿。
 */
const dir = import.meta.dirname;

function source(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + 1);
  expect(from, `anchor ${start} present`).toBeGreaterThanOrEqual(0);
  expect(to, `anchor ${end} present`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('understanding 活动的超时对齐与取消传播（B5）', () => {
  it('模型活动时限覆盖 2×网关上限（初答 + 修复）并带心跳超时', () => {
    const gateway = source('../model-gateway/gateway-credential-boundary.ts');
    const gatewayMaxMs = Number(
      /MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)/u.exec(gateway)?.[1]?.replaceAll('_', ''),
    );
    expect(Number.isSafeInteger(gatewayMaxMs)).toBe(true);

    const workflow = source('understanding.workflow.ts');
    const modelActs = sliceBetween(workflow, 'const modelActs', 'const dbActs');
    const minutes = Number(/startToCloseTimeout:\s*'(\d+) minutes'/u.exec(modelActs)?.[1]);
    expect(Number.isSafeInteger(minutes)).toBe(true);
    // 一次结构化回答最多两条 300s 级 provider 调用 + 余量；写死 6 分钟会漏掉修复路径。
    expect(minutes * 60_000).toBeGreaterThanOrEqual(2 * gatewayMaxMs);
    expect(modelActs).toContain("heartbeatTimeout: '2 minutes'");

    const crawlActs = sliceBetween(workflow, 'const crawlActs', 'const modelActs');
    expect(crawlActs).toContain("startToCloseTimeout: '5 minutes'");
    expect(crawlActs).toContain("heartbeatTimeout: '2 minutes'");
  });

  it('modelActs/crawlActs 下每个活动都有心跳包装（否则 heartbeatTimeout 会把预算压到 2 分钟）', () => {
    const workflow = source('understanding.workflow.ts');
    const dispatched = new Set<string>();
    for (const proxy of ['modelActs', 'crawlActs']) {
      for (const match of workflow.matchAll(new RegExp(`${proxy}\\.(\\w+)\\(`, 'gu'))) {
        dispatched.add(match[1]!);
      }
    }
    expect(dispatched.size).toBeGreaterThanOrEqual(4);
    const activities = source('understanding.activities.ts');
    for (const name of dispatched) {
      const body = sliceBetween(activities, `async ${name}(`, '\n    },');
      expect(body, `${name} wrapped in withActivityHeartbeat`).toContain(
        'withActivityHeartbeat(30_000,',
      );
    }
  });

  it('三个模型调用都把活动取消信号传进网关输入', () => {
    const activities = source('understanding.activities.ts');
    expect(activities).toContain('function activityCancellationSignal()');
    const occurrences = activities.split('signal: activityCancellationSignal(),').length - 1;
    // claims / offerings / profile 三处。
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});
