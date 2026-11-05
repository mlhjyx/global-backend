import 'reflect-metadata';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 回归守卫（P4-P4c）：ChannelService 的可选 platformTemporal 注入必须解析为真实的
 * PlatformTemporalClient 令牌。用 `import type` 引入时，编译产物的 design:paramtypes
 * 会退化为 Function，Nest 的 @Optional() 于是注入 undefined——requestCrawl 在真实进程里
 * 恒返回 PLATFORM_TEMPORAL_UNAVAILABLE，而直接 `new ChannelService(...)` 的单测覆盖不到。
 * 断言对象是编译产物（vitest 下 esbuild 不生成装饰器元数据，源码级断言没有意义）。
 */
const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const distChannelService = resolve(here, '../../dist/channels/channel.service.js');
const distPlatformClient = resolve(
  here,
  '../../dist/temporal/platform-temporal.client.js',
);

describe('ChannelService DI wiring（编译产物）', () => {
  it('design:paramtypes 的第二个参数是 PlatformTemporalClient 令牌而不是 Function', () => {
    const { ChannelService } = require_(distChannelService) as {
      ChannelService: new (...args: unknown[]) => unknown;
    };
    const { PlatformTemporalClient } = require_(distPlatformClient) as {
      PlatformTemporalClient: new (...args: unknown[]) => unknown;
    };
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      ChannelService,
    ) as unknown[] | undefined;
    expect(paramTypes).toBeDefined();
    expect(paramTypes).toHaveLength(2);
    expect(paramTypes?.[1]).toBe(PlatformTemporalClient);
    expect(paramTypes?.[1]).not.toBe(Function);
  });
});
