# M2.2 验收证据：golden 首跑基线 + 有界重规划端到端（2026-11-08）

> 结论先行：M2.2（有界重规划与指标闭环）在**真实发车栈**上完成验收——① golden 首跑：
> 6 条 brief 全部经真实规划链路产出计划，后端闭集断言 **6/6（100%）通过**；② decline 端到端：
> 拒绝 → 自动重生成 1 次 → 仍被拒 → `NEEDS_HUMAN` 全链路通过，`replan_of_job_id`、
> 两条 `campaign.replan` 决策轨迹与引擎用量行全部如实落表；③ 指标回填数据取自上述真实运行。
> 期间暴露并修复两个真缺陷（harness 控制字符 400；durable-result 投影仍钉 `maxReplans=0`）。
>
> 环境：backend 镜像 `65c14c1c`（digest `beb58d59…`，含 #884 引擎重规划循环、#877 golden
> 跑批器、#892 投影放宽）；gain-saas main `ea191f2b`（含 #97/#99/#100）并完成 #101 补发
> （plan-drafts 携带 `maxReplans`）。金丝雀租户 `owner@demo.cn`（workspace `982c2a12…`）。

## 1. Golden 首跑基线（真实规划链路）

方法：`campaign-golden-live.ts`（gain-saas，PR #100）逐条建独立战役（`E2E-M2.2-<ts>:<brief>`）
→ `POST /plan-drafts`（真实 quote + Grant + `campaignPlanningWorkflow`）→ 轮询至终态 →
导出 `<brief-id>.plan.json`；随后 backend `pnpm campaign:golden --replay <dir>` 用闭集断言层
求值（schema 版本 / 必含 / 禁含字段 / 禁含语义 / 预算上限 / maxReplans 界 / 仅 discovery）。

首跑结果（2026-11-08 11:15 UTC）：

| brief | 终态 | sizeCap | budget.capMicros | 备注 |
| --- | --- | --- | --- | --- |
| 01-de-thermoforming-medical | SUCCEEDED | 568 | 150000000 | 预算与 brief 上限一致 |
| 02-de-thermoforming-automotive | SUCCEEDED | 568 | 250000000 | 同上 |
| 03-us-electronics-ems | SUCCEEDED | 568 | 300000000 | 同上 |
| 04-us-electronics-industrial-controls | SUCCEEDED | 6 | （未给） | 可选字段省略，合法 |
| 05-de-industrial-parts-hydraulics | SUCCEEDED | 250 | 180000000 | 两个 ICP |
| 06-de-industrial-parts-bearings | SUCCEEDED | 24 | （未给） | — |

Replay 断言（`campaign:golden --replay`，闭集词汇）：

```
- 资产：6 条 · 通过：6/6（100%）
| 01… | ✅ |  | — |   | 02… | ✅ |  | — |   …（六条全 ✅，无 diff）
```

六条计划均为 `campaign-plan/v0`、`motions=[discovery]`、`maxReplans=0`（未请求重规划预算的
默认回声），无任何发送/单证语义。运行后金丝雀战役已按约定清理（ID 见下表，可回溯日志）。

## 2. decline → replan → NEEDS_HUMAN 端到端（真机）

脚本按金丝雀租户走控制面公开 API（`E2E-M2.2-decline-e2e-<ts>` 战役，`maxReplans=1`）：

1. `POST /plan-drafts {maxReplans:1}` → job1 `SUCCEEDED`，计划 `decisionPolicy.maxReplans=1`
   （计划原样回声请求预算）。
2. `POST revisions/:id/submit` → `POST approvals/:id/decide {decline, reason}` →
   系统**自动创建** replan job（`replan_of_job_id=job1`），`maxReplans-1=0` 轮校验反馈预算、
   携带 `previousPlan` 与 500 字内拒绝理由（引擎 round 0 = `HUMAN_DECLINE`）。
3. job2 `SUCCEEDED`；再次提交+拒绝 → job2 转 `NEEDS_HUMAN`（`CAMPAIGN_PLAN_NEEDS_HUMAN`），
   **不再生成第三个 job**；轨迹 `campaign.replan.triggered` → `campaign.replan.exhausted`。

取证运行（保留至指标取证后清理）：战役 `004337d7-…`、job1 `b275820f-…`、job2 `40e6930d-…`；
断言输出 `{"plan1MaxReplans":1,"job2State":"NEEDS_HUMAN","jobCount":2,
"replanTraceSteps":"campaign.replan.triggered,campaign.replan.exhausted","replanRounds":2}`。
另一次同流程运行（战役 `87b4f3a0-…`）同样通过并即时清理。

## 3. 指标回填（取自上述真实运行）

- 审批：该战役 `campaign_approval` = 2 × `DECLINED`（通过率 0/2；分母=通过+拒绝+过期）。
- 重规划轮次分布：`campaign_decision_trace` 中 `decision_type='campaign.replan'` = 2
  （triggered + exhausted），与该战役 2 个 job 的 1 轮自动重生成一致。
- 每通过计划成本：引擎 `usage_ledger` 中该战役 2 行（`meta.task='campaign.plan'`、`runId`
  第三段=战役 id），合计 $0.02 → 20,000 micros；因无通过计划，`costPerApprovedPlan` 为空
  （口径按设计 §5，不伪造 0）。查询形状即 #96 修正后的实现
  （`meta.task='campaign.plan' AND meta.runId='campaign.plan:campaign:<id>:<hash>'`）。
- 人工修改距离：本战役无批准版本，无现场样本；结构化叶子 diff 逻辑由单测覆盖
  （零修改通过=0 等），运营台「战役指标」页签已上线（#97）。

## 4. 验收中发现并修复的缺陷

1. **harness 控制字符**（gain-saas #102）：objective 用换行拼接 ICP 摘要，引擎入口拒绝
   ASCII 控制字符 → 首跑 6/6 400 `CAMPAIGN_PLAN_REQUEST_INVALID`；改括号拼接后 6/6 成功。
2. **durable-result 投影钉死 maxReplans=0**（backend #892，替代我最初的 #894）：#884 放宽
   任务契约后，投影层 `campaign-plan/v1` 仍 `enum [0]`，带重规划预算的计划在网关 fail-closed
   （`MODEL_DURABLE_RESULT_PROJECTION_REJECTED`）；放宽到 0–2 并补正反用例、边界快照。

## 5. 边界与清理

- 本证据覆盖「计划 → 审批/拒绝 → 有界重生成 → 需人工」与四指标的取数口径；产物仅草稿
  revision 与轨迹，**未执行任何对外动作**（影子期不执行，D-M2.1-c）。
- 恢复/会议率指标按设计预留（步 12 归因），不在本轮。
- 金丝雀战役（6 条 golden 运行 + 2 条 decline 运行）在取证后全部清理；引擎用量与
  `campaign_plan_job`/`campaign_decision_trace` 的历史行为审计事实保留（append-only 轨迹
  按租户删除随战役级联，本文记录其取值）。
