# 跨域接缝、下一动作与缺口登记

> 文档 ID：`BASE-FE-P6-002`
> 状态：`READY_FOR_GATE_6_REVIEW`
> Owner：`OWN-PRODUCT`；机器合同分别由对象/平台 Owner 负责

## 1. 接缝原则

每个域的结果必须明确“下一动作”，但下一动作通过对象引用、不可变快照、事件或受权命令跨域，不通过复制状态、共享 UI 内存或聊天摘要跨域。生产者拥有事实，消费者保存引用/投影/回执；ACK、批准、执行和商业结果不是同一个状态。

## 2. 十条承重接缝

| Handoff ID | Producer → Consumer | 最小交付内容 | 当前事实 | 安全失败/兜底 |
|---|---|---|---|---|
| `HOF-FE-001` | SaaS Identity → 所有后端/前端 | token、workspace/user/roles claims、session context | 本仓 JWKS 验签；正式 SaaS 合同未定位 | 无有效 context 不读取/执行；不由前端补 role |
| `HOF-FE-002` | Workspace control → Shell/业务域 | capability、entitlement、object/data scope、allowed actions | `BLK-FE-003` | 未知 fail-closed；可保留安全只读对象 |
| `HOF-FE-003` | Enterprise truth → Site/Content/Campaign | Company/Offering refs、approved Claim/Evidence、Asset/rights、版本/有效期 | Site 内部 snapshot 局部 as-built；平台合同缺 | 不复制/猜事实；缺审核则阻塞或运营 SOP |
| `HOF-FE-004` | Buyer Intelligence → SaaS Opportunity | immutable LeadQualifiedPackage、event envelope、delivery id | 本仓 event list/ACK as-built；consumer 未定位 | durable redelivery；本仓不创建 Opportunity 兜底 |
| `HOF-FE-005` | SaaS Outcome → Buyer/Learning | package/opportunity correlation、结构化结果/拒绝原因、verified source | target only | 只作学习标签；不覆盖 Lead/Company 主状态 |
| `HOF-FE-006` | Buyer/Truth → Growth Execution | Audience query snapshot、exclusions/rights、Claim refs | target only | 来源 stale/rights hold 时重新 Dry Run，不静默扩名单 |
| `HOF-FE-007` | Growth Execution → Engagement/Insights | PublishJob/target/channel、provider receipt、Touchpoint/Incident | target only | 逐目标幂等对账；ACK unknown 不重发成功对象 |
| `HOF-FE-008` | Site public output → Engagement | Inquiry receipt、consent、anti-abuse、dedupe、SaaS projection | receiver disabled；`BLK-FE-007` | 不收/不投递时显式禁用；不能由表单 UI 假成功 |
| `HOF-FE-009` | 各业务域 → Shell | Task/Approval/Notification/Incident projection + canonical link | Site 局部对象可深链；统一读模型 `NONE` | 聚合失败不阻断 canonical page；stale 明示 |
| `HOF-FE-010` | 各业务域/ledger → Insights/Billing | versioned metrics、watermark、reported/calculated/estimated/unknown cost | Site cost 子集；平台 read model `NONE` | 不可用/未知保持原义，不补 0/假精确 |

## 3. 域间责任断点

```text
Identity authn != Workspace authz
Claim approval != execution authorization
Content approved != publish allowed
Publish accepted != delivered
Reply received != Opportunity qualified
QGO qualified != SAO accepted
Outcome reported != outcome verified
Build succeeded != Release active != Preview != Published
Metric rendered != metric trustworthy
```

任何 UI 若把上述左右两侧合并为一个按钮或状态，必须在设计/合同评审中阻塞。

## 4. Phase 6 缺口登记

| Gap ID | 缺失事实/输入 | 影响域 | 当前归因 | 安全默认 / 下一 Gate |
|---|---|---|---|---|
| `GAP-FE-P6-001` | 正式 SaaS repo、运行时、CI/deploy、实际前端 Owner | 全部 | `BLK-FE-001` | stack-neutral；不实现 |
| `GAP-FE-P6-002` | Workspace capability/entitlement/allowed-actions 与有效权限合同 | Shell/所有域 | `BLK-FE-003` | 未知动作 fail-closed |
| `GAP-FE-P6-003` | Task/Approval/Notification/Incident/Search 跨域读模型与深链事件 | Shell/所有域 | `OWN-SAAS-PLATFORM` 未定位 | 各域 canonical page 保持唯一；不造万能写模型 |
| `GAP-FE-P6-004` | 全平台 Company/Offering/Knowledge/Asset 与 Claim review/impact 合同 | 企业事实/Site/Growth | `BLK-FE-004` + 对象合同缺 | 不复制事实；Site 审核显式阻塞 |
| `GAP-FE-P6-005` | SaaS 对 LeadQualifiedPackage 的 consumer、ACK→Opportunity 和 Outcome 回流合同 | Buyer/Opportunity/Insight | SaaS external-owned | 后端停在 package；不声称业务闭环 |
| `GAP-FE-P6-006` | Goal/Campaign/Audience/Content/Publish/Receipt 的正式 SoR、状态机与合同 | Growth | SaaS external-owned | 页面保持 target；不接 Mock |
| `GAP-FE-P6-007` | Conversation/Message/Opportunity/Outcome/Inquiry projection 的 SoR、隐私和合同 | Engagement/Site | SaaS external-owned + `BLK-FE-007` | 不接收入站/不建本仓商机 |
| `GAP-FE-P6-008` | Metric/event registry、read model、baseline/target、privacy/retention | Insight/全部 | `BLK-FE-005` | 不引 tracking SDK，不用 Mock KPI |
| `GAP-FE-P6-009` | Membership/delegation、Integration/vault、Billing/entitlement、运营授权模型 | Control plane | `BLK-FE-003/006` | 旧 Spring/Admin 不作真值；最小权限 |
| `GAP-FE-P6-010` | 实际产品/设计/前端/后端/QA/Ops/Privacy/Security/Commercial assignee 与一手用户验证 | 全部 | `BLK-FE-002/006` | 责任帽子保持 `UNASSIGNED`；AI 不代签 |
| `GAP-FE-P6-011` | 渠道/消息/知识/编辑/可观测 OSS 与权利、安全、退出决定 | Growth/Engagement/Control/Site | Phase 7 | 仅候选，不引依赖 |
| `GAP-FE-P6-012` | 历史 Word/原型/v3.1/v3.2 的 banner/archive 与自动防漂移 | 文档治理 | Phase 8 | 保留原位和 provenance |

这些 Gap 不是新的产品承诺，也不替代 `BLK-FE-001..007`。它们把跨域缺口定位到将来负责的 Capability Gate；若 Gap 需要新架构/产品裁决，必须产生 PDR/ADR/contract，而不是直接从本表实施。

## 5. 对当前优先级的影响

- `GAP-FE-P6-001/002/004/010` 与首个 Site 前端纵切直接相关，应在正式施工授权前优先取得输入。
- `GAP-FE-P6-003` 可随第一个真实跨域 Today/Task 场景最小化，不需先建全平台总线。
- `GAP-FE-P6-005` 属冻结 Buyer 的外部消费闭环；保持地图和现有交付稳定，不恢复新增开发。
- `GAP-FE-P6-006..009` 不进入 Site 当前纵切；未来必须各自选择最小端到端结果。
- `GAP-FE-P6-011/012` 分别留给 Phase 7/8，不在 Phase 6 偷跑。

