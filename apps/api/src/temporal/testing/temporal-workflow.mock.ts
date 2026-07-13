import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * 工作流编排单测地基：把 `@temporalio/workflow` 的 `proxyActivities` 换成**惰性 spy 注册表**。
 * 每个 activity 名首次被访问即生成一个 memoized `vi.fn()`；workflow 遂以纯 JS 运行——activity
 * 返回值由测试逐个 mock，调用顺序/入参由 spy 观测。无 Temporal 运行时、无 test-server 二进制、
 * 无出网 → 跑在既有 vitest CI job（§8 纯单测，无 DB/网络）。
 *
 * 用法（每个 *.workflow.spec.ts 两行接线；静态 import 与工厂动态 import 解析到同一模块实例 → 同一注册表）：
 *   vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));
 *   import { acts, resetActivities } from './testing/temporal-workflow.mock';
 * 断言：expect(acts.liveProviderState).toHaveBeenCalledTimes(1);
 *       expect(acts.projectExternalIntentForIcp).toHaveBeenCalledWith(expect.objectContaining({ live }));
 *
 * 设计见 docs/implementation-records/temporal-workflow-testing.md。
 */

/** activity 名 → spy。键即 activity 方法名（worker 全表扁平注册，全局唯一 → 单一注册表正确）。 */
const registry: Record<string, Mock> = {};

/**
 * 惰性 spy 代理：workflow 里 `acts.foo(...)` 与测试里 `acts.foo.mockResolvedValue(...)` 解析到
 * 同一 memoized `vi.fn()`。任意 `proxyActivities({...})` 调用都返回本代理——discovery/backlog/
 * understanding 各有多个代理常量，但 activity 名全局唯一，共享一表即可。
 * `then`/Symbol 返回 undefined：防代理被误当 thenable（await/Promise 互操作），以及 Symbol 探测。
 */
export const acts: Record<string, Mock> = new Proxy({} as Record<string, Mock>, {
  get(_target, prop): Mock | undefined {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    return (registry[prop] ??= vi.fn());
  },
});

/** 模拟 `@temporalio/workflow` 的 `proxyActivities`：忽略选项，返回惰性 spy 代理。 */
export function proxyActivities<T>(_opts?: unknown): T {
  return acts as unknown as T;
}

/**
 * 模拟 `@temporalio/workflow` 的 `patched`（版本化闸）：默认返回 true（走**新**代码路径，
 * 对应新执行/新历史）。测试可 {@link setPatched} 覆盖为 false（模拟飞行中旧历史的 replay：无此 patch
 * 标记 → 旧命令序列）以验证版本化守卫两侧分支。`resetActivities` 复位默认。
 */
let patchedFn: (patchId: string) => boolean = () => true;
export function patched(patchId: string): boolean {
  return patchedFn(patchId);
}
export function setPatched(fn: (patchId: string) => boolean): void {
  patchedFn = fn;
}

/** 模拟 `@temporalio/workflow` 的 workflow logger（编排里 `log.warn(...)` 等）：无副作用 spy。 */
export const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** `beforeEach` 调用：清空注册表 + logger，杜绝跨用例 spy 状态泄漏。 */
export function resetActivities(): void {
  for (const key of Object.keys(registry)) delete registry[key];
  patchedFn = () => true;
  log.debug.mockReset();
  log.info.mockReset();
  log.warn.mockReset();
  log.error.mockReset();
}
