---
date: 2026-11-05
title: Per-request egress fence for platform channel-crawl runs (P4-P4a)
---

- 起因：P4 最后一段的第一块——`platform.channel_crawl` 的 Grant 已能签发与摄入（P1/P3），但平台出网围栏（4D authorize→claimSend→ACK/UNKNOWN）全链只认 4 个 schedule（绑定校验器、Prisma 端口、SQL 函数与围栏表主键），渠道抓取无法物理发出任何请求。
- 改动：新增并行围栏面——能力围栏表 `platform_egress_capability_fence`（`channel-crawl` 行，默认 ACTIVE 但**未发布指纹时 fail-closed**）、专用尝试表 `platform_channel_crawl_egress_attempt`、owner-only 的 `install_platform_egress_capability_policy_v1`（发布 reviewed-v3 工件与 channel_crawl 小节指纹，代际切换会阻断旧代 AUTHORIZED 尝试）、两段 CAS `authorize/claim_platform_channel_crawl_egress_send_v1` 与 `lock_platform_channel_crawl_egress_budget_v1`（同一账户咨询锁 + 权威/撤销/过期/已预留预算复检 + 账户键 `platform:<requestSha>:<crawlRunId>`）、crawl 尝试的 ACK/UNKNOWN 函数；全部 SECURITY DEFINER、`search_path` 以 pg_temp 结尾、仅 `execution_budget_platform_writer` 可执行，schedule 围栏与函数一字节未动。TS 侧：`PlatformEgressBinding` 扩为 schedule/crawl 联合（crawl 走 `subjectKind:'source_channel'`，绑定 channelId+crawlRunId+requestSha）、`PlatformEgressFence` 按绑定分派 crawl 的 ACK 转换、`CurrentPlatformChannelCrawlPolicy` 投影（指纹=e22cfd85…，工具固定 `crawl4ai.render@1.0.0`，单次预留取该工具估价）、Prisma 端口 crawl 分支。
- 测试：迁移静态契约 5 用例；fence 绑定/投影单测 20 用例（crawl ACK 分派、非法绑定、缺 crawl 转换 fail-closed、crawl 投影负向）；`platform-authority` + `execution-budget` + `security-definer-search-path` 96 文件 / 1616 用例全绿。一次性库实测：安装/重放、crawl 摄入开账户、零价预留、authorize→claim→ACK、策略漂移拒绝、代际切换把旧 AUTHORIZED 置 BLOCKED、撤销后 fail-closed、schedule 围栏仍 4 行零变化。
- 未做：抓取工作流/活动与 `requestCrawl` 409 切换（P4-P4c）、API 进程的 platform-automation Temporal 客户端与 gain-saas 客户端权限（P4-P4b）；围栏指纹由运维经 gain-saas 安装流程发布（默认 DENIED/未发布即拒发）。
