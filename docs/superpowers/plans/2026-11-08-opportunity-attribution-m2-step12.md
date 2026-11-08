# M2 步 12 · 能力 5 Opportunity/Attribution 归因闭环落地设计（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：按 §0.6 任务启动门产出；产品负责人 2026-11-08 已批准（经主会话打包确认，按推荐值）；依据协调计划 §0.2 步 12（能力 5：Outcome→归因→单位经济；验收=归因与台账一致）、§18.4 P1-6（Golden Set 与在线指标接归因）、§0.7 F1（北极星 cost per positive outcome / pipeline per dollar）、D-MA-9（跨租户驾驶舱先行项：per-run/per-lead 成本归集）。主会话起草（2026-11-08）。
> 前置依赖：步 10（QGO/SAO/Outcome，实施中）提供 Outcome；步 11（投放批次/回复，实施中）提供触达触点；成本侧 usage_ledger/cost_ledger 与 run 归属（1b 已上线）已具备。

## 1. 背景与目标

- 顶层架构的能力序列以「Attribute / Learn」收尾：没有归因，M2.2 的指标只能测「计划质量」，测不了「钱花得值不值」。步 12 把 **Outcome 与成本、触点串成一条可对账的链**。
- 验收硬口径（计划原文）：**归因与台账一致**——归因视图里任一 campaign 的成本合计必须等于 `cost_ledger`/`usage_ledger` 中该 campaign 名下 run 的实账，一分不差（对账测试入库）。

### 目标

1. **单触点直归因 v0**：每个 Outcome → SAO → QGO →（有 campaign 时）campaign/revision/authorization → 执行批次（discovery run / outreach batch）→ 成本与触点，链条全字段可回溯。
2. **单位经济**：cost per positive outcome、pipeline per dollar（positive 定义见 D-12-c）、按 campaign/渠道/周维度。
3. ops 归因页新增「Attribution」页签：漏斗（花费→计划→商机→positive outcome）+ 逐 campaign 明细；数据与台账一致性徽标。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | v0 只做**直归因**（outcome 链上的 campaign 拿全额），不做多触点权重（线性/时间衰减）；链上无 campaign 的 outcome 记 `ORGANIC/UNKNOWN` 但不计入 campaign 北极星分母 | 多触点权重留到有足够样本后（步 12.1+），指标口径先直归因 |
| A2 | 归因**不建新事实表**：SQL 视图现算（数据量级：万级 outcome/run）；慢则升级物化视图，不改口径 | 直接上物化视图也兼容（视图→matview 同定义） |
| A3 | 成本归集口径：campaign 成本 = 其 authorization 放行的执行批次关联的 run 的 `cost_ledger` 合计 + `campaign.plan` 的 usage_ledger 合计（计划成本也算 campaign 成本，单列展示）。**引擎实测形状（2026-11-08，global_dev）**：`meta.task='campaign.plan'`，campaignId 取自 `meta.runId='campaign.plan:campaign:<campaignId>:<hash>'` 的第三段（不存在 `job`/`campaignId` 键；对账服务按此归集，旧假设会静默归零成假绿） | 若产品只算执行成本，视图加列过滤即可 |
| A4 | positive outcome 定义：`MEETING_BOOKED | QUOTE_SENT | WON` 计入北极星；`REPLIED` 记弱信号单列；`LOST/NO_RESPONSE/DISQUALIFIED` 计入分母健全性指标 | 定义可配置（env 列表） |

## 3. 数据链（全部引用既有对象，不复制真相）

```
outcome(步10) → sao → qgo → campaign_id?(步10 允许空)
campaign → revision → authorization(ExecutionAuthorization) → 执行引用(discovery run id / outreach batch id)
costs: cost_ledger(run) ∪ usage_ledger(campaign.plan：meta.task='campaign.plan'，campaignId 取 meta.runId 第三段 / outreach send 成本)
touch: outreach_send/reply(步11), run(步1–9), 审批轨迹(M2.0/轨迹表)
```

- **视图 `v_campaign_attribution`（gain-saas）**：campaign 一行：spend_total_microusd、plan_cost_microusd、exec_cost_microusd、qgo_count、sao_count、positive_count、reply_count、cost_per_positive、pipeline_per_dollar（成交额由 outcome 的数值字段或关联订单——v0 无订单域，pipeline 用「QUOTE_SENT 报价额（可选字段）」或留空占位）。
- **视图 `v_outcome_chain`**：outcome 一行：完整链 id 集 + 归因类型（CAMPAIGN | ORGANIC | UNKNOWN）+ 链成本快照。

## 4. 对账（验收核心）

- 一致性测试（真库）：对每个 campaign，`v_campaign_attribution.exec_cost_microusd == Σ cost_ledger.amount_micros WHERE source_event_id ∈ 该 campaign 授权的 run 集`；计划成本同理对 usage_ledger。**每次发布列车前跑一次对账脚本**（ops 只读），不一致即红。
- 归因页显示「台账对账 ✓ / 差异 N µUSD」（差异>0 时给出明细链接）。

## 5. 事件与触发

- Outcome 事件（步 10 已有 `outcome` 创建/更新）→ 触发视图无需增量（现算）；若上物化视图，用 outbox 事件刷新。
- 不做新的对外事件管道（v0）。

## 6. 权限与合规

- 归因页仅 ops（跨租户聚合与明细）；k 值抑制沿用 D-MA-9 口径（对外聚合 k≥5–10，本页为内部驾驶舱，不做对外输出）。
- 视图不含个人数据（联系人只在链 id 引用层，不出姓名/邮箱）。

## 7. 负向测试

1. 对账测试即核心负向（人为改账 → 红）；2. outcome 链断（QGO 无 campaign / sao 缺失）→ 落 ORGANIC/UNKNOWN，不崩、不计入 campaign 分母；3. 同一 outcome 重复消费（事件重放）→ 视图幂等（现算天然幂等）；4. 跨租户访问 ops 端点仅运营身份；5. positive 定义改动 → 指标口径版本号随读（env 变更留痕）。

## 8. 施工拆分（批准后）

1. **12-1（gain-saas 视图+对账）**：两视图 + 对账脚本（ops 只读端点或 tsx 脚本）+ 对账测试（真库套件）；
2. **12-2（ops UI）**：「Attribution」页签（漏斗+逐 campaign 表+对账徽标）；
3. **12-3（联调）**：用步 10/11 的测试数据走通 商机→发送→回复→outcome→归因；北极星两指标出数。

## 9. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-12-a | 归因 v0=单触点直归因；无 campaign 的 outcome 记 ORGANIC/UNKNOWN 不计入 campaign 分母 | 接受 |
| D-12-b | 不建事实表，SQL 视图现算（慢再升物化视图，口径不变） | 接受 |
| D-12-c | positive outcome = MEETING_BOOKED/QUOTE_SENT/WON（REPLIED 单列弱信号） | 接受 |
| D-12-d | campaign 成本=计划成本（job usage_ledger）+执行成本（run cost_ledger）分列展示，合计参与 cost_per_positive | 接受 |
| D-12-e | 对账脚本进发布前检查（ops 只读），归因页带对账徽标 | 接受 |

## 10. 给产品负责人的说明

- **得到什么**：每一分钱花在哪个战役、换回了几个会议/报价/赢单——北极星「每正结果成本 / 每美元管道」真实出数，且与账本逐分对账。归因页是经营大脑从「看见过程」到「看见价值」的最后一块。
- **没改什么**：不建新事实表、不加对外输出、不动账本；多触点权重模型留到样本充足后。
- **风险与回退**：视图现算可随时改口径；对账失败即暴露问题而非掩盖。
- **建议**：批准 D-12-a~e 按推荐值。实施将在步 10/11 首版落地后启动（12-1 视图可先行，不依赖 UI）。
