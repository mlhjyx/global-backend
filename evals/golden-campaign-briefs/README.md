# Golden campaign briefs（M2.2-2）

规划器质量回归门。资产为**测试数据**：只含行业/国家级描述，不含任何租户或个人信息（设计
`docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md` §4/§6）。首样板 6 条（德吸塑包装 /
美国电子件 / 德国工业零部件各 2，D-M2.2-d）；后续扩到 10–20 条时按同一 schema 追加。

## 资产格式（`campaign-golden-brief/v1`）

```json
{
  "schemaVersion": "campaign-golden-brief/v1",
  "id": "01-de-thermoforming-medical",
  "brief": {
    "industry": "thermoforming packaging",
    "country": "DE",
    "objective": "……",
    "icpSummary": "……",
    "budgetCapMicros": 150000000,
    "language": "de"
  },
  "expectations": {
    "planSchemaVersion": "campaign-plan/v0",
    "requiredFields": ["goal.objective", "decisionPolicy.maxReplans"],
    "forbiddenFields": ["motions.0.send", "deliveries", "proformaInvoice"],
    "forbiddenContent": ["proforma", "\\binvoice\\b"],
    "budgetRespect": { "capMicrosPath": "budget.capMicros", "currency": "USD" },
    "decisionPolicy": { "maxReplansMax": 2 },
    "motionTypes": ["discovery"]
  },
  "notes": "……"
}
```

字段口径：

- `brief`：规划意图。`budgetCapMicros` 是 USD micros 整数；`language` 是期望的输出语言主标签。
- `expectations.requiredFields`：必须存在（非 `undefined`）的叶子路径；数组用数字下标
  （`motions.0.type`）。
- `expectations.forbiddenFields`：必须不存在的路径——v0 计划不得出现发送动作、投递或单证字段。
- `expectations.forbiddenContent`：把计划整体序列化后不得命中的正则（**大小写不敏感**）；用于「不出现单证/发送语义」这类跨字段红线。
- `expectations.budgetRespect`：计划预算上限（缺省路径 `budget.capMicros`，若存在）必须
  ≤ `brief.budgetCapMicros`；`currency` 必须等于给定币种。
- `expectations.decisionPolicy.maxReplansMax`：`decisionPolicy.maxReplans` 的允许上界
  （M2.2 契约为 `{0,1,2}`，旧计划 0 仍合法，故门限取 2）。
- `expectations.motionTypes`：动作类型白名单（v0 仅 `discovery`）。

## 跑批（`campaign:golden`）

```bash
# 回放模式（零模型）：对目录里 <brief-id>.plan.json 逐条求值；CI 与变异测试用
pnpm campaign:golden --replay <dir> [--baseline <上次结果.json>] [--out <结果.json>] [--format json|markdown]

# 实跑模式（模型）：POST 到规划器端点，需要 M2.1 的规划接口（金丝雀租户/ops 面）
CAMPAIGN_GOLDEN_PLANNER_URL=… [CAMPAIGN_GOLDEN_PLANNER_TOKEN=…] pnpm campaign:golden --live
```

- 输出：通过率 + 逐条检查项；给了 `--baseline` 时附每条的叶子字段 diff（added/removed/changed）。
- 退出码：任一条失败即 1（变异测试依赖它）；资产或运行环境错误也非 0。
- 证据：`--out` 写 JSON（含每条的计划快照，供下次 diff）；`--format markdown` 打印可直接贴进
  `docs/evidence/` 的模板（planner 相关 PR 附一次跑批结果，设计 §4/§8）。
- CI 不把 golden 跑批设成每 PR 硬门（模型抖动），以「planner 路径变更 PR 附跑批证据」过渡。

## 断言层（代码位置）

- `apps/api/src/campaign-golden/golden-brief.ts`：资产 schema 与装载（未知字段拒绝）。
- `apps/api/src/campaign-golden/golden-evaluate.ts`：闭集检查项（schema 版本 / 必含 / 禁含 /
  禁含语义 / 预算 / 决策策略 / 动作类型）。
- `apps/api/src/campaign-golden/golden-diff.ts`：叶子字段结构 diff。
- 变异测试：`apps/api/src/campaign-golden/golden-evaluate.spec.ts`（改坏期望必须判红，
  设计 §7-3）。
