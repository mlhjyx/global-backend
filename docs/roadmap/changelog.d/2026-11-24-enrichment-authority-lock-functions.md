---
date: 2026-11-24
pr:
title: Lock A08 safety rows through scoped definer functions
---

- 起因：A08 联系人补强安全链首个真实 admitted 执行返回 500。真正缺权限的是三张预算表（`execution_budget_authority`/`tool_budget_account`/`tool_budget_operation` 对 `app_user` 仅 SELECT），共 6 处锁语句在原 FOR UPDATE 处被拒；`contact_enrichment_execution`/`_step` 已有列级 UPDATE，7 处原生行锁按 PG 规则仍合法，不迁入 definer。
- 改动：新增迁移 `20261124010000_safety_lock_definer_functions`，按设计固定签名提供三个“纯锁不消费”SECURITY DEFINER 函数：`lock_contact_enrichment_authority_v1(workspace, authority)`、`lock_contact_enrichment_account_v1(workspace, authority, account_key)`、`lock_contact_enrichment_operation_v1(workspace, account, generation, operation_key)`。函数为 public/plpgsql/VOLATILE/owner=global，`SET search_path=pg_catalog,public,pg_temp`，强制 workspace = `current_workspace_id()`、session_user=app_user 且未 SET ROLE，只锁同 workspace 行并只返回调用方所需列；`REVOKE ALL FROM PUBLIC` 后仅 `GRANT EXECUTE TO app_user`，不授予表级写权限、不续期/不消费/不改账。`admitInTransaction`、`withLockedStep`、`claimStepBeforeWire` 与 SQL 域提交存储的 6 处预算表锁改为调用这些函数；composition 的 execution+account 联合锁拆成 account 窄锁 + execution 原生锁并在锁后重读比对；`canonical_contact`/`contact_point` 与 e/s 原生锁保持不变。
- 测试：真实 PostgreSQL 以 app_user 连接验证——基线反证（三张预算表裸 FOR UPDATE 均 42501；execution/step 表级 UPDATE=false 但列级 UPDATE=true 且裸行锁成功）、成功 admission（PREPARED 头与步骤落库）、withLockedStep 全链绑定与 claim（authority/account/operation 窄锁）、最小权限（函数仅 app_user EXECUTE、PUBLIC 无执行权）、跨 workspace 函数调用 42501、SET ROLE 拒绝、跨租户步骤绑定拒绝、失败回滚（跨租户 contact 触发步骤外键失败后无残留头）与外来 authority 拒绝；安全切片单元 437 项与 API 构建通过；迁移在一次性 pgvector PG16 上全量 `migrate deploy` 成功。
- 未做：不改 Grant 消费/开户、限额、状态机或消费者语义；不给 app_user 增加表级写权限；不部署、不重放真实窗口；真实镜像验证在合并后由 C1 窗口重开执行。
