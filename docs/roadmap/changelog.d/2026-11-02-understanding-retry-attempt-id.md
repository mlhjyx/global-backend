---
date: 2026-11-02
title: Give each understanding retry its own attempt-scoped grant account
---

- 起因：live 实测发现同一公司的第二次「理解重试」必失败：工作空间 Grant 消费会把预算账户绑定到首个 authority（`purpose:subject:requestSha`），而重试操作的请求作用域对同一公司是恒定的，于是第二次重试在账户层被判 `EXECUTION_BUDGET_GRANT_REUSED`（`consume_workspace_execution_authority` 正常、随后开账户被拒；`understanding.run` 也不在 `RETRYABLE_WORKSPACE_PURPOSES` 的安全重试账户集合里，且该集合要求旧账户从未真正派发付费调用，不适用于理解重试）。
- 改动：重试操作的作用域加入 `body.attemptId`（客户端每次点击生成的新 UUID）——每次重试获得独立的 requestSha256、独立预算账户与独立 authority；同一 attemptId 的重复提交仍被 Grant 一次性语义挡住（幂等）。quote 端点同步校验 `attemptId`（uuid、exact keys），OpenAPI 请求体 schema 更新。
- 测试：request-scope/quote/envelope/service 规格更新；与 gain-saas 侧（BFF 传 attemptId、前端每次点击生成）配套。
- 未做：不把 `understanding.run` 加进 `RETRYABLE_WORKSPACE_PURPOSES`（那会放宽"旧账户未派发付费调用"的安全前提，与本修复无必要重叠）。
