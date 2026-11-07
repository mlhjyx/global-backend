import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B2（F5）：确定性账本错误的 nonRetryable 转换只有在拦截器挂上 worker 时才生效。
 * 三个 worker 的挂载是源码事实，单测看不见——用源文本断言钉住（同
 * skill-runtime-wiring.source.spec 的先例），防止重构/升级把挂载静默丢掉。
 */
const WORKERS = [
  'worker.ts',
  'platform-worker.ts',
  'dev-fast-lane-worker.ts',
] as const;

describe('B2 拦截器在三个 worker 上的挂载（源文本断言）', () => {
  it.each(WORKERS)('%s 导入并注册 DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS', (file) => {
    const source = readFileSync(
      join(import.meta.dirname, file),
      'utf8',
    );
    expect(source).toContain(
      'import { DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS } from "./deterministic-ledger-failure.interceptor";',
    );
    expect(source).toMatch(/interceptors:\s*DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS/);
  });
});
