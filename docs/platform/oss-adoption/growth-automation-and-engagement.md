# 增长、自动化与互动候选 Capability Cards

> 文档 ID：`OSS-FE-003`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 产品状态前提：Growth/Engagement 均为 `TARGET_EXTERNAL / NOT_DEV_READY`

## `ADP-FE-009` AiToEarn

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 学习多渠道内容准备、发布 Adapter 和回执组织；不恢复尚未批准的自动发布范围 |
| 当前等价与证据 | Word 候选；main 无接入，Campaign/Publish SoR 归外部 SaaS |
| 主决策 | `LEARN / NO_RUNTIME`；运行时 `DEFER` |
| License / 权利 | Phase 1 精确快照根许可证 MIT；逐渠道 SDK、API、内容、账号和平台政策不由 MIT 覆盖 |
| Adapter / SoR | 只学习 `PublishProvider` 分层；未来必须由 SaaS `PublishJob`/receipt/outbox 承重，不能复用其内部表 |
| Security / 数据 | credential vault、最小 scope、渠道 ToS、个人数据、频率/反滥用、suppression、人工批准和账号封禁 |
| Test / Release Gate | 每渠道 sandbox/真实受控账号、幂等、部分成功、撤销、限流、ACK unknown、credential rotation、删除/导出 |
| Owner / Exit | `OWN-GROWTH-PRODUCT`；无需退出运行时；若未来重开，任何 Adapter 都可替换且保留我方 PublishJob/receipt |

## `ADP-FE-010` Activepieces

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选集成自动化/连接器编排；不成为 Campaign/Opportunity 主状态、权限系统或核心工作流引擎 |
| 当前等价与证据 | 未采用；当前确定性长任务使用 Temporal；SaaS 集成对象和 vault 未建 |
| 主决策 | `DEFER / COMMERCIAL_EMBED_AND_SOR_GATE` |
| License / 权利 | 核心 MIT，`ee`/企业能力商业许可；官方嵌入能力为付费版本，不能按“开源免费嵌入”估算 |
| Adapter / SoR | 若重开，仅作为 `AutomationExecutor`，我方保存 recipe version、授权引用、job/receipt；不 iframe 管理台冒充产品 |
| Security / 数据 | 多租户隔离、JWT provisioning、connection secret/vault、piece 供应链、任意代码/网络、webhook、数据出境和审计 |
| Test / Release Gate | 先完成 `CAP-INTEG-001` Dev-Ready；能力/套餐探测、恶意 piece、scope、串租户、重放、取消、升级、导出/删除、断供 |
| Owner / Exit | `OWN-PLATFORM`；导出我方 recipe/connection metadata，替换执行器，凭据重新授权而非导出明文；embedding/商业条款另过强制 Gate |

重开条件：存在已批准的最小集成纵切，连接器数量/维护成本已证明自建不经济，且商业报价、嵌入权、数据处理和退出 API 可接受。

## `ADP-FE-011` Chatwoot

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 学习统一收件箱、分配、SLA 和对话恢复；不把 Chatwoot 联系人/Conversation 当我方 Opportunity/Company SoR |
| 当前等价与证据 | 本地只有 Mock Engagement 页面；本仓止于 LeadQualifiedPackage，无收件箱/渠道接入 |
| 主决策 | `LEARN / NO_RUNTIME`；运行时 `DEFER` |
| License / 权利 | 核心 MIT，`enterprise/` 目录另许可；渠道/WhatsApp/邮件服务条款和模板政策另行适用 |
| Adapter / SoR | 若重开，通过 `ConversationProvider`/webhook ACL 投影消息引用和 receipt；SaaS 保持 Contact/Conversation/Opportunity 主状态 |
| Security / 数据 | 个人数据、消息内容、附件、跨境、保留/DSR、渠道 secret、webhook 签名/重放、agent impersonation 与审计 |
| Test / Release Gate | 先有 Conversation/Message/Opportunity Contract；测 webhook 幂等、乱序、删除、附件恶意内容、权限、SLA、渠道断连和导出 |
| Owner / Exit | `OWN-CONVERSATION-PRODUCT`；导出对话/附件/映射，撤销渠道 token，重放进入替代 provider，保留删除回执；隐私评审为强制 Gate |

## 组合决定

三个项目都不能在 Growth/Engagement 仍为 `NOT_DEV_READY` 时提前部署。Phase 7 只批准方法吸收和重开条件；不批准渠道、账号、自动发送、嵌入 UI 或新的业务数据库。
