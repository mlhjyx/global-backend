# 增长执行 Capability Pack

> 文档 ID：`FE-P6-GROWTH-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_6`
> Capability：`CAP-CAMP-001`、`CAP-CONTENT-001`、`CAP-PUBLISH-001`
> 事实 Owner：`OWN-SAAS-PLATFORM`

## 1. Capability

海外增长团队把一个业务目标转成有固定受众、批准事实、内容版本、渠道授权、预算和结果口径的增长执行计划；在真正对外动作前预览对象/内容/成本/风险，执行后能区分部分成功、失败、回执和恢复。该能力归 SaaS/执行系统，当前只有 Word 与本地 Mock 原型输入，没有正式 SoR、API 或用户可用实现。

## 2. 用户问题与完成定义

| Actor | 问题 | 完成定义 |
|---|---|---|
| 海外增长/外贸运营 | 这次增长行动为谁、说什么、在哪执行、花多少？ | Campaign 固化目标、受众快照、内容、渠道、预算和 Owner |
| 内容负责人/审批人 | 内容是否基于批准事实、适合渠道和市场？ | 版本、Claim refs、差异、风险和决定可审计 |
| Workspace 管理员/商业 Owner | 外部动作是否在套餐、预算和授权范围内？ | execution authorization 明确范围/时间/额度，超界 fail-closed |
| 运营/客服 | 哪部分成功、哪部分失败、能否安全重试？ | 每个 PublishJob/DeliveryReceipt 可定位、去重和恢复 |

成功不是“生成了内容”或“点击了发布”，而是受控动作产生可核验回执，并能进入互动/商机/洞察的下一步。

## 3. 目标闭环与硬边界

```text
Goal
→ GrowthInitiative
→ Campaign draft
→ Audience query snapshot + exclusions
→ Brief / ContentAsset versions + Claim refs
→ channel adaptation
→ Dry Run: recipients/content/channel/cost/risk
→ Approval + immutable ExecutionAuthorization
→ PublishJob / Outbound job
→ per-target DeliveryReceipt
→ Conversation/Touchpoint/Incident
→ Outcome and learning
```

硬边界：

- Campaign 不拥有 Company、Lead、Claim、Credential、Conversation 或 Opportunity 主状态。
- Audience 是带查询、版本、样例和排除条件的快照；不能复制一份失去 provenance 的名单。
- ContentAsset 与 PublishJob 分离；“内容已批准”不等于“允许执行”。
- 对外动作前必须重新检查 suppression、用途、channel health、预算、entitlement 和 authorization。
- 部分成功按目标/渠道记录回执；不能用 Campaign 一个绿色状态覆盖失败对象。
- 本仓不新增 Campaign/发送/触达模块；正式实现必须在 SaaS/执行系统边界完成。

## 4. 页面工作簿

| Page | 用户结果/主动作 | 状态与恢复 | 当前事实 |
|---|---|---|---|
| `070` Goal/Initiative | 定义业务目标、市场、Owner、预算和结果 | draft/active/paused/completed/invalid metric | `/goal` 仅 localStorage 原型 |
| `071` Campaign 列表 | 找到草稿、运行、暂停、异常和已完成计划 | empty/stale/partial/permission/archived | Mock |
| `072` Campaign Canvas | 组织目标、受众、内容、渠道、授权和结果 | dirty/conflict/missing dependency/revision | Mock；正式 SoR `NONE` |
| `073` Audience 快照 | 固定查询、样例、排除、rights 和预计成本 | source stale/suppressed/too broad/empty | Buyer API 可作输入；SaaS snapshot `NONE` |
| `074` Dry Run 与授权 | 预览将对谁做什么、成本和风险 | requires approval/denied/expired/cost changed | Approval/execution auth `NONE` |
| `075` 内容库 | 管理可复用内容、语言、版本、权利和引用 | draft/review/approved/expired/withdrawn | `/content` Mock |
| `076` 内容编辑/审核 | 生成、人工编辑、事实检查、比较和批准 | AI draft/unsupported claim/conflict/stale approval | Site Copy 子集不能替代平台合同 |
| `077` 内容日历 | 看计划时间、依赖和冲突 | timezone/collision/channel unavailable | `/publish` Mock 数据 |
| `078` 发布任务 | 查看逐目标/渠道回执、部分成功和重试 | queued/sent/delivered/failed/unknown/cancelled | 正式执行/回执 `NONE` |
| `079` 渠道账号 | 授权、最小 scope、健康、轮换和移除 | pending/active/expiring/revoked/degraded | `/integrations` Mock；vault/OAuth `NONE` |

## 5. 对象、权限与数据社会属性

- `OBJ-FE-018` Goal/Initiative/Campaign 为 Workspace 共享业务对象，正式 SoR 未定位。
- `OBJ-FE-019` ContentAsset/PublishJob 分离；内容可能是团队草稿、公开候选或已授权版本，权限不同。
- `OBJ-FE-024` CredentialRef 属高敏感控制面；UI 永不读取、存储或回显明文 secret。
- `OBJ-FE-025` Approval 与 ExecutionAuthorization 是不同控制：前者决定内容/方案，后者允许具体外部动作。
- 收件人、联系人、发送/发布记录可能含个人数据，需用途、渠道政策、保留、DSR 和最小可见性。
- Agent/AI 可以提出 Brief、Audience 查询或 Content draft，不能签发批准、外部授权或虚构回执。

## 6. 失败与人工兜底

| 情况 | 用户可见处理 | 安全默认 |
|---|---|---|
| Audience 来源 stale/部分不可用 | 锁定已知快照并展示遗漏，要求刷新/重审 | 不静默扩大范围 |
| 内容含未批准 Claim | 指向 Evidence/审核入口，保留人工编辑 | 不自动发布、不删除警告继续 |
| 授权过期/额度变化 | 重新 Dry Run 和批准差异 | 旧授权不自动延长 |
| 渠道局部失败 | 展示逐渠道/目标回执，安全重试幂等 job | 不整批重发成功目标 |
| 执行 ACK 不明 | 状态 `unknown/confirming`，从 provider receipt 对账 | 不显示失败后直接重发 |
| 外部 Provider 事故 | 暂停新动作，保留内容/计划和导出/退出路径 | 不让单渠道事故损坏 Campaign SoR |

## 7. 当前证据、指标和限制

本地原型存在 `/campaigns` 及 tasks/resources/metrics/stages、`/content`、`/publish` 页面，但源码直接使用 `mockCampaigns`、`mockContentData`、`mockPublishData`；不存在 Campaign/Content/Publish 的当前 OpenAPI operation、正式 OAuth/vault、执行账本或部署证据。

方向指标：从批准 Goal 到首个可核验回执时间、授权前差异发现率、有效回执率、局部失败恢复率、内容 Claim 覆盖、每 Outcome 成本。反指标：发布次数、内容数量、自动化率、无回复触达量、重复发送、投诉/退订、未授权动作、Mock impressions。

已知限制：正式 SoR/repo/Owner、商业套餐、渠道政策、credential vault、suppression 执行接缝、Approval/Authorization、事件/指标/隐私均未关闭。任何具体渠道或 OSS 只按 [Phase 7 Registry](../../../backend/oss-registry.md) 保持 `LEARN/DEFER` 并在产品纵切获批后重开，不由本 Pack 自动采用。

## 8. Handoff

本 Pack 达到 `MAP_COMPLETE / TARGET_EXTERNAL / NOT_DEV_READY`。若未来进入路线图，应先批准最小闭环和渠道（建议单一可控渠道），完成对象/状态/授权/回执合同，再形成独立 Dev-Ready Capability Pack；不得从 Mock 页面直接拆开发任务。
