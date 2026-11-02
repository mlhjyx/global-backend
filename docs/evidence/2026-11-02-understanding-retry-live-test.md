# 理解失败可见与受控重试：dev live 实测（闭环）

本记录是 2026-11-02 在 xin 的 dev 环境对「企业官网理解失败可见 + 受控重试」做的 live 实测。**结论：闭环通过**——`DRAFT（失败）→ ENRICHING → REVIEW` 全链在修复后的运行时（`c034010b` / `56c55bd8`、gain-saas #29）上实测通过，理解产出（行业、简介、70 条 claims）落库，全程 0 次 remnant / 0 次授权复用错误。过程中先后暴露并修复了两层既有缺陷（#726 预算操作键缺运行/尝试维度；#730 + gain-saas #29 账户级授权复用）。4 个 Temporal schedule 仍全部 paused；本记录不构成 RuntimeEvidence。

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

## 第二层根因与修复（2026-11-02 上午）

用户在实际界面点击「重试理解」仍收到「这次授权已经使用过」（`EXECUTION_BUDGET_GRANT_REUSED`）后的深挖：

- 复现：以临时测试账号经 BFF 与引擎直连均为 409 `EXECUTION_BUDGET_GRANT_REUSED`；数据库无新 authority 行、BFF 无错误日志。
- 根因（账户层）：工作空间 Grant 的消费会把预算账户绑定到首个 authority（账户键 `purpose:subject:请求摘要`）。重试操作的请求摘要对同一公司恒定，因此同一公司的**第二次**重试必然在开户时被拒；`understanding.run` 也不在 `RETRYABLE_WORKSPACE_PURPOSES`（该集合要求旧账户从未真正派发付费调用，理解失败前通常已派发 crawl/模型调用）。本记录第一轮排障中的一次实测消耗了该公司的首个作用域，之后任何点击都撞此错——与用户账号无关。
- 修复：
  1. #730（`c034010b`）：重试端点要求 `body.attemptId`（客户端每次点击生成的新 UUID）——每次重试获得独立 requestSha256、预算账户与 authority；同一 attemptId 的重复提交仍被一次性 Grant 语义挡住（幂等）；quote 契约同步校验。
  2. gain-saas #29（`104547e`）：BFF 透传 attemptId、前端每次点击 `crypto.randomUUID()`（需 gain-saas-web 重建生效）。
  与 #726（`9351507f`，预算操作键按 run/attempt 隔离）三层一起构成完整修复。

## 终验（2026-11-02 10:03–10:10 +08，镜像 `c034010b` / `56c55bd8`，attested）

- 运行时：`/health/build` attested、build_sha `c034010b`；gain-saas-web 已含 #29。
- 经 BFF（与界面按钮相同的路径）`POST /api/companies/29905a58…/understanding/retry`，body `{attemptId: <新 UUID>}` → **202**（不再 409）。
- 状态链：`DRAFT（understandingFailedAt 非空）→ ENRICHING（失败字段清空）→ REVIEW`；抽取产出落库：industry「科研仪器与医疗器械研发制造」、中文 summary、claims 70 条（待人工审批，符合 REVIEW 语义）。
- 运行期间模型网关仍有 `gemini-3.8-flash` 429 突发（与并行验收 run 抢同一模型）；#722 的 5 次/5s 指数退避与 #726 的按尝试键使其在活动层被吸收，工作流最终完成；worker 日志中该 run 的 `BudgetOperationReplayError` 计数为 0。

## 边界与后续

- 最终验证已完成（见「终验」一节）；排障用的临时测试账号已删除。
- 其它域的模型活动（discovery / icp / outreach 等）存在同类「操作键无运行维度」风险，需逐域评估后单独处理（#726 未扩大范围）。
- 4 个平台 schedule 仍 paused；本记录不 unpause、不改策略、不构成 RuntimeEvidence。

## 复现要点

以目标 workspace 的引擎令牌取 quote（operation 如上）→ 用 gain-saas 签名钥签 Grant → `POST /companies/:companyId/understanding/retry` 带 `X-Execution-Budget-Grant` → 轮询 `GET /companies/:id` 观察 `DRAFT→ENRICHING→REVIEW`；旁路证据看 worker 日志的 activity 错误与 `tool_budget_operation` 行状态。
