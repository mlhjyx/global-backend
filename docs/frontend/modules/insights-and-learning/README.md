# 洞察与学习 Capability Pack

> 文档 ID：`FE-P6-INSIGHT-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_6`
> Capability：`CAP-INSIGHT-001`
> 事实 Owner：`OWN-SAAS-PLATFORM`

## 1. Capability

产品、增长和商业负责人从同一口径理解机会质量、执行结果、成本、失败和下一轮验证，能够从聚合指标下钻到真实对象、事件和 Evidence。洞察页消费版本化读模型，不拥有 Lead、Campaign、Conversation、Opportunity、Outcome 或账本主状态。

## 2. 用户结果与原则

用户需要回答：发生了什么；数字口径和时间窗是什么；哪些结果确定、估算或未知；为什么变化；能否下钻到对象；下一步应验证什么；数据缺口是否足以阻止结论。

原则：

- 任何指标显示定义、分母、时间窗、时区、过滤、数据新鲜度和权限范围。
- `reported / calculated / estimated / unknown / not incurred` 不合并成一个精确成本。
- 洞察建议引用对象和 Evidence；AI 叙述不创造新事实。
- Attribution 必须显示模型、不确定性和未归因量；没有成熟样本时保持描述性统计。
- Dashboard 空、0、无权、数据延迟、源失败和“不适用”是不同状态。

## 3. 页面工作簿

| Page | 用户结果/主动作 | 必须覆盖 | 当前事实 |
|---|---|---|---|
| `084` 经营洞察 | 看 QGO/SAO/Outcome、质量、漏斗和异常；下钻对象 | metric version、filter、freshness、partial、no data、denied | `/insights` 全部使用 Mock |
| `085` 归因与实验 | 看触点、假设、分组、结果和下一轮验证 | attribution model、confidence、sample、guardrail、inconclusive | 正式 Attribution/Experiment SoR `NONE` |
| `086` 成本与用量 | 看能力/Workspace/对象的预算、真实/估算/未知成本 | reserved/settled/unknown/corrected/quota/entitlement | Site Build cost summary 子集存在；平台账本 `NONE` |

## 4. 数据与对象边界

- `OBJ-FE-023` Touchpoint/Attribution/Recommendation 是平台读模型/分析对象；不反写业务对象主状态。
- `OBJ-FE-016` SiteBuildBudget/Spend 是 Site 局部成本事实，可被平台聚合但不能被 UI 重算覆盖。
- Lead score、signals、package delivery、Campaign receipts、Conversation、Opportunity 和 Outcome 的 owner 保持各域不变。
- 聚合必须带 Workspace、用户 data scope、metric schema/version 和 source watermark；不同权限用户的分母可能不同，UI 应解释。
- 运营原始 trace、provider payload、PII 和 secret 不因“洞察”名义扩大可见范围。

## 5. 失败、恢复和人工判断

| 情况 | 用户可见处理 |
|---|---|
| 数据源延迟/局部失败 | 显示最后完整窗口、受影响指标和不可用下钻；不自动补 0 |
| 口径变更 | 并列版本/断点说明；禁止把不兼容时间序列直接连线 |
| 成本 unknown | 保持未知和预算保守扣款；后续 reconcile 产生更正记录 |
| 样本不足 | 标 `insufficient/inconclusive`，提供增加样本或延长窗口建议 |
| Attribution 无法解析 | 显示未归因量和模型限制，不强行分摊 |
| AI 建议无 Evidence | 降为 hypothesis，不能触发自动执行 |

## 6. 指标、反指标和当前限制

方向指标本身也需要治理：口径可追溯率、下钻成功率、数据新鲜度、未知成本收敛时间、决策后验证完成率、指标变更可解释率。

反指标：页面访问量、图表数量、AI 建议数量、把估算当实际、只展示正向结果、用全局平均掩盖分段失败、在小样本上做强归因。

当前 OpenAPI 没有平台 Insights/Attribution/Usage 读模型。Site `site-builder-cost-summary/v1` 只覆盖构建任务；Buyer Intelligence 有评分和事件事实，但没有统一 SaaS 指标层。`BLK-FE-005/006` 阻止 schema、baseline、target、privacy、retention 和 Release 学习签发。

## 7. Handoff

本 Pack 达到 `MAP_COMPLETE / TARGET_EXTERNAL / NOT_DEV_READY`。后续先建 metric registry、事件/读模型 ownership、隐私与数据质量门，再从一个可下钻的真实结果漏斗起步；不得以现有 Mock 图表反向定义数据模型。
