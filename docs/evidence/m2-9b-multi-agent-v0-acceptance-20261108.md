# M2 步 9b 多 agent 编排 v0 · 发车后验收证据（2026-11-08）

范围：dev 环境的发车后真实验收观测（真实数据源、真实模型网关、真实 Temporal 平台）。这不是生产 UAT、Release Bundle 或 Pilot/GA 批准；受当日上游故障影响，各轮 run 按「证据优先」短跑取证（状态如实标注），轨迹语义证据完整，未追求每轮 500 家池跑满。设计依据：[2026-11-08-multi-agent-orchestration-v0.md](../superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md)（APPROVED）。

## 部署绑定

| 项 | 观测值 |
| --- | --- |
| 引擎镜像（验收时） | `ghcr.io/mlhjyx/global-backend@sha256:a2889542c8a2435fdcdbd8a7c01d0071fd5bd3cbf85be613be7adcd851bab13a`（build `e6e579d4`，attested） |
| 收尾班车 | backend `4fce438e`（含全部 9b 引擎改动） |
| 迁移 | `20261108160000_agent_orchestration_v0`（additive；两表 FORCE RLS 已核验 `relrowsecurity=relforcerowsecurity=t`） |
| seed | worker/relay 启动幂等播种：历次重启均 `agent catalog seed ok (2 agents, 0 new)` |
| ops 注册表 | `GET /api/v1/ops-agents`：`discovery.source_scout`、`discovery.qualifier` 均 ACTIVE |
| 运行开关 | `DISCOVERY_RUN2_QUICK_SCAN=on`（为 9b-3 取证由主会话翻转，env 带日期注释与回退说明）；`ACQ_LLM_CACHE` 默认 on |
| 代码合并 | 引擎 #870（9b-1）、#878（9b-2）、#879（9b-3）、#880（9b-4）；SaaS mlhjyx/gain-saas#88（「过程」时间线） |

## 一、决策轨迹行（线上真实数据）

### source.route（源侦察员，旧版管线 run `b960dda9`，共 13 条，与 13 条查询回执一一对应）

```json
{"stepType":"discovery.query","agentKey":"discovery.source_scout","decisionType":"source.route",
 "discriminator":"<既有 queryKey>",
 "chosenOption":{"sources":["directory"],"sourceClass":"industry_data"},
 "reasonCode":null,
 "rejectedCandidates":[
   {"candidateRef":"public_web","rejectReason":"SOURCE_HINT_EXCLUDED","revivable":true},
   {"candidateRef":"wikidata","rejectReason":"SOURCE_HINT_EXCLUDED","revivable":true},
   {"candidateRef":"openstreetmap","rejectReason":"SOURCE_DISABLED","revivable":true},
   {"candidateRef":"trade_fair","rejectReason":"SOURCE_HINT_EXCLUDED","revivable":true}]}
```

另在 `78dd56fe`（PARTIAL，单 run 双角色合并样本）7 条、`2e85c76e`（停用生效前缓存窗口）4 条；各条与 `stats.perQuery` 回执的 queryKey 一一对应。

### fit.judge（资格判定员，Run 2.0 quickScan；`aae4a06a` 50 批/400 家 + `d0adabec` 14 批 + `78dd56fe` 3 批，共 67 批）

```json
{"stepType":"discovery.quick_scan","agentKey":"discovery.qualifier","decisionType":"fit.judge",
 "discriminator":"batch:<sha256(jobIds).slice(40)>",
 "chosenOption":{"judged":8,"verdicts":{"mismatch":8},"batchSize":8},
 "rejectedCandidates":[
   {"candidateRef":"<companyUUID>","rejectReason":"VERDICT_MISMATCH","revivable":true}, "…"]}
```

`aae4a06a` 的 verdict 分布：47 批 `{"mismatch":8}`、2 批 `{"weak":1,"match":1,"mismatch":6}`、1 批 `{"weak":1,"mismatch":7}`。被否候选只存公司 UUID，无个人数据。

## 二、每 agent / task 的用量归属（usage_ledger 按 run 账户拆分）

| run 账户 | task | model | 次数 | cost USD |
| --- | --- | --- | --- | --- |
| 德工业 `b960dda9`（旧版管线，≈$2.19） | discovery.classify_trade_role | deepseek-flash | 31 | 0.310 |
| | discovery.extract_company | deepseek-flash | 134 | 1.340 |
| | discovery.extract_list | deepseek-flash | 3 | 0.040 |
| | discovery.qualify_fit（深挖路径） | deepseek-v4-pro | 44 | 0.430 |
| | discovery.qualify_fit（深挖路径） | gemini-3.8-flash | 7 | 0.070 |
| 德吸塑 `d0adabec`（quickScan，资格判定员回合） | discovery.qualify_fit | gemini-3.8-flash | 19 | 0.200 |

口径：`fit` 统计有两种来源——深挖 `judgeFitCompany`（旧路径）与资格判定员 `quickJudgeBatch`（只有后者落 `fit.judge` 轨迹）。当日上游故障期曾把 `discovery.qualify_fit` 降档 deepseek-v4-pro，恢复后回到 gemini-3.8-flash 原生档；上表按模型行区分时点。

## 三、负向对照（设计 §8，线上实测）

| # | 项 | 线上结果 |
| --- | --- | --- |
| 1 | 未注册 agent 不可运行 | `AgentUnavailableError: AGENT_NOT_REGISTERED`（解析器 fail-closed；单测 + 真库套件，线上无未注册行可造场景） |
| 2 | 平台 DISABLED → 回合 fail-closed | `PATCH /api/v1/ops-agents/discovery.source_scout/status {"status":"DISABLED"}` 后新 run 在 `resolveAgentRound → executeQuery` 抛 `ApplicationFailure: AGENT_DISABLED, nonRetryable: true`（**13ms** 失败、无新增抓取/模型调用）；随后恢复 ACTIVE |
| 3 | 技能平台停用 → 轨迹 `SKILL_PLATFORM_DISABLED` | 单测与真库套件覆盖（轨迹先落 reason_code 再上抛）；线上未制造技能停用 |
| 4 | 轨迹无 UPDATE/DELETE 路径 | `SET ROLE app_user`：UPDATE/DELETE `agent_decision_trace` 均 `permission denied`；授权矩阵 insert=t/select=t/update=f/delete=f；`agent_profile` insert=f、仅状态列 UPDATE=t |
| 5 | 跨租户读 trace → 404 | 另一 workspace 的租户 token 读 `GET /runs/:runId/trace` → `404 NOT_FOUND`（不泄露存在性） |
| 6 | 同 (run,step,discriminator) 重放不翻行 | 全表重复键检查 **0**（含容器重建引发的活动重试期） |

## 四、租户 trace 端点实测（`GET /api/v1/runs/:runId/trace`）

- 同租户 200：返回完整行（`id/stepType/agentKey/actorType/attempt/decisionType/chosenOption/score/reasonCode/evidence/rejectedCandidates/cost*/createdAt`），含 `fit.judge` 与 `source.route` 两类；`{data, page:{next_cursor,has_more}}` 键集分页。
- 非法 cursor → `400 VALIDATION_ERROR`；跨租户 → `404`（见负向 5）。

## 偏差与口径（如实记录）

- 「各 2 轮完整 DONE」未达成：当日 tbtk 中转整站故障（渠道 2/3/4 全挂）曾使 worker 以 `MODEL_GATEWAY_UNAVAILABLE` 排空两次（按 RUNBOOK §14 处置恢复），wikidata 429 在并发验收下造成 canonicalize 活锁（取消重开），quickScan 单批 2–5 分钟。各轮以「查询回执齐全 + 足量 fit.judge 批次」为取证完成线后取消或自然收口（`b960dda9`/`d0adabec` 取消→FAILED、`aae4a06a` FAILED、`78dd56fe` PARTIAL、`2e85c76e` 为负向 2 专用失败轮）。
- `aae4a06a` 于 400 家规模快扫时以 `BudgetOperationReplayError / BUDGET_OPERATION_REPLAY_UNAVAILABLE` 失败——预算账本 replay 边界问题（与 B4/#882 同域），非 9b 轨迹/角色代码问题；快扫 50 批轨迹完整保留。建议整改线纳入观察。
- 现场停用类取证会影响共享 worker 上的并发 run（需先与主会话协调窗口）；本次曾误伤一条并发验收 run，已复盘。
- 上游健康时可补跑完整 DONE 轮次作为长期基线，无需代码变更。

## 增补：长期基线轮（2026-11-08 晚，镜像 `beb58d59`，含 #892 投影修复）

- 补跑基线 run `9f932c42`（德吸塑 ICP，plan `fbaa08b6`，full 模式，quickScan on），~30 分钟终态 **PARTIAL**：
  - quickScan：池 674 家、候选 469、判定 469（match 1 / weak 5 / mismatch 463），规则预筛出局 31、逐家降级 16、leads 6；
  - 深挖：目标 6 家、5 成 1 败 → PARTIAL（个别深挖失败属上游，非 9b 语义问题）；
  - 轨迹：`fit.judge` **59 批**（54 批纯 mismatch，其余含 weak/match）；本 run 走 Run2.0 池直判路径，查询段为空故无 `source.route`；
  - 归属：`discovery.qualify_fit`（gemini-3.8-flash）63 次 / $0.560。
- 取证合计入账：`fit.judge` **126 批**（验收 67 + 基线 59）、`source.route` 24 条。基线可在上游健康时重复，无需代码变更。

## 引用

- 设计：[2026-11-08-multi-agent-orchestration-v0.md](../superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md)
- PR：mlhjyx/global-backend [#870](https://github.com/mlhjyx/global-backend/pull/870) [#878](https://github.com/mlhjyx/global-backend/pull/878) [#879](https://github.com/mlhjyx/global-backend/pull/879) [#880](https://github.com/mlhjyx/global-backend/pull/880)；mlhjyx/gain-saas [#88](https://github.com/mlhjyx/gain-saas/pull/88)
- 运行手册：`local-config/RUNBOOK.md` §14（worker 排空与自动恢复）
