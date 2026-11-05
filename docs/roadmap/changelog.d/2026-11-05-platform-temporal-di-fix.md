---
date: 2026-11-05
pr: 812
title: Fix the platform crawl client injection so requestCrawl is reachable
---

- 起因：P4-P4c（#809）的 `ChannelService` 用 `import type` 引入 `PlatformTemporalClient`，编译产物 `design:paramtypes` 退化为 `[PrismaService, Function]`，Nest 的 `@Optional()` 因此永远注入 `undefined`——真实进程里 `requestCrawl` 恒返回 503 `PLATFORM_TEMPORAL_UNAVAILABLE`（"未接线"）。单测直接 `new ChannelService(prisma, fake)` 注入假对象，覆盖不到装饰器元数据；CI 全绿但真实链路不可达（2026-11-05 上线验收时用真实 saas-ops token 打 preview 暴露）。
- 改动：把该导入改为值导入（其余 `import type` 用法为类型参数/字段，不参与 DI，不动）；新增回归守卫 `channel-service-di.spec.ts`——断言**编译产物**的 `design:paramtypes[1]` 等于 `PlatformTemporalClient` 而不是 `Function`（vitest 的 esbuild 不产装饰器元数据，源码级断言无意义；CI 在 vitest 之前已 `nest build`）。
- 测试：新 spec 红→绿（红态证据：旧镜像内 dist 实测 `[PrismaService, Function]`）；channels 相关套件全过；`gctl check --fast` 通过。
- 未做：不改运行时协议、不动 API 形状；随下一班镜像生效。
