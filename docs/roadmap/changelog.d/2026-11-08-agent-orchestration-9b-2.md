---
date: 2026-11-08
title: Role-ify the source scout at the discovery fan-out with source.route traces (M2 step 9b-2)
---

- 起因：M2 步 9b 第 2 步——把 discovery `executeQuery` 的多源 fan-out 包成「源侦察员」agent 回合：选源决策落 `source.route` 轨迹（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - `executeQuery` 回合门：经 agent 注册表解析 `discovery.source_scout`，未注册/平台停用即 `AGENT_NOT_REGISTERED` / `AGENT_DISABLED` nonRetryable（fail-closed，run 按既有失败语义走）；未接线 `agentRuntime` 的环境保持旧行为。
  - 路由点写一条 `source.route` 轨迹：`chosen_option`=本次路由到的源（含 source_class）；`rejected_candidates`=已注册但未路由的同类源及原因（LEASE_STOP / SOURCE_LINEAGE_UNAVAILABLE / SOURCE_DISABLED / SOURCE_HINT_INVALID / SOURCE_HINT_EXCLUDED，可复活）；discriminator=既有 queryKey（旧回执形状用查询内容哈希兜底），重试不翻行。
  - worker 与 dev fast lane 注入 DB agent 解析器与决策轨迹 store（目录由 managed worker/relay 启动期 seed）。
- 零行为变化：轨迹写入发生在既有路由决策之后、fan-out 之前，召回/评分/预算/重试语义不动；轨迹写失败与既有回执同源的 at-least-once 语义一致。
- 测试：discovery activities 套件新增 5 例（chosen/rejected 内容、hint 排除、零路由 skip reason、AGENT_DISABLED/AGENT_NOT_REGISTERED fail-closed 且 provider 零调用）；worker 接线源级守卫；既有 314 例不回退。
- 未做：golden mini-run 与 E2E-9b 随 9b-2/3/4 全部合入并发车后按设计 §9 执行（需要产品负责人的发车指令）；资格判定员角色化在 9b-3。
