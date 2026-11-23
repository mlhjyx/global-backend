---
date: 2026-11-24
pr:
title: Lock A08 safety rows through scoped definer functions
---

- 起因：A08 联系人补强安全链首个真实 admitted 执行返回 500。安全切片共有 13 处 `SELECT ... FOR UPDATE`，但 `app_user` 对执行预算与安全切片表没有表级 UPDATE（`execution_budget_authority`/`tool_budget_account` 仅 SELECT；`contact_enrichment_execution`/`_step` 仅 SELECT/INSERT 加部分列级 UPDATE），真实 PG 在 authority 处即 `permission denied`。既有消费/开户函数是 SECURITY DEFINER 模式，安全切片自己重写了锁行。
- 改动：新增迁移 `20261124010000_safety_lock_definer_functions`，提供窄 SECURITY DEFINER 锁函数：authority、account、operation、execution（按 id+company 与按请求身份两种）、step（按 step 或 contact）与 execution+step 锚点。所有函数强制参数 workspace = `current_workspace_id()`、只锁同 workspace 行并只返回调用方所需列，仅授予 `app_user` EXECUTE，不授予任何表级 UPDATE/DELETE。`admitInTransaction`、`withLockedStep`、`claimStepBeforeWire`、结算索引与 SQL 域提交存储的 13 处 raw FOR UPDATE 改为调用这些函数；`canonical_contact`/`contact_point` 本来就是 app_user 可写表，保持原锁不变。
- 测试：真实 PostgreSQL 以 app_user 连接验证——成功 admission（PREPARED 头与步骤落库）、withLockedStep 全链绑定步骤（authority/account/anchor/step/operation 锁）、最小权限（两预算表仍仅 SELECT、直接 FOR UPDATE 仍 42501、跨 workspace 函数调用 42501）、跨租户步骤绑定拒绝、失败回滚（跨租户 contact 触发步骤外键失败后无残留头）与外来 authority 拒绝；安全切片单元 437 项与 API 构建通过；迁移在一次性 pgvector PG16 上全量 `migrate deploy` 成功。
- 未做：不改 Grant 消费/开户、限额、状态机或消费者语义；不给 app_user 增加表级写权限；不部署、不重放真实窗口；真实镜像验证在合并后由 C1 窗口重开执行。
