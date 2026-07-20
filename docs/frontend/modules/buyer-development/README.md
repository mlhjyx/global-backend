# 市场与客户开发 Capability Pack

> 文档 ID：`FE-P6-BUYER-000`
> 层级：`L2 / Frozen map-complete capability pack`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_6`
> Capability：`CAP-BUYER-001`、`CAP-INTENT-001`、`CAP-COMP-001`
> 事实 Owner：`OWN-BUYER-BE`

## 1. Capability

海外增长/外贸运营从市场与 ICP 出发，持续得到身份可信、有需求/时机证据、可联系且合规可用的买家公司候选，理解为什么推荐/拒绝，并把人工接受的结果交付为不可变 `LeadQualifiedPackage`。当前后端能力较深，但产品面自 2026-07-13 起冻结新增开发；Phase 6 只补完整产品地图和边界。

## 2. 当前与目标的诚实分层

| 轴 | 当前事实 |
|---|---|
| 产品 | `FROZEN`，保留维护与安全修复；未获恢复指令不得启动新能力 |
| UX | 本地 `/accounts`、`/competitors` 等为 Mock 原型；本 Pack 为地图级工作簿 |
| 前端 | 正式接入 `NONE`；无生成 OpenAPI client、Workspace/权限或部署证据 |
| API/后端 | Company/ICP/query plan/discovery/Lead/qualification/suppression/deletion/events 有导出合同与真实服务证据 |
| 可用性 | 后端维护态；不能声称 SaaS 客户开发页面可用 |

## 3. 用户闭环

```text
市场问题/目标
→ ICP + rules + exclusions
→ backtest / query plan review
→ multi-source discovery
→ identity merge + evidence + signal + contact/reachability
→ deterministic gates + six-dimension qualification
→ recommended / needs_review / rejected / prohibited
→ human accept/reject
→ immutable LeadQualifiedPackage
→ Outbox delivery + SaaS ACK
→ future Opportunity outcome learning label
```

核心原则：错误身份比漏掉更危险；需求证据、身份、可达和合规不能被一个总分遮蔽；不可达的高 Fit 公司不进入推荐；SaaS Opportunity 状态不回写成 Lead 主状态。

## 4. 页面工作簿

| Page | 用户结果与主动作 | 关键状态/失败 | 当前合同/事实 |
|---|---|---|---|
| `060` 市场机会扫描 | 比较候选市场与证据；进入研究/ICP | 证据不足、时效、口径不同、来源失败 | 市场研究产品对象未完整；后端部分来源可复用 |
| `061` 市场研究工作台 | 管理问题、证据、结论和采用动作 | hypothesis/validated/rejected、引用失效 | 目标态；无正式前端/统一 Research SoR |
| `062` ICP 与购买委员会 | 定义条件、排除和角色并回测 | draft/active/stale、规则冲突、回测无样本 | ICP/rules/backtest/query plan API 存在 |
| `063` 客户池/Lead Explorer | 看四队列和推荐理由；筛选/批量复核 | loading/partial/stale/rights hold/provider degraded | Lead queues/list API 存在；前端 Mock |
| `064` 客户/Lead 详情 | 理解身份、Evidence、Signal、联系人、资格和下一步 | identity ambiguity、unreachable、sanctions hold、PII mask | company/lead/detail/decision/contact API 局部存在 |
| `065` 发现/富集任务 | 查看来源、预算、阶段、部分失败和恢复 | provider disabled/rate limit/partial/timeout/cancel/stale | DiscoveryRun/query-plan execution API + Temporal |
| `066` 数据权利与 Suppression | 查看允许用途、禁联、删除和限制 | LIA/notice/retention/DSR/suppression | suppression/deletion API 与 DataRights 后端存在 |

## 5. 对象、SoR 与接缝

- `ICP`、`CanonicalCompany`、`Lead` 和 `LeadQualifiedPackage` 由本仓 Buyer Intelligence 拥有。
- Lead 是 `ICP × Company` 评价，不把某 ICP 的 Fit 写回 Company 全局属性。
- 联系人和 contact point 属受限个人数据；Evidence、用途、保留和遮罩随动作变化。
- 本仓止于不可变 package 和事件交付。Campaign、Conversation、Opportunity/QGO/SAO、Outcome 归 SaaS。
- SaaS ACK 表示消费确认，不表示销售接受；QGO/SAO 由 SaaS Opportunity 生命周期产生。
- Outcome 回流只作结构化学习标签，不能覆写 Company、Lead 或证据历史。

## 6. 权限、失败和人工兜底

| 风险/失败 | 安全体验 |
|---|---|
| 身份歧义或跨源冲突 | 放入待确认，展示候选证据；不自动合并/触达 |
| 单 Provider 失败 | 显示 partial/degraded 和遗漏范围，其余源继续 |
| 联系方式不可验证 | 标 RISKY/UNKNOWN，不谎报 VALID；推荐队列受 Reachability 硬门 |
| 制裁或权利 hold | 禁止 accept/export/交付并显示授权复核路径 |
| 发现任务 ACK 不明 | 使用稳定 run/query plan 身份重查，不重复收费/拉取 |
| 个人数据请求 | 走 suppression/deletion workflow 和回执；页面不保留导出副本 |
| SaaS consumer 未确认 | package 继续在交付账本可追踪；不创建本仓 Opportunity 兜底 |

## 7. 代码与合同证据

当前 OpenAPI 已导出 ICP list/get/update/activate/rules/backtest/query-plan，canonical company list/detail，DiscoveryRun/provider/suppression/contact 操作，Lead list/detail/queues/qualify/accept/reject/sanctions review，deletion request，以及 events list/ack。对应 main 实现在 `apps/api/src/{company,icp,discovery,lead,signals,intent,compliance,events}` 和 Temporal workflows。

该证据只证明本仓后端。`/global/frontend/project-12080666/src/pages/accounts`、`competitors`、`opportunities` 与相关 TopBar 数据来自 Mock，不能与这些 API 合并声称已接入。

## 8. 指标、反指标与已知限制

方向指标：首次可解释推荐时间、身份正确率、Evidence 覆盖/新鲜度、Reachability、人工接受率、package ACK、QGO/SAO/Outcome 回流率。

反指标：名单数量、抓取页数、模型调用次数、无证据高分、不可达推荐、跨 ICP 覆盖 Fit、未经用途授权的联系人可见/导出。

已知限制：获客侧当前冻结；统一市场研究对象、正式 SaaS 前端、consumer ACK/Outcome 闭环的 SaaS 侧证据、跨-sweep 公平性和若干存储合规 follow-up 仍未完全关闭。

## 9. Handoff

本 Pack 达到 `FROZEN_MAP_ONLY / BACKEND_VERIFIED / FRONTEND_NONE`。恢复施工必须由产品负责人明确解除冻结，并重新核验当时 main、正式 SaaS repo/Owner、权限、数据权利、标准 Fixture、真实企业 UAT 和下游消费证据；Phase 6 不触发上述动作。
