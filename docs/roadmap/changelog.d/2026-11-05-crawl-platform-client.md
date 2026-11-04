---
date: 2026-11-05
title: Platform-automation Temporal client identity for the engine API (P4-P4b)
---

- 起因：P4 抓取运行的编排在 platform-automation 命名空间，但 API 进程只有 default 命名空间的 Temporal 客户端；平台授权器虽已内置 schedule-writer 身份（RoleWriter + `platform-automation:write`），却没有任何签发方。
- 改动：机器 token 增加 `temporal-platform-client` 档案（gain-saas 同批 #65，permissions 与授权器身份逐字一致）；引擎侧 `machine-token-runtime` 为该档案要求独立的证书三件套与主体（`TEMPORAL_PLATFORM_CLIENT_{CA,CERT,KEY}_FILE`/`_SUBJECT`，**绝不回退**到 API 进程的 customer-client bootstrap 材料）；新增 `PlatformTemporalClient`（namespace `platform-automation`、task queue `understanding`，只暴露受约束的 `startWorkflow`，失败一律收敛为 `PLATFORM_TEMPORAL_UNAVAILABLE` 并在下次调用重连）。授权器无需改动（既有 ScheduleWriterSubject 直接生效），Temporal 镜像不变。
- 测试：`platform-temporal.client.spec`（工作流启动参数、非法标识、按需重连、失败收敛与连接丢弃）；`machine-token-runtime.spec`（平台客户端档案缺自有配置时 fail-closed）；机器 token 客户端/验证器列入新档案；相关面 5 文件 / 54 用例全绿。
- 未做：抓取工作流本体与 `requestCrawl` 的 409 切换（P4-P4c）；证书签发是部署动作（r4-pki，CN=`platform-temporal-schedule-writer`），RUNBOOK 已记步骤要点；本 PR 不改变任何现有连接的身份。
