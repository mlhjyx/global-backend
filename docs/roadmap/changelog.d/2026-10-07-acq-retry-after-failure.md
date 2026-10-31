---
date: 2026-10-07
title: Retry an ICP request only when no earlier attempt reached a provider
---

- 起因：一次 ICP 设计或查询计划请求开过预算账户后，同一公司/ICP 再也无法重试——账户键由请求决定，第一次请求把它永久绑在第一把 Grant 上，之后每把新 Grant 都 409 `EXECUTION_BUDGET_GRANT_REUSED`。
- 改动：新增 `execution-budget-retry-account` 判定，只对 `icp.design` 与 `icp.query_plan` 生效：仅当之前每次尝试都在派发前释放（`RELEASED`）或从未开户、且对应 Grant 已过账本 60 秒容差时，才允许用派生键 `原键:retry:<authority id>` 开户重试；已结算或结果未知一律不换户。换户在账本锁内进行，且先强制关闭仍开着的旧账户，排队中的预留会失败而不是花钱。绑定校验只接受派生键（原键或追加自身 authority id），其余一律拒绝。CI 的 Postgres 步骤显式运行新的真库测试。无数据库迁移。
- 测试：重试判定单测 13 项；`src/execution-budget` 412 项全过；真库测试 5 项（一次性 Postgres 容器，以 app_user 在 RLS 下执行）连续 5 次通过；五项变异检查各自变红；全量单测通过（唯一失败为已登记负载假红，单独复跑通过）。并入 main 后由 CI 复跑真库步骤。
- 未做：未改 `changelog.md` 本体（按新规走本片段）；未部署，随下一次镜像班次生效。
