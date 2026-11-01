# 理解失败可见与受控重试：dev live 实测（PARTIAL）

本记录是 2026-11-02（UTC 前夜）在 xin 的 dev 环境对「企业官网理解失败可见 + 受控重试」做的 live 实测。**结论是 PARTIAL**：从失败可见到重试入队的全链已实测打通；但同一公司的第 2 次真实尝试暴露出一个既有缺陷（预算操作键缺运行/尝试维度 → remnant 重放），修复已合入 main（#726），**「重试成功跑到 REVIEW」的最终验证要等下一班镜像（含 `9351507f`）**。4 个 Temporal schedule 仍全部 paused；本记录不构成 RuntimeEvidence。

## 起因（用户可见症状）

GainOS 里 gmq@demo.cn 的「具安科技」（gianttek.cn）长期停在「待理解」。引擎侧事实：`company_profile.29905a58…` 状态 `DRAFT`、`understanding_failed_at=2026-11-01T13:53:51Z`、`understanding_last_error=extract:ProviderHttpError`——理解在抽取阶段因模型网关对 `gemini-3.8-flash` 返回 429 而失败（当天 00/05/21 点各一波 429 突发），而 API 与 UI 都不展示失败、也没有重试入口。

## 交付（已上线，镜像 `08b1b30c` / `fdb54595…`）

- 后端 #722（`65f9ba38`）：`GET /companies` 返回 `understandingFailedAt`/`understandingLastError`；新增 `POST /companies/:companyId/understanding/retry`（只允许「最近一次失败、仍为 DRAFT」；必须带新签 workspace Grant，quote operation `POST /companies/:companyId/understanding/retry`、purpose `understanding.run`；成功后重新入队 understandingWorkflow）；understanding 模型活动重试 3→5 次、5s 起指数退避（最长 60s）。
- GainOS #27（`f24806b`）：BFF 重试路由（member + grant:true）+ 界面失败徽标/错误标签/「重试理解」按钮。
- 发布与切换由并行发布线完成（`_archive/backend-runtime-switch-08b1b30c-xin-20261101/`）；本会话只在切换后做只读核验与实测。

## 实测（2026-11-02 01:38–01:41 +08）

1. 失败可见：`GET /api/v1/companies/29905a58…`（gmq 的 workspace 令牌）返回 `status=DRAFT`、`understandingFailedAt=2026-11-01T13:53:51.282Z`、`understandingLastError=extract:ProviderHttpError`。
2. 预算链路：`POST /execution-budget/workspace-technical-quote`（operation 为重试）→ 200，`requiredCapMicrousd=5870000`、purpose `understanding.run`；用 gain-saas `EngineBudgetGrantSigner` 签 Grant。
3. 重试：`POST /companies/29905a58…/understanding/retry`（`X-Execution-Budget-Grant`）→ **202**；随后轮询 `GET /companies/:id`：状态 `DRAFT → ENRICHING`，失败字段清空（工作流确实重新入队并在跑）。
4. **暴露缺陷**：该次 run（`01a19830-f7a3-7699-8533-71a2c6a5ff6d`）里，`extractClaims`/`extractOfferings` 第 1–2 次 attempt 是真实 429；第 3 次起全部以 `BudgetOperationReplayError`（`origin=remnant`，`BUDGET_OPERATION_REPLAY_UNAVAILABLE`）失败，工作流最终失败并写回 `extract:BudgetOperationReplayError`。根因：模型付费操作键（`paidOperationKey`，含 `context.correlationId`）在理解活动中没有运行/尝试维度——第一次失败后预算行以 `RELEASED` 保留（`tool_budget_operation` 两行 `17:39:30Z`、account `understanding.run:company:29905a58…:<requestSha>`），后续 Temporal attempt（乃至同一公司的下一次重试 run，accountKey 不变）在 `reserve_tool_budget` 时被判为「已有操作且无 durable result」的 remnant。**即：修复前，这家公司与同操作参数下的任何重试都会在两次真实尝试内失败，429 退避也被架空。**
5. **修复**：#726（`9351507f`，已合入 main、待下一班镜像）：理解活动为模型调用与 crawl broker 传入 `correlationId=<workflowRunId>:<activityId>:a<attempt>`，每次真实尝试各用独立预算操作键；同一 attempt 内仍幂等。
6. 旁证：实测后单独发起一次更大的 `gemini-3.8-flash` 请求返回 200，429 属瞬时突发（与并发验收 run 的负载相关），非当日配额耗尽。

## 边界与后续

- 最终验证（重试成功后 `status=REVIEW`、失败字段保持清空、无 remnant 错误）推迟到下一班含 `#726` 的镜像；届时回写本记录并将其状态改为 PASS/PARTIAL 的最终结论。
- 其它域的模型活动（discovery / icp / outreach 等）存在同类「操作键无运行维度」风险，需逐域评估后单独处理（#726 未扩大范围）。
- 4 个平台 schedule 仍 paused；本记录不 unpause、不改策略、不构成 RuntimeEvidence。

## 复现要点

以目标 workspace 的引擎令牌取 quote（operation 如上）→ 用 gain-saas 签名钥签 Grant → `POST /companies/:companyId/understanding/retry` 带 `X-Execution-Budget-Grant` → 轮询 `GET /companies/:id` 观察 `DRAFT→ENRICHING→REVIEW`；旁路证据看 worker 日志的 activity 错误与 `tool_budget_operation` 行状态。
