---
date: 2026-10-30
title: Read the latest outreach draft and consume a workspace grant only after the request's own checks
---

- 起因：GainOS 验收发现两个引擎侧缺口——(1) 没有读取已有开发信草稿的接口，刷新/换设备后看不到历史草稿；(2) 受控端点先消费一次性 Grant 再做业务前置校验，同一请求被 422/404 拒绝后重新取 Grant 也会撞 `EXECUTION_BUDGET_GRANT_REUSED`，失败即无法重试。
- 改动：
  - 新增 `GET /leads/{leadId}/outreach-drafts`（`acquisition:read`），返回该线索最新一版草稿（无草稿时 `data=null`，契约按 nullable 标注）。
  - 受控端点改为「先验证 Grant → 跑业务前置校验 → 才消费」：`ExecutionBudgetAuthorityService` 新增 `consumeVerifiedWorkspaceGrant`，ICP 设计、查询计划与开发信草稿三处接入；被拒绝的请求不再烧掉一次性 Grant。
  - 开发信草稿生成默认幂等：该线索已有草稿时直接返回最新版、不再调用模型也不消耗 Grant（覆盖浏览器超时/关页后的重试）；请求体新增可选 `regenerate: true` 显式要求重新生成（版本号 +1，调用方须自备新的 Grant）。
- 测试：outreach 草稿服务新增「返回旧草稿不消费」「regenerate 生成新版本」「先校验后消费」用例；ICP 设计/查询计划相应断言更新；迁移无。
- 未做：G5（租户侧线索/公司详情去 `personal-data:read`）是产品口径决定，未包含；PR #597 的重试语义未采用（本改动取代它）。
