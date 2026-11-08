# M2 步 9 · M2.2 有界重规划与指标闭环落地设计（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：按 §0.6 任务启动门产出；产品负责人 2026-11-08 已批准 D-M2.2-a~f 按推荐值（golden 样板取德吸塑/美电子/德工业各 2）；依据协调计划 §0.2 步 9（M2.2：有界重规划 ≤2–3 轮 + golden set 10–20 brief + 指标：审批通过率/每通过计划成本/执行后回复与会议率/人工修改距离）、§0.7 F1/F2/F3（北极星 cost per positive outcome、决策轨迹、记忆层探索流量）。主会话起草（2026-11-08）。
> 前置依赖：M2.1 实施（campaign.plan 工作流与审批 UI，进行中）；记忆层 v0（已上线）；usage_ledger/cost_ledger（已有）。**注意：执行后回复/会议率指标依赖步 11/12 的受控触达与归因；M2.2 先把「计划→审批」段的指标闭环建成，回复/会议率接入位预留。**

## 1. 背景与目标

- M2.1 交付「单回合计划生成 + 人工审批」。M2.2 让规划器**在受控边界内迭代**（看到校验错误或人工拒绝意见后最多重规划 2 轮），并用 **golden brief 集**与**指标**把计划质量从「人工感觉」变成「可度量」。
- 北极星口径（F1 已批）：**cost per positive outcome / pipeline per dollar**，不用发送量/回复率当北极星；M2.2 期北极星代理指标＝每通过计划成本 + 人工修改距离 + 审批通过率；回复/会议/成交率在步 12 归因接齐后并入。

### 目标（M2.2 验收口径）

1. **有界重规划**：同一 job 内 ≤2 轮重规划（总计 ≤3 次生成），每轮成本与原因可查；超界即停并转人工。
2. **Golden Set**：10–20 条 golden brief（产品负责人定内容域），可一键跑批，输出通过率与逐条 diff；成为 planner 改动（prompt/模型/技能版本）的回归门。
3. **指标闭环**：审批通过率、每通过计划成本、人工修改距离、重规划轮次分布四指标在 ops 归因页可视化；回复/会议率接入位（步 12 后启用）。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | 重规划发生在**同一 campaignPlanningWorkflow 内**（循环活动，非新工作流）：输入=上一版 plan + 结构化拒绝原因（validator issues 或人工 decline reason），上限 `maxReplans=2`（CampaignPlan v0 里该字段当前恒 0——**M2.2 把它升为契约 v0 的允许值 {0,1,2}，属于 CampaignPlan schema 的向后兼容扩展**：旧计划 0 仍合法） | 若产品要求人工触发逐轮重规划（非自动），改为每轮人工「重新生成」按钮，指标口径不变 |
| A2 | 人工修改距离 = 批准 revision 的 plan_hash 与「首次提交草稿」的字段级 diff 计数（新增/删除/修改的叶子字段数），由 gain-saas 以 plan JSON 结构化对比计算，不做语义相似度 | 若需要语义距离，接 LLM 评估（成本高），先保持结构距离 |
| A3 | Golden brief 以**测试资产**存 backend 仓（evals/golden-campaign-briefs/*.json，含输入 brief + 期望断言：契约合法、必含/禁含字段、预算上限约束）；跑批走 ops API 或 CI 脚本，不落租户数据 | 若 brief 需租户真实数据，脱敏快照进测试资产 |
| A4 | 指标从现有多源现算：审批/轨迹→campaign_decision_trace + campaign 表；成本→cost_ledger/usage_ledger（campaign.plan 的 job 归属）；不建新事实表（物化视图可选，先现算） | 查询变慢再上日聚合表（D-MA-9 的 usage_event 基础设施已在路线） |

## 3. 重规划循环设计

- 循环：`plan(round 0)` → 若 validator 失败或人工 decline 且带结构化意见 → `replan(round n)`，n ≤2 → 任一轮通过 schema+校验即产出草稿；人工 decline 后自动再生成 1 次仍被拒 → job 状态 `NEEDS_HUMAN`（停在列表，人工可直接编辑 plan JSON 另存为新 revision——M2.0 的 revision 机制天然支持）。
- 每轮：独立 usage 记账（meta.round）、独立决策轨迹行（decision_type='campaign.replan'，reason_code=VALIDATOR_ISSUES|HUMAN_DECLINE）、成本累计进 job 汇总；**job 级成本上限**（env，默认 3 轮总成本 ≤ 单轮上限 ×3）。
- 人工 decline 意见会作为重规划输入（截断 500 字）——**只影响生成，不影响审计**（原文落 trace evidence）。

## 4. Golden Set 设计

- 资产：`evals/golden-campaign-briefs/NN-<slug>.json`，字段：`brief`（行业/国家/ICP 摘要/预算上限/输出语言）、`expectations`（requiredFields/forbiddenFields（如不得出现 PI/单证/发送动作）/budgetRespect/decisionPolicy.maxReplans）、`notes`。
- 跑批器：`campaign:golden`（tsx 脚本，直连本地栈或复用金丝雀租户），逐条生成 → 契约校验 + 断言 → 输出通过率与逐条 JSON diff；结果写 `docs/evidence/` 或 CI artifact。
- CI：不阻塞每 PR（模型不稳定），但 **planner 相关路径（skill 包/模型策略/提示词/契约）变更的 PR 必须附一次跑批结果**（由 PR 作者跑，review 检查）；发布层可接 ops 触发（同 S1 的 eval 回执模式，可选）。

## 5. 指标定义（口径钉死）

| 指标 | 定义 | 数据源 |
| --- | --- | --- |
| 审批通过率 | APPROVED / (APPROVED+DECLINED+EXPIRED)（按 workspace×campaign×周） | campaign_approval |
| 每通过计划成本 | job 累计成本 / 通过数（含重规划成本） | usage_ledger(meta.job) + cost_ledger |
| 人工修改距离 | 批准 revision 与首稿的叶子字段 diff 数（0 表示零修改通过） | plan JSON 结构对比 |
| 重规划轮次分布 | 每 job 的 replan round 计数分布（0/1/2/超界） | campaign_decision_trace |
| 回复/会议率（预留） | 计划关联商机的 REPLIED+MEETING_BOOKED / 计划已执行数 | 步 12 归因（暂空） |

展示：ops 归因页新「Campaign」页签（只读，租户不可见）；北极星代理=「每通过计划成本」按周趋势。

## 6. 合规与预算

- 重规划仍走 execution-budget 的 campaign.plan purpose（每轮独立 quote）；job 上限 env 可调；无新增外部动作。
- Golden brief 资产不含租户 PII（行业/国家级描述）。

## 7. 负向测试

1. 超过 maxReplans → 停止并 `NEEDS_HUMAN`，不再调用模型（ai_trace 计数封顶）；
2. 人工 decline 无原因 → 400（拒绝必填理由已有）；重复 decline → 409；
3. golden 跑批断言失败必须红（变异测试：故意改期待字段验证鉴别力）；
4. 指标查询跨租户隔离（ops only）；5. 契约 v0 扩展兼容：旧 maxReplans=0 计划行为不变。

## 8. 施工拆分（批准后）

1. **M2.2-1（backend）**：maxReplans 契约扩展（{0,1,2}）+ 重规划循环活动 + job 成本上限 + 决策轨迹 + 负向 1/4/5；
2. **M2.2-2（测试资产）**：golden brief 10–20 条（先 6 条样板，内容域请产品负责人圈定：建议 德国吸塑包装/美国电子件/德国工业零部件 各 2）+ 跑批器 + 证据模板；
3. **M2.2-3（gain-saas）**：修改距离计算 + 四指标聚合 + ops「Campaign」页签；
4. **M2.2-4（联调）**：golden 首跑基线 + 指标回填 + E2E-M2.2。

## 9. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-M2.2-a | 重规划=同工作流内自动循环，≤2 轮，超界 `NEEDS_HUMAN` | 接受 |
| D-M2.2-b | CampaignPlan v0 向后兼容扩展 `maxReplans ∈ {0,1,2}`（旧 0 行为不变） | 接受 |
| D-M2.2-c | 人工修改距离=结构化叶子字段 diff（不做语义相似度） | 接受 |
| D-M2.2-d | Golden brief 10–20 条，首样板 6 条（德吸塑/美电子/德工业各 2）；资产入仓、跑批手动/证据随 PR | 接受 |
| D-M2.2-e | 指标四件套现算（不建新事实表），ops 归因页「Campaign」页签；回复/会议率留接入口 | 接受 |
| D-M2.2-f | 探索流量 5–10%（记忆层口径）不在 M2.2 启用，留到有真实 outcome 数据后（步 12+） | 接受 |

## 10. 给产品负责人的说明

- **得到什么**：规划器不再是「一次生成碰运气」——它在最多 2 轮内根据校验错误或你的拒绝意见自我修正；计划质量从此有基线（golden brief 跑批）和仪表（通过率/成本/修改距离）；「每通过计划成本」成为经营大脑的第一个北极星代理指标。
- **没改什么**：审批与授权机制不变；不执行任何动作；无新基础设施。
- **风险与回退**：重规划有成本上限与轮次上限双保险；golden 跑批不进 CI 硬门（防模型抖动卡 PR），以证据随 PR 的方式过渡。
- **建议**：批准 D-M2.2-a~f 按推荐值；golden brief 的内容域请圈定（默认按推荐的三组各 2 条起步）。
