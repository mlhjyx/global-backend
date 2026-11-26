# 高精度获客验收

从包含波次 1（F1–F10）、主线 A（F11/F12）和 discovery 旁路租约热修的 checkout 执行。可将待合并实现复制到一次性本地目录，把源码目录只读挂载到容器。测试使用合成工作区、联系人和公司记录。把依赖和 Prisma 客户端提前准备好，再在 `--network none` 的容器里运行。容器只需回环接口，无需挂载开发或生产的环境文件。

```bash
cd apps/api
pnpm exec vitest run --config vitest.e2e.config.ts
E2E_TARGET_MODE=harness-selfcheck pnpm exec vitest run --config vitest.e2e.config.ts
pnpm exec tsc --project tsconfig.e2e.json
```

默认 `integrated` 运行 F1–F12 的产品接口和组件断言。待接入的模块在缺失时会给出实现路径，失败直接返回。模式值无法识别时终止运行。没有合入对应实现的验收测试分支可运行 `harness-selfcheck`，核对模式切换、回环替身和合成设计示例。F13–F15 只在此模式运行。Vitest 的跳过项和 TODO 保留在输出里。

| 覆盖 | 本地验证入口 |
| --- | --- |
| F1–F5 | Serper/Exa 协议、持久投影回放、社会资料候选判断、抓取辖区闸门、网站法定披露、注入解析器的 DNS 信号 |
| F6–F8 | 混合语种 CSV、签名 JWT 与实际 Nest 错误合同、有限旁路活动窗口、联系人绕过装配、线索手动确认保护 |
| F9–F10 | 模拟时钟下的 worker 租约停止和退出期限，以及合成事务中的精确邮箱清理和幂等 |
| F11–F12 | 签名 JWT 注册 HTML 渠道、试跑准入、目录召回顺序、已审渠道投影、共享数据限制和按工作区去标识化的冷却记录 |

Stage C 的可信输入装配、多联系人隔离和已有回执恢复另由 `src/enrichment/safety/contact-enrichment-safety.composition.spec.ts` 测试。物理 PostgreSQL 权限和已提交通知由 `src/shared-facts/platform-shared-and-outbox-wakeup.postgres.spec.ts` 在可丢弃数据库验证。

待补运行态证据包括独立 Temporal Worker、完整租户数据库和 SaaS 投影串联，以及 Stage C 所有联系人遇到上游限流后的读取结果。正式试点数据、LIA 生效、实际渠道页面与外部服务的可用性需要各自的验证。F13–F15 的待实现场景包括 TED 买方角色准入、自动注册监测、独立买方 PDF 接口及其边界检查。
