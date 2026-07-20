# 互动与商机 Capability Pack

> 文档 ID：`FE-P6-ENGAGE-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_6_REVIEW`
> Capability：`CAP-ENGAGE-001`、`CAP-OPP-001`
> 事实 Owner：`OWN-SAAS-PLATFORM`

## 1. Capability

团队把来自邮件/渠道/未来站点询盘的真实互动聚合到可追溯会话，识别意向、分派责任并推进为单一 Opportunity 生命周期：`CANDIDATE → QGO → SAO → CLOSED`，最终记录结构化商业结果并把学习标签回流。本仓只交付 `LeadQualifiedPackage`，不拥有 Conversation、Opportunity、QGO、SAO 或 Outcome 主状态。

## 2. 用户结果和非目标

用户需要回答：谁回复了、回复对应哪个客户/计划/内容；是否值得跟进；谁负责下一步；为什么成为/未成为 QGO；销售是否接受；最终结果是什么。

本 Pack 不负责：

- 把 QGO、SAO 分裂成三套公司/线索/商机实体；
- 让 Site Inquiry 或渠道 webhook 直接成为 Opportunity SoR；
- 在本仓新增 Inbox/CRM/Opportunity 表；
- 用 AI 情绪或 intent 分数自动替代人工资格与销售接受；
- 决定采用 Chatwoot、CRM 或具体消息 Provider。

## 3. 目标闭环

```text
LeadQualifiedPackage / Reply / Site Inquiry
→ identity and conversation correlation
→ Conversation + Message
→ intent/evidence summary
→ owner + next action + SLA
→ Opportunity CANDIDATE
→ QGO qualification snapshot
→ SAO sales acceptance
→ stage + next action
→ CLOSED + CommercialOutcome verification
→ structured learning labels to source systems
```

关键不变量：原始消息不可被 AI 摘要覆盖；Conversation 和 Opportunity 可以关联但不是同一对象；销售接受必须记录 Owner、阶段、下一步、时间和原因；Outcome 是追加事实，不篡改历史资格快照。

## 4. 页面工作簿

| Page | 首屏与主动作 | 状态/恢复 | 当前事实 |
|---|---|---|---|
| `080` Unified Inbox | 未处理互动、优先级、来源、Owner；分派/进入会话 | disconnected/partial/duplicate/spam/unassigned/SLA breach | `/engagement` Mock；正式 receiver/connector `NONE` |
| `081` 会话详情 | 原始消息、翻译/摘要、相关对象和下一动作；回复/升级 | identity ambiguity/send unknown/permission/PII/opt-out | 正式 Conversation/Message SoR `NONE` |
| `082` Opportunity 列表/看板 | 候选、QGO、SAO、阶段、Owner；接受/分派 | empty/stale/blocked/overdue/permission | `/opportunities` Mock；本仓无 API |
| `083` Opportunity 详情 | 资格 Evidence、触点、Owner、下一步、结果；推进/关闭 | missing evidence/rejected/duplicate/stage conflict/outcome pending | 外部 SaaS ownership；合同未定位 |

## 5. 对象、社会属性和权限

- `OBJ-FE-020` Conversation/Message/Intent 包含受限个人数据；展示、导出、回复、删除和训练用途必须分权。
- `OBJ-FE-021` Opportunity/QGO/SAO 是 Workspace 共享商业对象，但字段可按团队/区域/owner 限制。
- `OBJ-FE-022` CommercialOutcome 商业敏感；验证来源和变更审计不可缺。
- `OBJ-FE-027` Inquiry 的原始接收与 SaaS projection 尚待 ADR；接收成功不等于 Opportunity 已创建。
- AI 只能生成摘要、建议分类/回复草稿；人工/策略决定身份合并、资格、销售接受和对外发送。
- Suppression、opt-out 或 rights hold 优先于回复/序列/自动跟进；UI 无权解禁。

## 6. 失败、恢复和运营兜底

| 情况 | 恢复/兜底 | 禁止行为 |
|---|---|---|
| 渠道断连或 webhook 漏失 | 显示同步窗口/缺口，受控回补和去重 | 把空 Inbox 当没有回复 |
| 身份关联不确定 | 进入待确认，保留原始来源 | 自动贴错 Company/Lead/Opportunity |
| 回复发送 ACK 不明 | 对 provider message key 对账后再允许重试 | 重复发送 |
| 消息含 opt-out/投诉 | 立即 suppression/停止自动动作并留审计 | 继续 AI 建议触达 |
| Opportunity 重复 | 并排 Evidence、Owner 和影响，授权合并/关联 | 按名称静默合并 |
| QGO/SAO 条件缺失 | 显示缺项、负责人和理由 | 只改看板列制造假进展 |
| Outcome 未验证 | 保持 provisional，要求来源/审核 | 把自报成交直接当归因真值 |

## 7. 接缝、指标和限制

当前本仓能产生 `LeadQualified` 事件并提供 events list/ACK；它只能作为 SaaS 创建 `Opportunity CANDIDATE` 的输入。本地 `/engagement`、`/opportunities` 以及 Today 的机会卡均使用 Mock；Site Inquiry receiver 继续 `disabled_until_m2`。

方向指标：首响/分派时间、未处理 SLA、身份关联准确率、QGO→SAO 接受率、Outcome 回写/验证率、重复/漏消息率。反指标：消息数、自动回复率、看板移动次数、无 Evidence 的 QGO、重复发送、opt-out 越权、以 AI 分类替代销售判断。

已知限制：Conversation/Message/Opportunity/Outcome SoR、渠道接入、Inquiry ownership、权限、隐私/保留、SLA、指标事件和实际 Owner 全部未定位。

## 8. Handoff

本 Pack 达到 `MAP_COMPLETE / TARGET_EXTERNAL / NOT_DEV_READY`。未来最小纵切应只选择一个真实入站来源，完成“接收→去重/关联→分派→Opportunity candidate→人工资格→Outcome”闭环；在正式合同和隐私门出现前不制作可执行页面或引入第三方消息系统。

