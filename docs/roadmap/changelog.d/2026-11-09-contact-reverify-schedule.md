---
date: 2026-11-09
title: Daily contact re-verification schedule reusing the sweep core
---

- 起因：P1-19 需要把存量邮箱重验队列（迁移回填的 UNKNOWN、VALID 90 天 TTL、catch-all 复检）从「人工 CLI」升级为周期任务；CLI 的取数/落库逻辑原先只在脚本里，Schedule 无法复用。
- 改动：
  - 再验证核心从 `apps/api/scripts/reverify-contact-points.mts` 提到 `apps/api/src/enrichment/verification/reverify-sweep.ts`（取点/suppression/合规门/限流/幂等/事件账/状态机全部同源），CLI 只留参数解析与单次执行；新增每轮成本上限 `maxCostMicrousd`（达到即停、候选保持 due）。
  - 新 Schedule `contact-reverify-sweep`（默认 24h，`CONTACT_REVERIFY_SWEEP_EVERY` 可调）+ `contactReverifySweepWorkflow` + `createContactReverifyActivities`（owner 连接，复用 sweep 核心；每轮 ≤500、供应商限流默认 2/s、成本上限默认 $5/轮）。
  - **注册即 paused**：启用是运维决定（`data_provider.millionverifier=ENABLED` + `MILLIONVERIFIER_API_KEY` + 成本 cap）；未启用时活动三重门任一不满足即返回 `skipped`、零调用零成本。已存在的 Schedule 只 reconcile action，不动暂停状态。
- 测试：活动边界 spec（kill switch / source_policy 未登记 / 凭据缺失 → skipped 零调用；门全过 → ran 且有界）；sweep 成本上限用例；ensure-schedules spec 更新为 13 个 Schedule 并断言新条目 24h + 默认 paused。
- 未做：翻转率周报指标（P1-17）；把本 Schedule 纳入平台预算 authority（启用时若需平台自动化预算，再按 P1-11 的 Grant 方案迁移）。
