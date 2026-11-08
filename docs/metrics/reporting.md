# 报告节奏与模板（周报 / 月报）

> 文档 ID：`METRICS-REPORTING-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`GUIDE`
> 生命周期依据：ch01 §3.6.7 的节奏与固定模板；报告由脚本生成、人工补风险段。
> 状态：`GUIDE`

报告的唯一数据来源是 `metric-observation/v1` 快照（`scripts/metrics/metrics-snapshot.mjs` 只读生成）；报告由 `scripts/metrics/report.mjs` 渲染。**禁止手写数字**：未接线的指标显示为「未接线 / 不可测」，不得用 0 或估计值冒充（P4 前 T3/T4 全部如此）。

## 1. 节奏（ch01 §3.6.7）

| 节奏 | 时间 | 内容 | 产出位置 | 负责人 |
| --- | --- | --- | --- | --- |
| 日报（自动，未接线） | 每日 01:00 UTC | metric_observation 聚合 + guardrail（PR-03/04 接线后） | `metric_rollup_daily` | 系统 |
| **周报** | 每周一 02:00 UTC | 北极星、覆盖、可触达、质量门、源 Top/Bottom、风险与下周动作 | `docs/evidence/<YYYY-Www>-weekly/` | 数据工程 + 产品 |
| **月报** | 每月第一个工作日 | 周报全部 + 召回报告（frame/CR）、金标重标、成本对账 | `docs/evidence/<YYYY-MM>-monthly/` | 数据工程 |
| 季度 / 半年 | — | 金标扩样、CR 重跑、竞品复测、外部复核 | 季度证据包 | 产品 + 法务 |

首期「连续两周周报 + 一期月报」（PR-15 验收）依赖快照可用：当前快照已覆盖 T0/T1/T2 的账户侧指标；T3/T4、金标、PSI 显示为未接线。

## 2. 生成命令

```bash
# 1) 只读快照（现有表；可加 --workspace 限定租户）
node scripts/metrics/metrics-snapshot.mjs --out snapshot.json

# 2) 周报（默认 ISO 周标签；--period 可覆盖）
node scripts/metrics/report.mjs --kind weekly --snapshot snapshot.json \
  --out docs/evidence/2026-W46-weekly/report.md --out-json docs/evidence/2026-W46-weekly/report.json

# 3) 月报
node scripts/metrics/report.mjs --kind monthly --snapshot snapshot.json \
  --out docs/evidence/2026-11-monthly/report.md --out-json docs/evidence/2026-11-monthly/report.json
```

样例（由真实快照生成）：[report-samples/2026-11-09-weekly-sample.md](report-samples/2026-11-09-weekly-sample.md)。

## 3. 固定模板

周报（ch01 §3.6.7）：

```text
# GainOS 周报 <YYYY-Www>
1. 北极星：VRIC_1000_STRICT = X（95% CI [a,b]），环比 ±；PLUS = Y
2. 覆盖：recall（若测）= …；domain_resolution_rate = …；fit golden precision/recall = …
3. 可触达：email_valid_rate = …；catch_all = …；phone_fill = …；cost/valid = …
4. 质量门：golden gates（G1–G6）；PSI；失败分类 Top5
5. 源：Top/Bottom 3；新增/停用源
6. 风险与下周动作（人工填写）
```

月报在周报基础上增加：召回报告（frame 抽样或 CR 的 N̂ + CI + 敏感性）、金标重标 30–50 条与 κ、成本对账（供应商账单 vs UsageLedger/CostLedger，差异 >5% 必须解释）。

## 4. 写作纪律

- **口径引用**：每个数字带 `指标 ID + 版本`；报告页脚注明字典版本与数据日期。
- **小样本**：n<30 自动附「样本不足」标记，只报区间与原始计数，不做达标结论（字典 §1.7）。
- **UNKNOWN 显式**：国家/行业等维度缺失以 UNKNOWN 展示，不得静默丢弃（字典 §1.6）。
- **缺失即缺失**：未接线、不可测、缺失观测三种状态分列，不得合并为 0。
- **对外发布**：任何对外版本先经产品负责人确认；竞品与 PII 明细不得进入报告（PR-14 与法务约束）。
- **证据落盘**：周报目录含 `report.md`、`report.json` 与生成用 `snapshot.json`（或快照哈希）；目录按周期命名，不覆盖历史。

## 5. 与后续 PR 的关系

- 引擎 `report/weekly-report.service.ts` 改为调用指标实现（ch01 PR-15 第一条）依赖度量 API（PR-03/04 与 `metric_observation` 表）；本脚本是该接线前的只读模板实现，接线后 CSV 外部形态保持不变（ch01 要求）。
- 源记分卡（PR-06）接线后，第 5 节改由 `source_scorecard_daily` 生成；本脚本的 T1-008/T1-009 只是过渡口径。
